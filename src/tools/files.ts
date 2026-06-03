import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	ContentEncodingSchema,
	encodeBase64Utf8,
	FileModeSchema,
	fileShaError,
	getBranchHeadSha,
	resolveFileSha,
} from "../github/helpers.js";
import { errorResult, logRateLimit, text, truncate, wrapTool } from "../mcp/response.js";
import { isNonEmpty } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import {
	MAX_FILE_CONTENT_LENGTH,
	MAX_FILES_PER_COMMIT,
	MAX_TEXT_FIELD_LENGTH,
	MAX_TOTAL_COMMIT_CONTENT_LENGTH,
	maxCharsMessage,
	RepoTarget,
} from "./common.js";

type GitClient = ReturnType<OctokitFactory>;

// Fetches a blob's bytes as base64 via the Git Blob API. Used as a fallback when
// the Contents API declines to inline `content` (files 1-100 MB return
// `encoding: "none"`). The Blob API caps at 100 MB; larger files reject and the
// error surfaces through `wrapTool`.
const fetchBlobBase64 = async (
	octo: GitClient,
	owner: string,
	repo: string,
	fileSha: string,
): Promise<string> => {
	const { data, headers } = await octo.rest.git.getBlob({ owner, repo, file_sha: fileSha });
	logRateLimit(headers);
	// The Blob API normally returns base64; tolerate a utf-8 response by re-encoding.
	return data.encoding === "base64" ? data.content : encodeBase64Utf8(data.content);
};

// Decodes a base64 blob to a UTF-8 string, returning null when the bytes are not
// valid UTF-8 (i.e. the file is binary). `atob` yields a Latin-1 byte string;
// interpolating raw binary bytes into a text code fence would emit mojibake, so
// the caller surfaces a "binary, not rendered" notice instead.
const decodeBase64ToText = (base64: string): string | null => {
	const binary = atob(base64.replace(/\n/g, ""));
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		return null;
	}
};

