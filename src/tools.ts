import { Octokit } from "octokit";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	ContentEncodingSchema,
	encodeBase64Utf8,
	FileModeSchema,
	getBranchHeadSha,
	resolveDefaultBranch,
} from "./github/helpers.js";
import {
	errorResult,
	logRateLimit,
	text,
	truncate,
	wrapTool,
} from "./mcp/response.js";

const RepoTarget = {
	owner: z.string().describe("Repository owner (user or organisation login)."),
	repo: z.string().describe("Repository name."),
} as const;

export const registerTools = (
	server: McpServer,
	getAccessToken: () => string,
): void => {
	const client = (): Octokit => new Octokit({ auth: getAccessToken() });

	// ─── Read tools ────────────────────────────────────────────────────────────

	server.tool(
		"list_my_repos",
		"List repositories owned by or accessible to the authenticated GitHub user. Use when the user asks to see, browse, enumerate, or find their own repositories. Returns repo full name, visibility, description, URL, star count, and last-update timestamp.",
		{
			visibility: z
				.enum(["all", "public", "private"])
				.optional()
				.default("all")
				.describe("Filter by visibility."),
			sort: z
				.enum(["created", "updated", "pushed", "full_name"])
				.optional()
				.default("updated")
				.describe("Sort field."),
			per_page: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.default(30)
				.describe("Results per page (1-100)."),
		},
		async ({ visibility, sort, per_page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.listForAuthenticatedUser({
					visibility,
					sort,
					per_page,
				});
				logRateLimit(headers);
				if (data.length === 0) return text("(no repositories found)");
				const lines = data.map((r) => {
					const flag = r.private ? "🔒 private" : "🌐 public";
					const desc = r.description ? ` — ${r.description}` : "";
					return `- **${r.full_name}** (${flag})${desc}\n  - ${r.html_url} | ⭐ ${r.stargazers_count} | updated ${r.updated_at}`;
				});
				return text(truncate(`# Repositories (${data.length})\n\n${lines.join("\n")}`));
			}),
	);

	server.tool(
		"search_issues",
		"Search issues and pull requests inside a specific repository. Use when the user asks to find issues/PRs matching a query, filter by state, or look up bugs/features in a repo. Returns title, number, state, author, and URL for each match.",
		{
			...RepoTarget,
			query: z
				.string()
				.describe(
					"Search keywords (GitHub search syntax). Repo qualifier is added automatically.",
				),
			state: z
				.enum(["open", "closed", "all"])
				.optional()
				.default("open")
				.describe("Issue/PR state filter."),
			per_page: z.number().int().min(1).max(50).optional().default(20),
		},
		async ({ owner, repo, query, state, per_page }) =>
			wrapTool(async () => {
				const qualifier =
					state === "all" ? `repo:${owner}/${repo}` : `repo:${owner}/${repo} state:${state}`;
				const q = `${query} ${qualifier}`;
				const { data, headers } = await client().rest.search.issuesAndPullRequests({
					q,
					per_page,
				});
				logRateLimit(headers);
				if (data.total_count === 0)
					return text(`# Search results\n\nNo issues or PRs matched \`${q}\`.`);
				const lines = data.items.map((i) => {
					const kind = i.pull_request ? "PR" : "Issue";
					return `- [${kind} #${i.number}] **${i.title}** (${i.state}) by @${i.user?.login}\n  - ${i.html_url}`;
				});
				return text(
					truncate(
						`# Search results for \`${q}\` (showing ${data.items.length} of ${data.total_count})\n\n${lines.join(
							"\n",
						)}`,
					),
				);
			}),
	);

	server.tool(
		"get_file_content",
		"Fetch the raw content of a file from a GitHub repository at a given path and optional ref (branch, tag, or commit SHA). Use when the user asks to read, view, or inspect a specific file in a repo. Returns a fenced code block with the file's text content.",
		{
			...RepoTarget,
			path: z.string().describe("File path within the repo (e.g. 'src/index.ts')."),
			ref: z
				.string()
				.optional()
				.describe("Branch, tag, or commit SHA. Defaults to the repo's default branch."),
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
				if (Array.isArray(data)) {
					const entries = data.map(
						(e) => `- ${e.type === "dir" ? "📁" : "📄"} ${e.name}`,
					);
					return text(
						`# Directory listing: ${owner}/${repo}/${path}${ref ? `@${ref}` : ""}\n\n${entries.join("\n")}`,
					);
				}
				if (data.type !== "file" || !("content" in data) || data.content == null) {
					return errorResult(`Path is not a regular file (type=${data.type}).`);
				}
				const decoded = atob(data.content.replace(/\n/g, ""));
				return text(
					truncate(
						`# ${owner}/${repo}/${path}${ref ? `@${ref}` : ""} (${data.size} bytes)\n\n\`\`\`\n${decoded}\n\`\`\``,
					),
				);
			}),
	);

	server.tool(
		"get_pr_diff",
		"Fetch the unified diff of a pull request. Use when the user asks to review, summarise, or inspect the changes in a specific PR. Returns the diff as a fenced code block (truncated for very large PRs).",
		{
			...RepoTarget,
			pull_number: z.number().int().positive().describe("Pull request number."),
		},
		async ({ owner, repo, pull_number }) =>
			wrapTool(async () => {
				const response = await client().rest.pulls.get({
					owner,
					repo,
					pull_number,
					mediaType: { format: "diff" },
				});
				logRateLimit(response.headers);
				const diff = response.data as unknown as string;
				return text(
					truncate(
						`# Diff for ${owner}/${repo}#${pull_number}\n\n\`\`\`diff\n${diff}\n\`\`\``,
					),
				);
			}),
	);

	server.tool(
		"search_code",
		"Search source code across GitHub (or scoped to a specific repository / owner). Use when the user asks to find usages, patterns, or function definitions in code. Returns file path, repo, and a permalink for each match.",
		{
			query: z
				.string()
				.describe(
					"GitHub code-search query. Combine with qualifiers like 'repo:owner/name', 'language:ts', 'path:src/**'.",
				),
			per_page: z.number().int().min(1).max(50).optional().default(20),
		},
		async ({ query, per_page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.search.code({
					q: query,
					per_page,
				});
				logRateLimit(headers);
				if (data.total_count === 0)
					return text(`# Code search\n\nNo matches for \`${query}\`.`);
				const lines = data.items.map(
					(i) => `- **${i.repository.full_name}** — \`${i.path}\`\n  - ${i.html_url}`,
				);
				return text(
					truncate(
						`# Code search results for \`${query}\` (showing ${data.items.length} of ${data.total_count})\n\n${lines.join(
							"\n",
						)}`,
					),
				);
			}),
	);

	// ─── Write tools ───────────────────────────────────────────────────────────

	server.tool(
		"create_issue",
		"Create a new GitHub issue in the specified repository. Use when the user explicitly asks to file, open, or create an issue. Requires title; body, labels, and assignees are optional. Returns the created issue's number and URL.",
		{
			...RepoTarget,
			title: z.string().min(1).describe("Issue title."),
			body: z.string().optional().describe("Issue body (Markdown supported)."),
			labels: z
				.array(z.string())
				.optional()
				.describe("Labels to attach (must already exist in the repo)."),
			assignees: z
				.array(z.string())
				.optional()
				.describe("GitHub usernames to assign."),
		},
		async ({ owner, repo, title, body, labels, assignees }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.create({
					owner,
					repo,
					title,
					body,
					labels,
					assignees,
				});
				logRateLimit(headers);
				return text(
					`# Issue created\n\n- **${data.title}** (#${data.number})\n- ${data.html_url}`,
				);
			}),
	);

	server.tool(
		"add_comment",
		"Add a comment to an existing issue or pull request. Use when the user asks to comment on, reply to, or annotate an issue/PR. PRs accept comments via the same endpoint as issues. Returns the new comment's URL.",
		{
			...RepoTarget,
			issue_number: z
				.number()
				.int()
				.positive()
				.describe("Issue or PR number to comment on."),
			body: z.string().min(1).describe("Comment body (Markdown supported)."),
		},
		async ({ owner, repo, issue_number, body }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.createComment({
					owner,
					repo,
					issue_number,
					body,
				});
				logRateLimit(headers);
				return text(`# Comment added\n\n- on #${issue_number}\n- ${data.html_url}`);
			}),
	);

	server.tool(
		"commit_file",
		"Create or update a single file on a branch in one commit. Use when the user asks to add, edit, or replace one file. On update, the existing blob SHA is looked up automatically. `encoding` defaults to 'utf-8'; pass 'base64' when sending pre-encoded binary bytes. Returns the new commit SHA and file URL.",
		{
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
		async ({ owner, repo, branch, path, content, encoding, message }) =>
			wrapTool(async () => {
				const octo = client();
				let sha: string | undefined;
				try {
					const existing = await octo.rest.repos.getContent({
						owner,
						repo,
						path,
						ref: branch,
					});
					logRateLimit(existing.headers);
					if (Array.isArray(existing.data)) {
						return errorResult(
							`Path \`${path}\` resolves to a directory; commit_file targets a single regular file.`,
						);
					}
					if (existing.data.type !== "file") {
						return errorResult(
							`Path \`${path}\` is a ${existing.data.type}, not a regular file; refusing to overwrite via commit_file.`,
						);
					}
					sha = existing.data.sha;
				} catch (e: unknown) {
					const status =
						e != null && typeof e === "object" && "status" in e
							? (e as { status: number }).status
							: undefined;
					if (status !== 404) throw e;
				}
				const encoded =
					encoding === "base64" ? content : encodeBase64Utf8(content);
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
				const action = sha ? "updated" : "created";
				return text(
					`# File ${action}\n\n- \`${path}\` on \`${branch}\` (encoding=${encoding})\n- commit: \`${data.commit.sha?.slice(0, 7)}\` — ${data.commit.html_url}\n- file: ${data.content?.html_url ?? "(n/a)"}`,
				);
			}),
	);

	server.tool(
		"commit_files",
		"Create or update multiple files on a branch in a single commit via the Git Tree API. Use when the user asks to commit several files at once. Per-file `mode` preserves executable bits / symlinks; per-file `encoding` supports binary via blob creation. Returns the new commit SHA and URL.",
		{
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

	server.tool(
		"create_pull_request",
		"Open a new pull request in a repository. Use when the user asks to open, file, or create a PR. Requires title and head branch; base defaults to the repo's default branch. Optionally body, draft, and maintainer_can_modify. Returns the new PR's number and URL.",
		{
			...RepoTarget,
			title: z.string().min(1).describe("Pull request title."),
			head: z
				.string()
				.min(1)
				.describe(
					"Branch where your changes are implemented. For cross-repo PRs use 'owner:branch'.",
				),
			base: z
				.string()
				.optional()
				.describe("Branch to merge into. Defaults to the repo's default branch."),
			body: z.string().optional().describe("PR description (Markdown supported)."),
			draft: z.boolean().optional().describe("Create as a draft PR."),
			maintainer_can_modify: z
				.boolean()
				.optional()
				.describe("Allow maintainers to edit the PR branch (cross-repo PRs)."),
		},
		async ({ owner, repo, title, head, base, body, draft, maintainer_can_modify }) =>
			wrapTool(async () => {
				const octo = client();
				const target = base ?? (await resolveDefaultBranch(octo, owner, repo));
				const { data, headers } = await octo.rest.pulls.create({
					owner,
					repo,
					title,
					head,
					base: target,
					body,
					draft,
					maintainer_can_modify,
				});
				logRateLimit(headers);
				const flag = data.draft ? " (draft)" : "";
				return text(
					`# Pull request opened${flag}\n\n- **${data.title}** (#${data.number}) — \`${head}\` → \`${target}\`\n- ${data.html_url}`,
				);
			}),
	);

	server.tool(
		"create_branch",
		"Create a new branch in a repository, pointing at the tip of a base branch (default: the repo's default branch). Use when the user asks to branch off, start a new feature branch, or fork the current state. Returns the new ref name and SHA.",
		{
			...RepoTarget,
			branch: z.string().min(1).describe("New branch name (without 'refs/heads/' prefix)."),
			from: z
				.string()
				.optional()
				.describe("Base branch name to branch from. Defaults to the repo's default branch."),
		},
		async ({ owner, repo, branch, from }) =>
			wrapTool(async () => {
				const octo = client();
				const base = from ?? (await resolveDefaultBranch(octo, owner, repo));
				const baseSha = await getBranchHeadSha(octo, owner, repo, base);
				const created = await octo.rest.git.createRef({
					owner,
					repo,
					ref: `refs/heads/${branch}`,
					sha: baseSha,
				});
				logRateLimit(created.headers);
				return text(
					`# Branch created\n\n- **${branch}** ← branched from \`${base}\` @ \`${baseSha.slice(0, 7)}\`\n- ref: ${created.data.ref}`,
				);
			}),
	);

	server.tool(
		"request_pr_review",
		"Request reviewers (users and/or teams) on an existing pull request. Use when the user asks to assign, request, or add reviewers to a PR. At least one of `reviewers` or `team_reviewers` must be non-empty. Returns the PR URL and the list of requested reviewers.",
		{
			...RepoTarget,
			pull_number: z.number().int().positive().describe("Pull request number."),
			reviewers: z
				.array(z.string())
				.optional()
				.describe("GitHub usernames to request review from."),
			team_reviewers: z
				.array(z.string())
				.optional()
				.describe("Team slugs (within the repo's org) to request review from."),
		},
		async ({ owner, repo, pull_number, reviewers, team_reviewers }) =>
			wrapTool(async () => {
				if ((reviewers == null || reviewers.length === 0) &&
					(team_reviewers == null || team_reviewers.length === 0)) {
					return errorResult(
						"At least one of `reviewers` or `team_reviewers` must be provided.",
					);
				}
				const { data, headers } = await client().rest.pulls.requestReviewers({
					owner,
					repo,
					pull_number,
					reviewers,
					team_reviewers,
				});
				logRateLimit(headers);
				const users = (data.requested_reviewers ?? []).map((u) => `@${u.login}`);
				const teams = (data.requested_teams ?? []).map((t) => `@${owner}/${t.slug}`);
				const requested = [...users, ...teams];
				const list = requested.length > 0 ? requested.join(", ") : "(none)";
				return text(
					`# Reviewers requested\n\n- PR: #${pull_number} — ${data.html_url}\n- requested: ${list}`,
				);
			}),
	);
};
