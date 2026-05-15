import { Octokit } from "octokit";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

const MAX_RESPONSE_CHARS = 8000;

const truncate = (text: string, maxChars = MAX_RESPONSE_CHARS): string => {
	if (text.length <= maxChars) return text;
	const omitted = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n... (truncated; ${omitted} more characters omitted to save context. Refine your query or paginate to see more.)`;
};

const logRateLimit = (
	headers: Record<string, string | number | undefined> | Headers,
): void => {
	const get = (k: string): string | number | null | undefined =>
		headers instanceof Headers ? headers.get(k) : headers[k];
	const remaining = get("x-ratelimit-remaining");
	const limit = get("x-ratelimit-limit");
	const reset = get("x-ratelimit-reset");
	if (remaining != null) {
		const resetIso = reset ? new Date(Number(reset) * 1000).toISOString() : "unknown";
		console.log(
			`[github-ratelimit] ${remaining}/${limit} remaining, resets at ${resetIso}`,
		);
	}
};

const text = (body: string): ToolResult => ({
	content: [{ type: "text", text: body }],
});

const errorResult = (message: string): ToolResult => ({
	content: [{ type: "text", text: `Error: ${message}` }],
	isError: true,
});

const wrapTool = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
	try {
		return await fn();
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : String(e);
		const status =
			e != null && typeof e === "object" && "status" in e
				? ` (HTTP ${(e as { status: number }).status})`
				: "";
		return errorResult(`${message}${status}`);
	}
};

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
				let base = from;
				if (!base) {
					const repoMeta = await octo.rest.repos.get({ owner, repo });
					logRateLimit(repoMeta.headers);
					base = repoMeta.data.default_branch;
				}
				const baseRef = await octo.rest.git.getRef({
					owner,
					repo,
					ref: `heads/${base}`,
				});
				logRateLimit(baseRef.headers);
				const created = await octo.rest.git.createRef({
					owner,
					repo,
					ref: `refs/heads/${branch}`,
					sha: baseRef.data.object.sha,
				});
				logRateLimit(created.headers);
				return text(
					`# Branch created\n\n- **${branch}** ← branched from \`${base}\` @ \`${baseRef.data.object.sha.slice(0, 7)}\`\n- ref: ${created.data.ref}`,
				);
			}),
	);
};
