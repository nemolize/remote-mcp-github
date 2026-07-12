import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logRateLimit, text, truncate, wrapTool } from "../mcp/response.js";
import { isNonEmpty, stripUndefined } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { searchHeader } from "./search-helpers.js";

// Strip every occurrence of `key:<v>` (and its negation `-key:<v>`) for each
// listed conflict value, so a forced scope isn't fought by a caller-supplied
// contradictory qualifier. Only listed values are stripped: other values on the
// same axis (e.g. `is:open` / `is:merged` alongside a forced `is:pr`) are left
// intact.
const stripQualifierValues = (query: string, key: string, values: readonly string[]): string => {
	const pattern = new RegExp(`(?:^|\\s)-?${key}:(?:${values.join("|")})(?=\\s|$)`, "gi");
	return query.replace(pattern, " ").replace(/\s+/g, " ").trim();
};

// `type:` accepts only `user` / `org` on the Search API. The endpoint mixes
// both by default, so each search_users / search_orgs must force its own
// scope to keep the tools non-overlapping.
const forceUserType = (query: string): string => {
	const stripped = stripQualifierValues(query, "type", ["user", "org"]);
	return stripped === "" ? "type:user" : `type:user ${stripped}`;
};

const forceOrgType = (query: string): string => {
	const stripped = stripQualifierValues(query, "type", ["user", "org"]);
	return stripped === "" ? "type:org" : `type:org ${stripped}`;
};

// `is:` accepts many values (`open`, `closed`, `merged`, `draft`, `locked`, …)
// but only `pr` / `issue` are mutually exclusive with the type distinction —
// strip just those and preserve the rest so callers can still filter by state.
const forcePrIs = (query: string): string => {
	const stripped = stripQualifierValues(query, "is", ["pr", "issue"]);
	return stripped === "" ? "is:pr" : `is:pr ${stripped}`;
};

