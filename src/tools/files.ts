import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	ContentEncodingSchema,
	encodeBase64Utf8,
	FileModeSchema,
	getBranchHeadSha,
	resolveFileSha,
} from "../github/helpers.js";
import { errorResult, logRateLimit, text, truncate, wrapTool } from "../mcp/response.js";
import { isNonEmpty } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";

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
					const entries = data.map((e) => `- ${e.type === "dir" ? "📁" : "📄"} ${e.name}`);
					return text(
						`# Directory listing: ${owner}/${repo}/${path}${refSuffix}\n\n${entries.join("\n")}`,
					);
				}
				if (data.type !== "file" || !("content" in data) || data.content == null) {
					return errorResult(`Path is not a regular file (type=${data.type}).`);
				}
				const decoded = atob(data.content.replace(/\n/g, ""));
				return text(
					truncate(
						`# ${owner}/${repo}/${path}${refSuffix} (${data.size} bytes)\n\n\`\`\`\n${decoded}\n\`\`\``,
					),
				);
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
					.describe(
						"File content; encoding determined by `encoding` (default 'utf-8'). Pass pre-base64'd bytes only when `encoding: 'base64'`.",
					),
				encoding: ContentEncodingSchema.optional().default("utf-8"),
				message: z.string().min(1).describe("Commit message."),
			},
		},
		async ({ owner, repo, branch, path, content, encoding, message }) =>
			wrapTool(async () => {
				const octo = client();
				const resolved = await resolveFileSha(octo, owner, repo, path, branch);
				if (resolved.kind === "directory") {
					return errorResult(
						`Path \`${path}\` resolves to a directory; commit_file targets a single regular file.`,
					);
				}
				if (resolved.kind === "non-file") {
					return errorResult(
						`Path \`${path}\` is a ${resolved.type}, not a regular file; refusing to overwrite via commit_file.`,
					);
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
				message: z.string().min(1).describe("Commit message."),
			},
		},
		async ({ owner, repo, branch, path, message }) =>
			wrapTool(async () => {
				const octo = client();
				const resolved = await resolveFileSha(octo, owner, repo, path, branch);
				if (resolved.kind === "directory") {
					return errorResult(
						`Path \`${path}\` resolves to a directory; delete_file targets a single regular file.`,
					);
				}
				if (resolved.kind === "non-file") {
					return errorResult(
						`Path \`${path}\` is a ${resolved.type}, not a regular file; refusing to delete via delete_file.`,
					);
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
				message: z.string().min(1).describe("Commit message."),
				files: z
					.array(
						z.object({
							path: z.string().min(1).describe("File path within the repo."),
							content: z
								.string()
								.describe(
									"File content; encoding is determined by per-file `encoding` (default 'utf-8').",
								),
							encoding: ContentEncodingSchema.optional().default("utf-8"),
							mode: FileModeSchema.optional().default("100644"),
						}),
					)
					.min(1)
					.describe("Files to create or update in this commit."),
			},
		},
		async ({ owner, repo, branch, message, files }) =>
			wrapTool(async () => {
				const octo = client();
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
