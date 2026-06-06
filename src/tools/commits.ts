import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logRateLimit, text, truncate, wrapTool } from "../mcp/response.js";
import { isNonEmpty } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";
import { stripUndefined } from "./strip-undefined.js";

// Shared shape between `getCommit` and `compareCommits*` file entries. Octokit's
// generated types carry more fields, but these are all the rendering needs; the
// wider response objects remain assignable to this narrower interface.
interface DiffFile {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	patch?: string;
	previous_filename?: string;
}

// First line of a commit message — the subject. Multi-line bodies are dropped
// from list views to keep one commit per line.
const subjectOf = (message: string): string => message.split("\n")[0] ?? "";

const formatFileList = (files: DiffFile[] | undefined): string => {
	if (files == null || files.length === 0) return "(no file changes)";
	return files
		.map((f) => {
			const path = isNonEmpty(f.previous_filename)
				? `${f.previous_filename} → ${f.filename}`
				: f.filename;
			return `- \`${f.status}\` +${f.additions}/-${f.deletions} \`${path}\``;
		})
		.join("\n");
};

const formatPatches = (files: DiffFile[] | undefined): string => {
	if (files == null) return "";
	const blocks = files
		.filter((f): f is DiffFile & { patch: string } => isNonEmpty(f.patch))
		.map((f) => `### ${f.filename}\n\n\`\`\`diff\n${f.patch}\n\`\`\``);
	return blocks.join("\n\n");
};

// Both `getCommit` and `compareCommits*` return at most this many file entries;
// past it GitHub silently drops the rest. Surface that explicitly so the model
// does not treat a capped list as complete.
const GITHUB_FILE_CAP = 300;

// Returned as a header bullet (not appended after the file list) so it survives
// the response-level truncate() even when a 300-entry file list overflows the cap.
const truncatedFilesNote = (files: DiffFile[] | undefined): string | null =>
	files != null && files.length >= GITHUB_FILE_CAP
		? `⚠️ GitHub caps the file list at ${GITHUB_FILE_CAP} entries; more files may exist but are not shown. Use \`get_file_content\` or a narrower range to inspect the rest.`
		: null;