export const registerSearchTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"search_code",
		{
			description:
				"Search source code across GitHub (or scoped to a specific repository / owner). Use when the user asks to find usages, patterns, or function definitions in code. Returns file path, repo, and a permalink for each match.",
			inputSchema: {
				query: z
					.string()
					.describe(
						"GitHub code-search query. Combine with qualifiers like 'repo:owner/name', 'language:ts', 'path:src/**'.",
					),
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
		async ({ query, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.search.code({
					q: query,
					per_page,
					page,
				});
				logRateLimit(headers);
				if (data.total_count === 0) return text(`# Code search\n\nNo matches for \`${query}\`.`);
				const lines = data.items.map(
					(i) => `- **${i.repository.full_name}** — \`${i.path}\`\n  - ${i.html_url}`,
				);
				const header = searchHeader({
					label: "Code search results",
					query,
					page,
					perPage: per_page,
					totalCount: data.total_count,
					shownCount: data.items.length,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"search_users",
		{
			description:
				'Search GitHub users via the Search API. `type:user` is forced automatically so results never mix in organizations — use `search_orgs` for those. Combine with qualifiers like `fullname:"jane doe"`, `location:tokyo`, `language:go`, `followers:>100`.',
			inputSchema: {
				query: z
					.string()
					.min(1)
					.describe(
						"GitHub user-search query. `type:user` is prepended automatically. Combine with qualifiers like 'fullname:\"Jane Doe\"', 'location:tokyo', 'language:go', 'followers:>100'.",
					),
				sort: z
					.enum(["followers", "repositories", "joined"])
					.optional()
					.describe("Sort field. Default: best-match (relevance)."),
				order: z.enum(["asc", "desc"]).optional().describe("Sort order. Default: desc."),
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
		async ({ query, sort, order, per_page, page }) =>
			wrapTool(async () => {
				const q = forceUserType(query);
				const { data, headers } = await client().rest.search.users(
					stripUndefined({
						q,
						sort,
						order,
						per_page,
						page,
					}),
				);
				logRateLimit(headers);
				if (data.total_count === 0) return text(`# User search\n\nNo users matched \`${q}\`.`);
				const lines = data.items.map((u) => `- **@${u.login}** — ${u.html_url}`);
				const header = searchHeader({
					label: "User search results",
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
		"search_orgs",
		{
			description:
				"Search GitHub organizations via the Search API. `type:org` is forced automatically; the user's query need only carry ordinary qualifiers (`location:tokyo`, `repos:>100`). Returns login and profile URL for each match. For user searches, use `search_users`.",
			inputSchema: {
				query: z
					.string()
					.min(1)
					.describe(
						"GitHub org-search query. `type:org` is prepended automatically. Combine with qualifiers like 'location:tokyo', 'repos:>100'.",
					),
				sort: z
					.enum(["followers", "repositories", "joined"])
					.optional()
					.describe("Sort field. Default: best-match (relevance)."),
				order: z.enum(["asc", "desc"]).optional().describe("Sort order. Default: desc."),
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
		async ({ query, sort, order, per_page, page }) =>
			wrapTool(async () => {
				const q = forceOrgType(query);
				const { data, headers } = await client().rest.search.users(
					stripUndefined({
						q,
						sort,
						order,
						per_page,
						page,
					}),
				);
				logRateLimit(headers);
				if (data.total_count === 0)
					return text(`# Org search\n\nNo organizations matched \`${q}\`.`);
				const lines = data.items.map((u) => `- **@${u.login}** — ${u.html_url}`);
				const header = searchHeader({
					label: "Org search results",
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
		"search_pull_requests",
		{
			description:
				"Search pull requests across GitHub (or scoped to a repo/owner). Companion to `search_issues` (which returns issues + PRs mixed): `is:pr` is forced automatically and results are rendered with PR-appropriate fields (state / draft / merged). Use qualifiers like `repo:owner/name`, `author:<login>`, `review-requested:@me`, `is:open`.",
			inputSchema: {
				query: z
					.string()
					.min(1)
					.describe(
						"GitHub PR-search query. `is:pr` is prepended automatically. Combine with qualifiers like 'repo:owner/name is:open author:<login>'.",
					),
				sort: z
					.enum(["comments", "reactions", "created", "updated"])
					.optional()
					.describe("Sort field. Default: best-match (relevance)."),
				order: z.enum(["asc", "desc"]).optional().describe("Sort order. Default: desc."),
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
		async ({ query, sort, order, per_page, page }) =>
			wrapTool(async () => {
				const q = forcePrIs(query);
				const { data, headers } = await client().rest.search.issuesAndPullRequests(
					stripUndefined({
						q,
						sort,
						order,
						per_page,
						page,
					}),
				);
				logRateLimit(headers);
				if (data.total_count === 0)
					return text(`# PR search\n\nNo pull requests matched \`${q}\`.`);
				const lines = data.items.map((i) => {
					// `repository_url` is `https://api.<host>/repos/<owner>/<repo>` — strip the
					// prefix up to and including `/repos/` for a portable `<owner>/<repo>`.
					const repo = i.repository_url?.replace(/^.*\/repos\//, "") ?? "";
					const repoLabel = isNonEmpty(repo) ? `${repo} ` : "";
					// The search response marks a PR as merged by populating `pull_request.merged_at`;
					// a draft PR carries `draft: true`. Precedence: merged wins over draft/state.
					const state = isNonEmpty(i.pull_request?.merged_at)
						? "merged"
						: i.draft === true
							? "draft"
							: i.state;
					const author = i.user ? `@${i.user.login}` : "(unknown)";
					return `- [PR ${repoLabel}#${i.number}] **${i.title}** (${state}) by ${author}\n  - ${i.html_url}`;
				});
				const header = searchHeader({
					label: "PR search results",
					query: q,
					page,
					perPage: per_page,
					totalCount: data.total_count,
					shownCount: data.items.length,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);
};
