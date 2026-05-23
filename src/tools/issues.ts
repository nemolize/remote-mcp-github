import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logRateLimit, text, truncate, wrapTool } from "../mcp/response.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";
import { searchHeader } from "./search-helpers.js";

const formatNameList = (names: string[], wrap: "code" | "at"): string => {
	if (names.length === 0) return "(none)";
	return names.map((n) => (wrap === "code" ? `\`${n}\`` : `@${n}`)).join(", ");
};

export const registerIssueTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"search_issues",
		{
			description:
				"Search issues and pull requests inside a specific repository. Use when the user asks to find issues/PRs matching a query, filter by state, or look up bugs/features in a repo. Returns title, number, state, author, and URL for each match.",
			inputSchema: {
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
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe(
						"Page number (1-indexed). Defaults to 1. GitHub caps search at 1000 reachable results.",
					),
			},
		},
		async ({ owner, repo, query, state, per_page, page }) =>
			wrapTool(async () => {
				const qualifier =
					state === "all" ? `repo:${owner}/${repo}` : `repo:${owner}/${repo} state:${state}`;
				const q = `${query} ${qualifier}`;
				const { data, headers } = await client().rest.search.issuesAndPullRequests({
					q,
					per_page,
					page,
				});
				logRateLimit(headers);
				if (data.total_count === 0)
					return text(`# Search results\n\nNo issues or PRs matched \`${q}\`.`);
				const lines = data.items.map((i) => {
					const kind = i.pull_request ? "PR" : "Issue";
					return `- [${kind} #${i.number}] **${i.title}** (${i.state}) by @${i.user?.login}\n  - ${i.html_url}`;
				});
				const header = searchHeader({
					label: "Search results",
					query: q,
					page,
					perPage: per_page,
					totalCount: data.total_count,
					shownCount: data.items.length,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"get_issue",
		{
			description:
				"Fetch a single issue's details. Use when the user asks to read, view, or inspect an issue by number. Works for pull requests too (they share the issue endpoint); the output marks the entry as a PR when applicable. Returns title, state, author, labels, assignees, milestone, timestamps, URL, and a (possibly truncated) body.",
			inputSchema: {
				...RepoTarget,
				issue_number: z.number().int().positive().describe("Issue or PR number to fetch."),
			},
		},
		async ({ owner, repo, issue_number }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.get({
					owner,
					repo,
					issue_number,
				});
				logRateLimit(headers);
				const kind = data.pull_request ? "PR" : "Issue";
				const labelNames = data.labels
					.map((l) => (typeof l === "string" ? l : (l.name ?? "")))
					.filter((n) => n.length > 0);
				const assigneeLogins = (data.assignees ?? []).map((a) => a.login);
				const milestone = data.milestone ? data.milestone.title : "(none)";
				const author = data.user ? `@${data.user.login}` : "(unknown)";
				const body = data.body != null && data.body.length > 0 ? data.body : "(no body)";
				const lines = [
					`# ${kind} #${data.number}: ${data.title}`,
					"",
					`- state: **${data.state}**${data.state_reason != null ? ` (${data.state_reason})` : ""}`,
					`- author: ${author}`,
					`- labels: ${formatNameList(labelNames, "code")}`,
					`- assignees: ${formatNameList(assigneeLogins, "at")}`,
					`- milestone: ${milestone}`,
					`- created: ${data.created_at}`,
					`- updated: ${data.updated_at}`,
					`- url: ${data.html_url}`,
					"",
					"## Body",
					"",
					body,
				];
				return text(truncate(lines.join("\n")));
			}),
	);

	server.registerTool(
		"list_issue_comments",
		{
			description:
				"List conversation comments on an issue or pull request. Use when the user asks to read the discussion, comments, or replies on an issue/PR. Returns one bullet per comment with author, timestamp, URL, and a short body preview.",
			inputSchema: {
				...RepoTarget,
				issue_number: z
					.number()
					.int()
					.positive()
					.describe("Issue or PR number whose comments to list."),
				per_page: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.default(30)
					.describe("Results per page (1-100)."),
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number (1-indexed). Defaults to 1."),
				since: z.iso
					.datetime()
					.optional()
					.describe("Only comments updated at or after this ISO 8601 timestamp."),
			},
		},
		async ({ owner, repo, issue_number, per_page, page, since }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.listComments({
					owner,
					repo,
					issue_number,
					per_page,
					page,
					since,
				});
				logRateLimit(headers);
				if (data.length === 0) return text(`# Comments on #${issue_number}\n\n(no comments found)`);
				// Each comment is rendered as a one-line preview (whitespace collapsed, 200-char cap);
				// the full-body rendering used by get_issue would blow up the list output. Callers
				// who need the full text should fetch the issue or the individual comment.
				const lines = data.map((c) => {
					const author = c.user ? `@${c.user.login}` : "(unknown)";
					const body = (c.body ?? "").replace(/\s+/g, " ").trim();
					const preview = body.length > 200 ? `${body.slice(0, 200)}…` : body;
					// Show `updated_at` — that's what `since` filters by; the created timestamp
					// is appended only when the comment has been edited.
					const ts =
						c.updated_at !== c.created_at
							? `${c.updated_at} (created ${c.created_at})`
							: c.created_at;
					return `- ${author} — ${ts} — ${c.html_url}\n  - ${preview.length > 0 ? preview : "(empty)"}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const pageNum = page ?? 1;
				const header = hasMore
					? `# Comments on #${issue_number} (page ${pageNum}, ${data.length} shown; more available — pass next \`page\` or raise \`per_page\` up to 100)`
					: `# Comments on #${issue_number} (${data.length})`;
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"list_labels",
		{
			description:
				"List labels defined in a repository. Use when the user wants to see what labels exist before assigning or filtering — companion read for `add_labels` / `update_issue`. Returns one bullet per label with name, colour, and description.",
			inputSchema: {
				...RepoTarget,
				per_page: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.default(30)
					.describe("Results per page (1-100)."),
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number (1-indexed). Defaults to 1."),
			},
		},
		async ({ owner, repo, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.listLabelsForRepo({
					owner,
					repo,
					per_page,
					page,
				});
				logRateLimit(headers);
				if (data.length === 0) return text(`# Labels in ${owner}/${repo}\n\n(no labels defined)`);
				const lines = data.map((l) => {
					const desc =
						l.description != null && l.description.length > 0 ? ` — ${l.description}` : "";
					return `- **${l.name}** (#${l.color})${desc}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const pageNum = page ?? 1;
				const header = hasMore
					? `# Labels in ${owner}/${repo} (page ${pageNum}, ${data.length} shown; more available — pass next \`page\` or raise \`per_page\` up to 100)`
					: `# Labels in ${owner}/${repo} (${data.length})`;
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"create_issue",
		{
			description:
				"Create a new GitHub issue in the specified repository. Use when the user explicitly asks to file, open, or create an issue. Requires title; body, labels, and assignees are optional. Returns the created issue's number and URL.",
			inputSchema: {
				...RepoTarget,
				title: z.string().min(1).describe("Issue title."),
				body: z.string().optional().describe("Issue body (Markdown supported)."),
				labels: z
					.array(z.string())
					.optional()
					.describe("Labels to attach (must already exist in the repo)."),
				assignees: z.array(z.string()).optional().describe("GitHub usernames to assign."),
			},
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

	server.registerTool(
		"add_comment",
		{
			description:
				"Add a comment to an existing issue or pull request. Use when the user asks to comment on, reply to, or annotate an issue/PR. PRs accept comments via the same endpoint as issues. Returns the new comment's URL.",
			inputSchema: {
				...RepoTarget,
				issue_number: z.number().int().positive().describe("Issue or PR number to comment on."),
				body: z.string().min(1).describe("Comment body (Markdown supported)."),
			},
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

	server.registerTool(
		"update_issue",
		{
			description:
				'Edit an existing issue\'s title, body, state, labels, assignees, or milestone in one call. Use when the user asks to edit, close, reopen, retitle, relabel, or reassign an issue. Pass `state: "closed"` with `state_reason` to close. Returns the issue number, new state, and URL.',
			inputSchema: {
				...RepoTarget,
				issue_number: z.number().int().positive().describe("Issue number to update."),
				title: z.string().min(1).optional().describe("New issue title."),
				body: z
					.string()
					.optional()
					.describe(
						"New issue body (Markdown supported); omit to leave unchanged, pass an empty string to clear.",
					),
				state: z.enum(["open", "closed"]).optional().describe("New issue state."),
				state_reason: z
					.enum(["completed", "not_planned", "duplicate", "reopened"])
					.nullable()
					.optional()
					.describe(
						"Reason for the state change (used when closing or reopening); pass null to clear an existing reason.",
					),
				labels: z
					.array(z.string())
					.optional()
					.describe(
						"Replaces the entire label set; omit to leave unchanged, pass `[]` to clear all labels.",
					),
				assignees: z
					.array(z.string())
					.optional()
					.describe(
						"Replaces the entire assignee set; omit to leave unchanged, pass `[]` to clear all assignees.",
					),
				milestone: z
					.number()
					.int()
					.nullable()
					.optional()
					.describe("Milestone number to set; pass null to clear."),
			},
		},
		async ({
			owner,
			repo,
			issue_number,
			title,
			body,
			state,
			state_reason,
			labels,
			assignees,
			milestone,
		}) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.update({
					owner,
					repo,
					issue_number,
					title,
					body,
					state,
					state_reason,
					labels,
					assignees,
					milestone,
				});
				logRateLimit(headers);
				return text(
					`# Issue updated\n\n- **${data.title}** (#${data.number}) — state: **${data.state}**${data.state_reason != null ? ` (${data.state_reason})` : ""}\n- ${data.html_url}`,
				);
			}),
	);

	server.registerTool(
		"add_labels",
		{
			description:
				"Append labels to an issue or PR without restating the existing set. Use when the user asks to add, attach, or tag labels — and the existing labels should be preserved. Returns the full updated label list.",
			inputSchema: {
				...RepoTarget,
				issue_number: z.number().int().positive().describe("Issue or PR number to add labels to."),
				labels: z
					.array(z.string())
					.min(1)
					.describe("Label names to append (must already exist in the repo)."),
			},
		},
		async ({ owner, repo, issue_number, labels }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.addLabels({
					owner,
					repo,
					issue_number,
					labels,
				});
				logRateLimit(headers);
				const names = data.map((l) => l.name);
				return text(
					`# Labels added\n\n- on #${issue_number}\n- labels now: ${formatNameList(names, "code")}`,
				);
			}),
	);

	server.registerTool(
		"remove_label",
		{
			description:
				"Remove a single label from an issue or PR. Use when the user asks to remove, drop, or untag a specific label. Returns the remaining label set.",
			inputSchema: {
				...RepoTarget,
				issue_number: z
					.number()
					.int()
					.positive()
					.describe("Issue or PR number to remove the label from."),
				name: z.string().min(1).describe("Label name to remove."),
			},
		},
		async ({ owner, repo, issue_number, name }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.removeLabel({
					owner,
					repo,
					issue_number,
					name,
				});
				logRateLimit(headers);
				const names = data.map((l) => l.name);
				return text(
					`# Label removed\n\n- removed \`${name}\` from #${issue_number}\n- labels now: ${formatNameList(names, "code")}`,
				);
			}),
	);

	server.registerTool(
		"add_assignees",
		{
			description:
				"Append assignees to an issue or PR without restating the existing set. Use when the user asks to add or assign people — and existing assignees should be preserved. For requesting PR reviewers, use `request_pr_review` instead. Returns the full updated assignee list.",
			inputSchema: {
				...RepoTarget,
				issue_number: z
					.number()
					.int()
					.positive()
					.describe("Issue or PR number to add assignees to."),
				assignees: z.array(z.string()).min(1).describe("GitHub usernames to assign."),
			},
		},
		async ({ owner, repo, issue_number, assignees }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.addAssignees({
					owner,
					repo,
					issue_number,
					assignees,
				});
				logRateLimit(headers);
				const logins = (data.assignees ?? []).map((a) => a.login);
				return text(
					`# Assignees added\n\n- on #${issue_number}\n- assignees now: ${formatNameList(logins, "at")}`,
				);
			}),
	);

	server.registerTool(
		"remove_assignees",
		{
			description:
				"Remove specific assignees from an issue or PR. Use when the user asks to unassign, drop, or detach assignees. Returns the remaining assignee set.",
			inputSchema: {
				...RepoTarget,
				issue_number: z
					.number()
					.int()
					.positive()
					.describe("Issue or PR number to remove assignees from."),
				assignees: z.array(z.string()).min(1).describe("GitHub usernames to remove."),
			},
		},
		async ({ owner, repo, issue_number, assignees }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.removeAssignees({
					owner,
					repo,
					issue_number,
					assignees,
				});
				logRateLimit(headers);
				const logins = (data.assignees ?? []).map((a) => a.login);
				return text(
					`# Assignees removed\n\n- from #${issue_number}\n- assignees now: ${formatNameList(logins, "at")}`,
				);
			}),
	);
};
