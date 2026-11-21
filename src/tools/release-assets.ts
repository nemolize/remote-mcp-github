import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { decodeBase64 } from "../github/helpers.js";
import {
	errorResult,
	logRateLimit,
	logWrite,
	restListHeader,
	text,
	truncate,
	wrapTool,
} from "../mcp/response.js";
import { isHttpStatus, stripUndefined } from "../utils.js";
import { MAX_ATTACHMENT_BYTES, MAX_BASE64_LENGTH } from "./attachments.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";

// No documented GitHub limit; chosen empirically.
const MAX_ASSET_NAME_LENGTH = 255;
const MAX_ASSET_LABEL_LENGTH = 255;

const FALLBACK_CONTENT_TYPE = "application/octet-stream";
const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/;

const CONTENT_TYPES = new Map([
	["zip", "application/zip"],
	["gz", "application/gzip"],
	["tgz", "application/gzip"],
	["tar", "application/x-tar"],
	["json", "application/json"],
	["txt", "text/plain"],
	["md", "text/markdown"],
	["pdf", "application/pdf"],
	["png", "image/png"],
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["svg", "image/svg+xml"],
	["sha256", "text/plain"],
]);

const contentTypeFor = (name: string): string =>
	CONTENT_TYPES.get(name.split(".").pop()?.toLowerCase() ?? "") ?? FALLBACK_CONTENT_TYPE;

const isObject = (value: unknown): value is object => typeof value === "object" && value != null;

const prop = (value: unknown, key: string): unknown =>
	isObject(value) && key in value ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;

const hasAlreadyExistsError = (error: unknown): boolean => {
	if (!isHttpStatus(error, 422)) return false;
	const errors = prop(prop(error, "response"), "data");
	const list = prop(errors, "errors");
	return Array.isArray(list) && list.some((e: unknown) => prop(e, "code") === "already_exists");
};

