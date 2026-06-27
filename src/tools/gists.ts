import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	errorResult,
	logRateLimit,
	logWrite,
	previewLine,
	restListHeader,
	text,
	truncate,
	wrapTool,
} from "../mcp/response.js";
import { isNonEmpty, stripUndefined } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { MAX_FILE_CONTENT_LENGTH, MAX_TEXT_FIELD_LENGTH, maxCharsMessage } from "./common.js";

// Per-file inline excerpt cap inside `get_gist`. Gist files can be much larger
// than the response budget, so each file's `content` is truncated against the
// shared response cap; tighter still would hide real signal, looser would let a
// single big file crowd out the rest of the gist.
const MAX_GIST_FILE_EXCERPT = 2000;

// Gist detail shape returned by every read + write endpoint that yields a full
// gist (`get`, `create`, `update`). Derive from the SDK's `get` response so the
// renderer stays pinned to the real API contract.
type GistDetail = Awaited<ReturnType<ReturnType<OctokitFactory>["rest"]["gists"]["get"]>>["data"];

const renderGistDetail = (data: GistDetail): string => {
	const description = isNonEmpty(data.description) ? data.description : "(no description)";
	const owner = data.owner?.login ?? "(unknown)";
	const files = data.files ?? {};
	const fileEntries = Object.entries(files);
	const lines = [
		`# Gist \`${data.id}\``,
		"",
		`> ${description}`,
		"",
		`- public: ${data.public === true ? "yes" : "no"}`,
		`- owner: ${owner}`,
		`- files: ${fileEntries.length}`,
		`- updated: ${data.updated_at}`,
		`- created: ${data.created_at}`,
		`- ${data.html_url}`,
	];
	const fileSections = fileEntries.map(([name, info]) => {
		if (info == null) return `### \`${name}\`\n\n(file removed)`;
		const language = info.language ?? "(unknown)";
		const size = info.size ?? 0;
		const meta = `- language: ${language}\n- size: ${size}\n- raw: ${info.raw_url ?? "(n/a)"}`;
		const content = info.content;
		if (content == null) return `### \`${name}\`\n\n${meta}\n\n(content not returned)`;
		// `truncate` is sized against the response cap; the per-file excerpt has a
		// tighter local cap so one big file can't starve the others.
		const excerpt = truncate(content, MAX_GIST_FILE_EXCERPT);
		const fence = "```";
		return `### \`${name}\`\n\n${meta}\n\n${fence}\n${excerpt}\n${fence}`;
	});
	const body =
		fileSections.length > 0 ? `\n\n## Files\n\n${fileSections.join("\n\n")}` : "\n\n(no files)";
	return truncate(`${lines.join("\n")}${body}`);
};

// SDK's typed `files` parameter for `gists.update` keys to
// `{ content?: string; filename?: string | null }`. It does **not** model the
// entry-level `null` delete shape (`{ "drop.txt": null }`) that the REST API
// requires to remove a file, nor `filename: null` for renames. The adapter
// below isolates the cast so the type mismatch lives in one labelled spot.
type SdkFileEntry = { content?: string; filename?: string | null };

const toSdkFiles = (
	files: Record<string, unknown> | undefined,
): Record<string, SdkFileEntry> | undefined => {
	if (files == null) return undefined;
	// The wire-true value includes `null` entries (delete); the SDK type does
	// not, so we cast. Single localised escape hatch.
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return files as Record<string, SdkFileEntry>;
};