export const registerFileTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"get_file_content",
		{
			description:
				"Fetch the raw content of a file from a GitHub repository at a given path and optional ref (branch, tag, or commit SHA). Use when the user asks to read, view, or inspect a specific file in a repo. Returns a fenced code block with the file's text content.",
			inputSchema: {
				...RepoTarget,
				path: z.string().describe("File path within the repo (e.g. 'src/index.ts')."),
				ref: z
					.string()
					.optional()
					.describe("Branch, tag, or commit SHA. Defaults to the repo's default branch."),
			},
		},
		async ({ owner, repo, path, ref }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.getContent({
					owner,
					repo,
					path,
					ref,
				});
				logRateLimit(headers);
				const refSuffix = isNonEmpty(ref) ? `@${ref}` : "";
				if (Array.isArray(data)) {
					const entries = data.map((e) => `- ${e.type === "dir" ? "[dir]" : "[file]"} ${e.name}`);
					return text(
						`# Directory listing: ${owner}/${repo}/${path}${refSuffix}\n\n${entries.join("\n")}`,
					);
				}
				if (data.type !== "file" || !("content" in data) || data.content == null) {
					return errorResult(`Path is not a regular file (type=${data.type}).`);
				}
				const header = `# ${owner}/${repo}/${path}${refSuffix} (${data.size} bytes)`;
				// Reject oversized files before fetching anything: decoding a
				// multi-megabyte blob fully into the isolate (base64 response + atob
				// binary string + interpolation) would risk OOM on the Workers runtime,
				// the same memory concern the write-side caps guard. The 1-100 MB files
				// the Blob-API fallback below targets are mostly binary anyway.
				if (data.size > MAX_FILE_CONTENT_LENGTH) {
					return errorResult(
						`File is ${data.size} bytes, over the ${MAX_FILE_CONTENT_LENGTH}-byte read limit. View it on the web instead: ${data.html_url ?? "(url unavailable)"}`,
					);
				}
				// The Contents API only inlines `content` for files <= 1 MB; for files
				// 1-100 MB it returns `content: ""` with `encoding: "none"`. Falling
				// straight to atob("") would silently yield an empty body, so fetch the
				// bytes via the Git Blob API using the blob SHA the Contents response
				// already provides. Gate on `encoding` (the authoritative non-inlined
				// signal) so an empty 0-byte file does not trigger a needless round-trip.
				const base64 =
					data.encoding === "none"
						? await fetchBlobBase64(client(), owner, repo, data.sha)
						: data.content;
				const decoded = decodeBase64ToText(base64);
				if (decoded == null) {
					return errorResult(
						`File appears to be binary (not valid UTF-8); not rendering its bytes as text. View it on the web instead: ${data.html_url ?? "(url unavailable)"}`,
					);
				}
				return text(truncate(`${header}\n\n\`\`\`\n${decoded}\n\`\`\``));
			}),
	);

	server.registerTool(
		"commit_file",
		{
			description:
				"Create or update a single file on a branch in one commit. Use when the user asks to add, edit, or replace one file. `encoding` defaults to 'utf-8'; pass 'base64' when sending pre-encoded binary bytes. Returns the new commit SHA and file URL.",
			inputSchema: {
				...RepoTarget,
				branch: z.string().min(1).describe("Branch to commit to (must already exist)."),
				path: z.string().min(1).describe("File path within the repo."),
				content: z
					.string()
					.max(MAX_FILE_CONTENT_LENGTH, maxCharsMessage("File content", MAX_FILE_CONTENT_LENGTH))
					.describe(
						"File content; encoding determined by `encoding` (default 'utf-8'). Pass pre-base64'd bytes only when `encoding: 'base64'`.",
					),
				encoding: ContentEncodingSchema.optional().default("utf-8"),
				message: z
					.string()
					.min(1)
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Commit message", MAX_TEXT_FIELD_LENGTH))
					.describe("Commit message."),
			},
		},
		async ({ owner, repo, branch, path, content, encoding, message }) =>
			wrapTool(async () => {
				const octo = client();
				const resolved = await resolveFileSha(octo, owner, repo, path, branch);
				if (resolved.kind === "directory" || resolved.kind === "non-file") {
					return fileShaError(resolved, "commit_file", "overwrite", path);
				}
				const sha = resolved.kind === "found" ? resolved.sha : undefined;
				const encoded = encoding === "base64" ? content : encodeBase64Utf8(content);
				const { data, headers } = await octo.rest.repos.createOrUpdateFileContents({
					owner,
					repo,
					path,
					branch,
					message,
					content: encoded,
					sha,
				});
				logRateLimit(headers);
				const action = sha != null ? "updated" : "created";
				return text(
					`# File ${action}\n\n- \`${path}\` on \`${branch}\` (encoding=${encoding})\n- commit: \`${data.commit.sha?.slice(0, 7) ?? "(unknown)"}\` — ${data.commit.html_url}\n- file: ${data.content?.html_url ?? "(n/a)"}`,
				);
			}),
	);

	server.registerTool(
		"delete_file",
		{
			description:
				"Delete a single file on a branch in one commit. Use when the user asks to remove, drop, or delete a file from a repo. Auto-fetches the file's blob SHA before delete (mirroring commit_file). Returns the new commit SHA and URL.",
			inputSchema: {
				...RepoTarget,
				branch: z
					.string()
					.min(1)
					.describe("Branch to commit the deletion to (must already exist)."),
				path: z.string().min(1).describe("File path within the repo."),
				message: z
					.string()
					.min(1)
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Commit message", MAX_TEXT_FIELD_LENGTH))
					.describe("Commit message."),
			},
		},
		async ({ owner, repo, branch, path, message }) =>
			wrapTool(async () => {
				const octo = client();
				const resolved = await resolveFileSha(octo, owner, repo, path, branch);
				if (resolved.kind === "directory" || resolved.kind === "non-file") {
					return fileShaError(resolved, "delete_file", "delete", path);
				}
				if (resolved.kind === "missing") {
					return errorResult(
						`Could not locate \`${path}\` on branch \`${branch}\` (file may not exist, or the branch / repository may be unreachable); nothing to delete.`,
					);
				}
				const sha = resolved.sha;
				const { data, headers } = await octo.rest.repos.deleteFile({
					owner,
					repo,
					path,
					branch,
					message,
					sha,
				});
				logRateLimit(headers);
				return text(
					`# File deleted\n\n- \`${path}\` on \`${branch}\`\n- commit: \`${data.commit.sha?.slice(0, 7) ?? "(unknown)"}\` — ${data.commit.html_url}`,
				);
			}),
	);

	server.registerTool(
		"commit_files",
		{
			description:
				"Create or update multiple files on a branch in a single commit via the Git Tree API. Use when the user asks to commit several files at once. Per-file `mode` (default 100644; 100755 for executables, 120000 for symlinks) and `encoding` (default utf-8; base64 for binary). Returns the new commit SHA and URL.",
			inputSchema: {
				...RepoTarget,
				branch: z.string().min(1).describe("Branch to commit to (must already exist)."),
				message: z
					.string()
					.min(1)
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Commit message", MAX_TEXT_FIELD_LENGTH))
					.describe("Commit message."),
				files: z
					.array(
						z.object({
							path: z.string().min(1).describe("File path within the repo."),
							content: z
								.string()
								.max(
									MAX_FILE_CONTENT_LENGTH,
									maxCharsMessage("File content", MAX_FILE_CONTENT_LENGTH),
								)
								.describe(
									"File content; encoding is determined by per-file `encoding` (default 'utf-8').",
								),
							encoding: ContentEncodingSchema.optional().default("utf-8"),
							mode: FileModeSchema.optional().default("100644"),
						}),
					)
					.min(1)
					.max(
						MAX_FILES_PER_COMMIT,
						`A single commit may include at most ${MAX_FILES_PER_COMMIT} files.`,
					)
					.describe("Files to create or update in this commit."),
			},
		},
		async ({ owner, repo, branch, message, files }) =>
			wrapTool(async () => {
				const octo = client();
				// Per-file content is capped by the schema, but the file count alone does not
				// bound the sum - guard the aggregate before any API call.
				const totalContentLength = files.reduce((sum, f) => sum + f.content.length, 0);
				if (totalContentLength > MAX_TOTAL_COMMIT_CONTENT_LENGTH) {
					return errorResult(
						maxCharsMessage(
							"Combined file content for this commit",
							MAX_TOTAL_COMMIT_CONTENT_LENGTH,
						),
					);
				}
				const parentSha = await getBranchHeadSha(octo, owner, repo, branch);
				const parentCommit = await octo.rest.git.getCommit({
					owner,
					repo,
					commit_sha: parentSha,
				});
				logRateLimit(parentCommit.headers);
				const treeEntries = await Promise.all(
					files.map(async (f) => {
						if (f.encoding === "base64") {
							const blob = await octo.rest.git.createBlob({
								owner,
								repo,
								content: f.content,
								encoding: "base64",
							});
							logRateLimit(blob.headers);
							return {
								path: f.path,
								mode: f.mode,
								type: "blob" as const,
								sha: blob.data.sha,
							};
						}
						return {
							path: f.path,
							mode: f.mode,
							type: "blob" as const,
							content: f.content,
						};
					}),
				);
				const tree = await octo.rest.git.createTree({
					owner,
					repo,
					base_tree: parentCommit.data.tree.sha,
					tree: treeEntries,
				});
				logRateLimit(tree.headers);
				const commit = await octo.rest.git.createCommit({
					owner,
					repo,
					message,
					tree: tree.data.sha,
					parents: [parentSha],
				});
				logRateLimit(commit.headers);
				const updated = await octo.rest.git.updateRef({
					owner,
					repo,
					ref: `heads/${branch}`,
					sha: commit.data.sha,
				});
				logRateLimit(updated.headers);
				const list = files
					.map((f) => `  - \`${f.path}\` (mode=${f.mode}, encoding=${f.encoding})`)
					.join("\n");
				return text(
					`# Commit pushed\n\n- branch: \`${branch}\`\n- commit: \`${commit.data.sha.slice(0, 7)}\` — ${commit.data.html_url}\n- files (${files.length}):\n${list}`,
				);
			}),
	);
};