export const registerReleaseAssetTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"list_release_assets",
		{
			description:
				"List the assets attached to a release (one line per asset: ID, name, size, content type, state, download count). Use when the user asks what files a release ships, or to find an `asset_id` for `download_release_asset`. Get `release_id` from `list_releases` or `get_release`. An asset in state `starter` is an interrupted upload that never completed.",
			inputSchema: {
				...RepoTarget,
				release_id: z
					.number()
					.int()
					.positive()
					.describe("Release ID (from `list_releases` / `get_release`), not the asset ID."),
				per_page: z.number().int().min(1).max(100).optional().default(30),
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number (1-indexed). Defaults to 1."),
			},
		},
		async ({ owner, repo, release_id, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.listReleaseAssets(
					stripUndefined({ owner, repo, release_id, per_page, page }),
				);
				logRateLimit(headers);
				if (data.length === 0) {
					return text(page != null && page > 1 ? "(no assets on this page)" : "(no assets found)");
				}
				const lines = data.map(
					(a) =>
						`- \`${a.id}\` **${a.name}** — ${a.size} bytes, ${a.content_type}, ${a.state}, ${a.download_count} downloads`,
				);
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: `Assets of release ${release_id}`,
					count: data.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"upload_release_asset",
		{
			description: `Attach a file to an existing release (\`gh release upload\`). Use when the user asks to publish a build artifact, archive or checksum on a release; create the release first with \`create_release\` (a draft works) and pass its \`release_id\`. The file is passed as base64, up to ${MAX_ATTACHMENT_BYTES} bytes of file data — this server's transport limit, far below GitHub's own per-asset limit. A name that already exists on the release is rejected (422); this tool never overwrites or deletes. Requires repository write access. On a 502 an incomplete \`starter\` asset may remain — check \`list_release_assets\`.`,
			inputSchema: {
				...RepoTarget,
				release_id: z
					.number()
					.int()
					.positive()
					.describe("Release ID to attach to (from `list_releases` / `create_release`)."),
				name: z
					.string()
					.min(1)
					.max(MAX_ASSET_NAME_LENGTH)
					.describe("Asset file name including extension (e.g. 'app-v1.2.0.zip')."),
				content_base64: z
					.string()
					.min(1)
					.max(
						MAX_BASE64_LENGTH,
						`content_base64 exceeds the ${MAX_BASE64_LENGTH}-character limit (${MAX_ATTACHMENT_BYTES} bytes of file data).`,
					)
					.describe(
						`File bytes, base64-encoded, up to ${MAX_ATTACHMENT_BYTES} bytes of file data.`,
					),
				label: z
					.string()
					.min(1)
					.max(MAX_ASSET_LABEL_LENGTH)
					.optional()
					.describe("Optional display label shown instead of the file name on GitHub."),
				content_type: z
					.string()
					.regex(CONTENT_TYPE_PATTERN, "content_type must look like 'type/subtype'.")
					.optional()
					.describe(
						`MIME type. Defaults to a guess from the file extension, else ${FALLBACK_CONTENT_TYPE}.`,
					),
			},
		},
		async ({ owner, repo, release_id, name, content_base64, label, content_type }) =>
			wrapTool(async () => {
				let bytes: Uint8Array;
				try {
					bytes = decodeBase64(content_base64);
				} catch {
					return errorResult("`content_base64` is not valid base64.");
				}
				if (bytes.byteLength === 0) {
					return errorResult("`content_base64` decodes to 0 bytes; nothing to upload.");
				}
				if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
					return errorResult(
						`The file is ${bytes.byteLength} bytes, over this server's ${MAX_ATTACHMENT_BYTES}-byte transport limit.`,
					);
				}
				const mime = content_type ?? contentTypeFor(name);

				let response;
				try {
					// retries: 0 — the POST is not idempotent; a retried 5xx could leave a
					// second `starter` asset behind.
					response = await client().rest.repos.uploadReleaseAsset({
						owner,
						repo,
						release_id,
						name,
						...(label === undefined ? {} : { label }),
						// The generated type says string, but the transport sends a Uint8Array verbatim.
						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
						data: bytes as unknown as string,
						headers: { "content-type": mime },
						request: { retries: 0 },
					});
				} catch (error) {
					if (hasAlreadyExistsError(error)) {
						return errorResult(
							`Release ${release_id} in ${owner}/${repo} already has an asset named \`${name}\`. This tool never overwrites or deletes; pick another name.`,
						);
					}
					if (isHttpStatus(error, 502)) {
						return errorResult(
							`GitHub answered 502 while uploading \`${name}\`. The upload was not retried; an incomplete \`starter\` asset may remain — check \`list_release_assets\` for release ${release_id}.`,
						);
					}
					throw error;
				}
				const { data, headers } = response;
				logRateLimit(headers);
				logWrite({
					tool: "upload_release_asset",
					owner,
					repo,
					release_id,
					asset_id: data.id,
					filename: data.name,
					byte_count: bytes.byteLength,
				});
				return text(
					truncate(
						[
							`# Asset uploaded to release ${release_id} in ${owner}/${repo}`,
							"",
							`- \`${data.id}\` **${data.name}** — ${data.size} bytes, ${data.content_type}, ${data.state}`,
							`- ${data.browser_download_url}`,
							"- for a short-lived direct link, use `download_release_asset`",
						].join("\n"),
					),
				);
			}),
	);

	server.registerTool(
		"download_release_asset",
		{
			description:
				"Resolve the direct download URL of a release asset by ID (`gh release download`). Use when the user wants the file; get the ID from `list_release_assets`. The URL is a pre-signed storage link, so it is short-lived (expires within minutes) and fetching it needs no authentication. Returns the URL only and never downloads the file. Works for assets on draft releases and private repositories when the token can read them.",
			inputSchema: {
				...RepoTarget,
				asset_id: z
					.number()
					.int()
					.positive()
					.describe("Asset ID (from `list_release_assets`), not the release ID."),
			},
		},
		async ({ owner, repo, asset_id }) =>
			wrapTool(async () => {
				const response = await client().rest.repos.getReleaseAsset({
					owner,
					repo,
					asset_id,
					headers: { accept: "application/octet-stream" },
					request: { redirect: "manual", parseSuccessResponseBody: false },
				});
				logRateLimit(response.headers);
				const body: unknown = response.data;
				const cancel = prop(body, "cancel");
				if (typeof cancel === "function") await Reflect.apply(cancel, body, []);
				const url = response.headers.location;
				if (url == null || url.length === 0) {
					return errorResult(
						`No download URL returned for asset ${asset_id} in ${owner}/${repo} (HTTP ${response.status}); GitHub did not answer with a redirect.`,
					);
				}
				return text(
					truncate(
						[
							`# Download for asset ${asset_id} in ${owner}/${repo}`,
							"",
							"- the download URL below is short-lived (expires within minutes) and needs no authentication",
							"- for the asset's metadata (name, size), use `list_release_assets`",
							`- download: ${url}`,
						].join("\n"),
					),
				);
			}),
	);
};