export const registerGistTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"list_gists",
		{
			description:
				"List the authenticated user's gists newest first (one line per gist: ID, description, public flag, file count, updated_at). Use when the user asks what gists they have, what they last saved as a gist, or to find a `gist_id` for `get_gist`.",
			inputSchema: {
				since: z
					.string()
					.optional()
					.describe(
						"Only show gists updated at or after this ISO-8601 timestamp (e.g. '2026-01-01T00:00:00Z').",
					),
				per_page: z.number().int().min(1).max(100).optional().default(30),
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number (1-indexed). Defaults to 1."),
			},
		},
		async ({ since, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.gists.list(
					stripUndefined({ since, per_page, page }),
				);
				logRateLimit(headers);
				if (data.length === 0) return text("(no gists found)");
				const lines = data.map((g) => {
					const description = isNonEmpty(g.description) ? g.description : "(no description)";
					const fileCount = Object.keys(g.files ?? {}).length;
					const visibility = g.public ? "public" : "secret";
					return `- \`${g.id}\` **${description}** — ${visibility}, ${fileCount} file(s), ${g.updated_at}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: "Gists",
					count: data.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"get_gist",
		{
			description:
				"Fetch a single gist's detail — description, public flag, owner, file list (filename, language, size, raw URL) and a length-capped excerpt of each file's content. Look up by `gist_id` (from `list_gists`).",
			inputSchema: {
				gist_id: z.string().min(1).describe("Gist ID (from `list_gists`)."),
			},
		},
		async ({ gist_id }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.gists.get({ gist_id });
				logRateLimit(headers);
				return text(renderGistDetail(data));
			}),
	);

	server.registerTool(
		"list_gist_comments",
		{
			description:
				"List comments on a gist (one line per comment: author, posted date, short body preview). Use when the user asks what people said on a gist.",
			inputSchema: {
				gist_id: z.string().min(1).describe("Gist ID (from `list_gists`)."),
				per_page: z.number().int().min(1).max(100).optional().default(30),
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number (1-indexed). Defaults to 1."),
			},
		},
		async ({ gist_id, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.gists.listComments(
					stripUndefined({ gist_id, per_page, page }),
				);
				logRateLimit(headers);
				if (data.length === 0) return text("(no comments found)");
				const lines = data.map((c) => {
					const author = c.user?.login ?? "(unknown)";
					const preview = previewLine(c.body);
					return `- \`${c.id}\` **${author}** (${c.created_at}) — ${preview}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: "Gist comments",
					count: data.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"create_gist",
		{
			description:
				"Create a new gist with one or more files. `public: true` exposes the gist at a guessable URL — defaults to false (secret). Mutates account state.",
			inputSchema: {
				description: z
					.string()
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Description", MAX_TEXT_FIELD_LENGTH))
					.optional()
					.describe("Gist description shown in listings."),
				files: z
					.record(
						z.string().min(1),
						z.object({
							content: z
								.string()
								.min(1)
								.max(
									MAX_FILE_CONTENT_LENGTH,
									maxCharsMessage("File content", MAX_FILE_CONTENT_LENGTH),
								)
								.describe("File contents (utf-8 text)."),
						}),
					)
					.describe("Map of filename → { content }. At least one file required."),
				public: z
					.boolean()
					.optional()
					.describe("Make the gist public (defaults to false / secret)."),
			},
		},
		async ({ description, files, public: isPublic }) =>
			wrapTool(async () => {
				if (Object.keys(files).length === 0) {
					return errorResult("Pass at least one file.");
				}
				const { data, headers } = await client().rest.gists.create(
					stripUndefined({
						description,
						files,
						public: isPublic,
					}),
				);
				logRateLimit(headers);
				logWrite(stripUndefined({ tool: "create_gist", gist_id: data.id }));
				return text(renderGistDetail(data));
			}),
	);

	server.registerTool(
		"update_gist",
		{
			description:
				"Edit a gist by `gist_id`: change `description`, and/or add / replace / rename / delete files via `files`. To delete a file, set its whole entry to `null` (e.g. `{ \"drop.txt\": null }`); to rename, pass `{ filename: '<new name>' }` (paired with `content` to also change its contents); to replace content, pass `{ content: '<new>' }`. Files you do not mention are left untouched. Mutates account state.",
			inputSchema: {
				gist_id: z.string().min(1).describe("Gist ID to edit (from `list_gists`)."),
				description: z
					.string()
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Description", MAX_TEXT_FIELD_LENGTH))
					.optional()
					.describe("New gist description. Omit to leave unchanged."),
				files: z
					.record(
						z.string().min(1),
						z
							.object({
								content: z
									.string()
									.min(1)
									.max(
										MAX_FILE_CONTENT_LENGTH,
										maxCharsMessage("File content", MAX_FILE_CONTENT_LENGTH),
									)
									.optional()
									.describe("New file content (utf-8 text)."),
								filename: z
									.string()
									.min(1)
									.optional()
									.describe("New filename to rename the file to."),
							})
							.refine((v) => v.content !== undefined || v.filename !== undefined, {
								message:
									"Each file entry must set `content` and/or `filename` (or be `null` to delete).",
							})
							.nullable(),
					)
					.optional()
					.describe(
						"Map of filename → change spec. Pass `null` as the value to delete the file; otherwise pass `{ content?, filename? }` to replace content and/or rename.",
					),
			},
		},
		async ({ gist_id, description, files }) =>
			wrapTool(async () => {
				if (description == null && files == null) {
					return errorResult("Pass at least one of `description` or `files` to change.");
				}
				if (files != null && Object.keys(files).length === 0) {
					return errorResult("Pass at least one file.");
				}
				// SDK's typed `files` parameter does not model the entry-level
				// `null` delete shape — see `GistUpdateFilesSdk` above. The validated
				// zod schema admits both `null` entries and `{ content?, filename? }`
				// objects; the underlying REST endpoint accepts both. Cast through
				// `unknown` to the SDK's narrower view at the call site.
				const sdkFiles = toSdkFiles(files);
				const { data, headers } = await client().rest.gists.update(
					stripUndefined({
						gist_id,
						description,
						files: sdkFiles,
					}),
				);
				logRateLimit(headers);
				logWrite({ tool: "update_gist", gist_id });
				return text(renderGistDetail(data));
			}),
	);

	server.registerTool(
		"delete_gist",
		{
			description: "Delete a gist by `gist_id`. Mutates account state and is irreversible.",
			inputSchema: {
				gist_id: z.string().min(1).describe("Gist ID to delete (from `list_gists`)."),
			},
		},
		async ({ gist_id }) =>
			wrapTool(async () => {
				const { headers } = await client().rest.gists.delete({ gist_id });
				logRateLimit(headers);
				logWrite({ tool: "delete_gist", gist_id });
				return text(`# Gist deleted\n\n- gist \`${gist_id}\` deleted`);
			}),
	);
};
