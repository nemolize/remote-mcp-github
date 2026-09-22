import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { decodeBase64 } from "../github/helpers.js";
import { errorResult, logWrite, text, wrapTool } from "../mcp/response.js";
import { isHttpStatus } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";

// Measured: uploads.github.com 422s every other extension, archives and
// documents included. A Map because a plain index resolves prototype keys.
const CONTENT_TYPES = new Map([
	["png", "image/png"],
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["gif", "image/gif"],
	["webp", "image/webp"],
	["svg", "image/svg+xml"],
	["mp4", "video/mp4"],
	["mov", "video/quicktime"],
	["webm", "video/webm"],
]);

const SUPPORTED_EXTENSIONS = [...CONTENT_TYPES.keys()];

// An unescaped `]` closes the alt text early, so the image silently renders as
// plain text in whatever issue body the caller pastes it into.
const escapeAltText = (name: string): string => name.replace(/[[\]\\]/g, "\\$&");

// A filename containing a backtick would close a single-backtick span early;
// CommonMark lets a longer fence carry it, as long as the body has no run that long.
const inlineCode = (name: string): string => {
	const longestRun = [...name.matchAll(/`+/g)].reduce((m, [run]) => Math.max(m, run.length), 0);
	const fence = "`".repeat(longestRun + 1);
	const pad = name.startsWith("`") || name.endsWith("`") ? " " : "";
	return `${fence}${pad}${name}${pad}${fence}`;
};

const contentTypeFor = (filename: string): string | undefined =>
	CONTENT_TYPES.get(filename.split(".").pop()?.toLowerCase() ?? "");

// GitHub's own ceilings (10 MB images / 100 MB video) are unreachable here: the
// transport 413s on a declared content-length above this before the tool runs.
const MAX_MCP_MESSAGE_BYTES = 4 * 1024 * 1024;
// Margin leaves room for the JSON-RPC envelope around the base64 payload.
export const MAX_BASE64_LENGTH = MAX_MCP_MESSAGE_BYTES - 64 * 1024;
// Whole base64 quanta: 4 chars carry 3 bytes, so any other rounding can state a
// size whose padded encoding overflows the char cap above.
const MAX_ATTACHMENT_BYTES = Math.floor(MAX_BASE64_LENGTH / 4) * 3;

export const registerAttachmentTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"upload_attachment",
		{
			description: `Upload an image or video and return a \`user-attachments\` URL to embed in issue / PR / comment Markdown. Use when the user asks to attach a screenshot, diagram, or screen recording. Supports ${SUPPORTED_EXTENSIONS.join(", ")} only — GitHub rejects every other type, including archives (.zip, .tar.gz) and documents (.pdf, .txt); link to a committed file or a release asset for those. Uploading does not attach: embed the returned URL yourself via \`add_comment\`, \`create_issue\`, or \`update_issue\`. Requires repository write access. **An upload cannot be undone — GitHub exposes no delete endpoint.**`,
			inputSchema: {
				...RepoTarget,
				filename: z
					.string()
					.min(1)
					.describe(
						`File name including extension, which selects the upload type (e.g. 'login-error.png'). Supported: ${SUPPORTED_EXTENSIONS.join(", ")}.`,
					),
				content_base64: z
					.string()
					.min(1)
					.max(
						MAX_BASE64_LENGTH,
						`content_base64 exceeds the ${MAX_BASE64_LENGTH}-character limit (${MAX_ATTACHMENT_BYTES} bytes of file data).`,
					)
					.describe(
						`File bytes, base64-encoded, up to ${MAX_ATTACHMENT_BYTES} bytes of file data — derived from this server's transport limit, well below GitHub's own 10 MB image / 100 MB video ceilings.`,
					),
			},
		},
		async ({ owner, repo, filename, content_base64 }) =>
			wrapTool(async () => {
				const contentType = contentTypeFor(filename);
				if (contentType == null) {
					return errorResult(
						`${inlineCode(filename)} is not a supported attachment type. GitHub accepts only: ${SUPPORTED_EXTENSIONS.join(", ")}. Archives and documents are rejected by the API; commit the file to a branch or attach it to a release instead.`,
					);
				}

				let bytes: Uint8Array;
				try {
					bytes = decodeBase64(content_base64);
				} catch {
					return errorResult("`content_base64` is not valid base64.");
				}

				// An empty asset uploads happily and renders broken, and cannot be deleted.
				if (bytes.byteLength === 0) {
					return errorResult("`content_base64` decodes to 0 bytes; nothing to upload.");
				}
				// Load-bearing whenever the char cap is not a whole base64 quantum: an
				// unpadded encoding of one byte more then fits it, and `atob` accepts that.
				if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
					return errorResult(
						`${inlineCode(filename)} is ${bytes.byteLength} bytes, over this server's ${MAX_ATTACHMENT_BYTES}-byte transport limit.`,
					);
				}

				const isVideo = contentType.startsWith("video/");

				const { data: repoData } = await client().rest.repos.get({ owner, repo });

				// Undocumented endpoint on uploads.<host> with no typed Octokit method,
				// reached the same way `gh --attach` reaches it.
				const url = new URL("https://uploads.github.com/user-attachments/assets");
				url.searchParams.set("name", filename);
				url.searchParams.set("content_type", contentType);
				url.searchParams.set("repository_id", String(repoData.id));

				let response;
				try {
					response = await client().request({
						method: "POST",
						url: url.toString(),
						headers: { "content-type": "application/octet-stream" },
						data: bytes,
					});
				} catch (error) {
					// The repo read above already succeeded, so a 404 here is the upload
					// endpoint's way of saying the token cannot write — it never sends 403.
					if (isHttpStatus(error, 404)) {
						return errorResult(
							`Uploading to ${owner}/${repo} requires write access; GitHub answers 404 rather than 403 when the token lacks it. (This undocumented endpoint also 404s if it has moved or changed.)`,
						);
					}
					throw error;
				}

				const assetUrl: unknown = response.data?.url;
				if (typeof assetUrl !== "string" || assetUrl.length === 0) {
					return errorResult("Upload succeeded but GitHub returned no asset URL.");
				}

				logWrite({
					tool: "upload_attachment",
					owner,
					repo,
					filename,
					byte_count: bytes.byteLength,
				});

				const embed = isVideo ? assetUrl : `![${escapeAltText(filename)}](${assetUrl})`;
				return text(
					[
						`# Attachment uploaded`,
						"",
						`- ${inlineCode(filename)} (${contentType}, ${bytes.byteLength} bytes)`,
						`- ${assetUrl}`,
						"",
						"## Embed",
						"",
						"Not attached to anything yet — put this in an issue / PR / comment body:",
						"",
						"```markdown",
						embed,
						"```",
						"",
						isVideo
							? "> Video renders as a player when the URL sits alone in its own paragraph."
							: "> Replace the alt text with a description of the image.",
					].join("\n"),
				);
			}),
	);
};