export const registerCommitTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"list_commits",
		{
			description:
				"List commits on a repository (git log). Use when the user asks what changed on a branch, who committed recently, or the history touching a path. Filter by `sha` (branch / tag / commit to start from), `path`, `author`, and a `since` / `until` date window. Returns one line per commit (short SHA, subject, author, date).",
			inputSchema: {
				...RepoTarget,
				sha: z
					.string()
					.optional()
					.describe(
						"Branch / tag / commit SHA to start from. Defaults to the repo's default branch.",
					),
				path: z.string().optional().describe("Only commits touching this path."),
				author: z.string().optional().describe("Filter by author GitHub username or email."),
				since: z.iso
					.datetime()
					.optional()
					.describe("ISO 8601 timestamp; only commits after this time."),
				until: z.iso
					.datetime()
					.optional()
					.describe("ISO 8601 timestamp; only commits before this time."),
				per_page: z.number().int().min(1).max(100).optional().default(30),
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number (1-indexed). Defaults to 1."),
			},
		},
		async ({ owner, repo, sha, path, author, since, until, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.listCommits(
					stripUndefined({
						owner,
						repo,
						sha,
						path,
						author,
						since,
						until,
						per_page,
						page,
					}),
				);
				logRateLimit(headers);
				if (data.length === 0) return text("(no commits found)");
				const lines = data.map((c) => {
					const short = c.sha.slice(0, 7);
					const subject = subjectOf(c.commit.message);
					const who = c.author?.login ?? c.commit.author?.name ?? "(unknown)";
					const when = c.commit.author?.date ?? "(unknown)";
					return `- \`${short}\` ${subject} — ${who}, ${when}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const pageNum = page ?? 1;
				const header = hasMore
					? `# Commits (page ${pageNum}, ${data.length} shown; more available — pass next \`page\` or raise \`per_page\` up to 100)`
					: `# Commits (${data.length})`;
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"get_commit",
		{
			description:
				"Fetch a single commit's detail: message, author, parents, per-file change stats, and the diff. Use when the user asks what a specific commit contains or changed. Accepts a commit SHA or a branch / tag name resolving to one commit. The diff is truncated for very large commits.",
			inputSchema: {
				...RepoTarget,
				ref: z.string().min(1).describe("Commit SHA or branch / tag name resolving to one commit."),
			},
		},
		async ({ owner, repo, ref }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.getCommit({
					owner,
					repo,
					ref,
				});
				logRateLimit(headers);
				const short = data.sha.slice(0, 7);
				const subject = subjectOf(data.commit.message);
				const who = data.author?.login ?? data.commit.author?.name ?? "(unknown)";
				const when = data.commit.author?.date ?? "(unknown)";
				const parents = data.parents.map((p) => `\`${p.sha.slice(0, 7)}\``).join(", ");
				const stats = data.stats;
				const statsLine =
					stats != null
						? `${data.files?.length ?? 0} files changed, +${stats.additions ?? 0}/-${stats.deletions ?? 0}`
						: `${data.files?.length ?? 0} files changed`;
				const filesNote = truncatedFilesNote(data.files);
				const lines = [
					`# Commit \`${short}\` in ${owner}/${repo}`,
					"",
					isNonEmpty(subject) ? `> ${subject}` : "> (no message)",
					"",
					`- author: ${who}, ${when}`,
					`- parents: ${parents.length > 0 ? parents : "(none)"}`,
					`- ${statsLine}`,
					...(filesNote != null ? [`- ${filesNote}`] : []),
					`- ${data.html_url}`,
					"",
					"## Files",
					"",
					formatFileList(data.files),
				];
				const patches = formatPatches(data.files);
				if (isNonEmpty(patches)) lines.push("", "## Diff", "", patches);
				return text(truncate(lines.join("\n")));
			}),
	);

	server.registerTool(
		"compare_commits",
		{
			description:
				"Compare two refs (branches, tags, or SHAs) — equivalent to GitHub's `/compare/base...head`. Use when the user asks what differs between two refs, or how far ahead / behind a branch is. For cross-repo (fork) compares, pass `head` as 'owner:branch'. Returns ahead / behind counts, the merge base, per-file stats, and the diff (truncated for large ranges).",
			inputSchema: {
				...RepoTarget,
				base: z.string().min(1).describe("Base ref (branch / tag / SHA)."),
				head: z
					.string()
					.min(1)
					.describe("Head ref (branch / tag / SHA). For cross-repo compares, use 'owner:branch'."),
			},
		},
		async ({ owner, repo, base, head }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.compareCommitsWithBasehead({
					owner,
					repo,
					basehead: `${base}...${head}`,
				});
				logRateLimit(headers);
				// `merge_base_commit` is absent when the two refs share no common
				// ancestor (unrelated histories) — guard so that surfaces as a clear
				// value rather than a `Cannot read properties of undefined` crash.
				const mergeBase = data.merge_base_commit?.sha?.slice(0, 7) ?? "(none)";
				const filesNote = truncatedFilesNote(data.files);
				const lines = [
					`# Compare \`${base}...${head}\` in ${owner}/${repo}`,
					"",
					`- status: ${data.status} (ahead ${data.ahead_by}, behind ${data.behind_by})`,
					`- merge base: \`${mergeBase}\``,
					`- ${data.total_commits} commits`,
					...(filesNote != null ? [`- ${filesNote}`] : []),
					`- ${data.html_url}`,
					"",
					"## Files",
					"",
					formatFileList(data.files),
				];
				const patches = formatPatches(data.files);
				if (isNonEmpty(patches)) lines.push("", "## Diff", "", patches);
				return text(truncate(lines.join("\n")));
			}),
	);
};
