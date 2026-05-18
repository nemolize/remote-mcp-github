import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logRateLimit, text, truncate, wrapTool } from "../mcp/response.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";

export const registerIssueTools = (server: McpServer, client: OctokitFactory): void => {
	server.tool(
		"search_issues",
		"Search issues and pull requests inside a specific repository. Use when the user asks to find issues/PRs matching a query, filter by state, or look up bugs/features in a repo. Returns title, number, state, author, and URL for each match.",
		{
			...RepoTarget,
			query: z
				.string()
				.describe("Search keywords (GitHub search syntax). Repo qualifier is added automatically."),
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
			assignees: z.array(z.string()).optional().describe("GitHub usernames to assign."),
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
				return text(`# Issue created\n\n- **${data.title}** (#${data.number})\n- ${data.html_url}`);
			}),
	);

	server.tool(
		"add_comment",
		"Add a comment to an existing issue or pull request. Use when the user asks to comment on, reply to, or annotate an issue/PR. PRs accept comments via the same endpoint as issues. Returns the new comment's URL.",
		{
			...RepoTarget,
			issue_number: z.number().int().positive().describe("Issue or PR number to comment on."),
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
};
