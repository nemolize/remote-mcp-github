import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logRateLimit, text, truncate, wrapTool } from "../mcp/response.js";
import { isNonEmpty } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";

export const registerRepoTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"list_my_repos",
		{
			description:
				"List repositories owned by or accessible to the authenticated GitHub user. Use when the user asks to see, browse, enumerate, or find their own repositories. Returns repo full name, visibility, description, URL, star count, and last-update timestamp.",
			inputSchema: {
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
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number (1-indexed). Defaults to 1."),
			},
		},
		async ({ visibility, sort, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.listForAuthenticatedUser({
					visibility,
					sort,
					per_page,
					page,
				});
				logRateLimit(headers);
				if (data.length === 0) return text("(no repositories found)");
				const lines = data.map((r) => {
					const flag = r.private ? "private" : "public";
					const desc = isNonEmpty(r.description) ? ` — ${r.description}` : "";
					return `- **${r.full_name}** (${flag})${desc}\n  - ${r.html_url} | ${r.stargazers_count} stars | updated ${r.updated_at}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const pageNum = page ?? 1;
				const header = hasMore
					? `# Repositories (page ${pageNum}, ${data.length} shown; more available — pass next \`page\` or raise \`per_page\` up to 100)`
					: `# Repositories (${data.length})`;
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"get_repo",
		{
			description:
				"Fetch metadata for a single repository: description, visibility, default branch, archived/fork flags, primary language, star/fork counts, and timestamps. Use when the user asks about a repo's properties, default branch, or archival status, or when other tools would benefit from a single canonical lookup.",
			inputSchema: { ...RepoTarget },
		},
		async ({ owner, repo }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.get({ owner, repo });
				logRateLimit(headers);
				const visibility = data.private ? "private" : "public";
				const flags = [
					data.archived ? "archived" : null,
					data.fork ? "fork" : null,
					data.disabled ? "disabled" : null,
					data.is_template === true ? "template" : null,
				].filter((f): f is string => f != null);
				const lines = [
					`# ${data.full_name} (${visibility})`,
					"",
					isNonEmpty(data.description) ? `> ${data.description}` : "> (no description)",
					"",
					`- URL: ${data.html_url}`,
					`- Default branch: \`${data.default_branch}\``,
					`- Language: ${data.language ?? "(unknown)"}`,
					`- Stars: ${data.stargazers_count} | Forks: ${data.forks_count} | Open issues: ${data.open_issues_count}`,
					`- has_issues: ${data.has_issues} | has_wiki: ${data.has_wiki} | has_projects: ${data.has_projects} | has_discussions: ${data.has_discussions ?? false}`,
					`- Pushed: ${data.pushed_at} | Updated: ${data.updated_at} | Created: ${data.created_at}`,
				];
				if (flags.length > 0) lines.push(`- Flags: ${flags.join(", ")}`);
				if (data.fork && data.parent != null) {
					lines.push(`- Forked from: ${data.parent.full_name} (${data.parent.html_url})`);
				}
				if (isNonEmpty(data.homepage)) lines.push(`- Homepage: ${data.homepage}`);
				if (isNonEmpty(data.license?.name)) lines.push(`- License: ${data.license.name}`);
				return text(truncate(lines.join("\n")));
			}),
	);

	server.registerTool(
		"get_authenticated_user",
		{
			description:
				"Return the GitHub identity bound to the current OAuth token (login, name, public profile fields, repo counts). Use when the user asks 'who am I?' or when other tools need the authenticated user's login to construct a `user:<login>` search qualifier (the GitHub Search API does not resolve `@me` — pass the actual login from this tool's response).",
			inputSchema: {},
		},
		async () =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.users.getAuthenticated();
				logRateLimit(headers);
				const lines = [
					`# @${data.login}`,
					"",
					isNonEmpty(data.name) ? `- Name: ${data.name}` : null,
					isNonEmpty(data.email) ? `- Email: ${data.email}` : null,
					isNonEmpty(data.bio) ? `- Bio: ${data.bio}` : null,
					isNonEmpty(data.company) ? `- Company: ${data.company}` : null,
					isNonEmpty(data.location) ? `- Location: ${data.location}` : null,
					`- Profile: ${data.html_url}`,
					`- Public repos: ${data.public_repos} | Public gists: ${data.public_gists}`,
					data.total_private_repos != null
						? `- Total private repos: ${data.total_private_repos}`
						: null,
					data.owned_private_repos != null
						? `- Owned private repos: ${data.owned_private_repos}`
						: null,
					`- Followers: ${data.followers} | Following: ${data.following}`,
					`- Created: ${data.created_at}`,
				].filter((l): l is string => l != null);
				return text(truncate(lines.join("\n")));
			}),
	);

	server.registerTool(
		"search_repositories",
		{
			description:
				"Search repositories across GitHub using the Search API. Use when the user asks to find repos beyond their own (e.g. collaborator-only access, public org repos, popular projects). Supports GitHub search qualifiers like `org:foo`, `user:<login>`, `language:ts`, `stars:>100`, `fork:true`. For 'my own repos' intents, call `get_authenticated_user` first to retrieve the login (the Search API does not resolve `@me`).",
			inputSchema: {
				query: z
					.string()
					.min(1)
					.describe(
						"GitHub repo-search query. Combine with qualifiers like 'org:foo language:ts stars:>100' or 'user:<login>'.",
					),
				sort: z
					.enum(["stars", "forks", "help-wanted-issues", "updated"])
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
				const { data, headers } = await client().rest.search.repos({
					q: query,
					sort,
					order,
					per_page,
					page,
				});
				logRateLimit(headers);
				if (data.total_count === 0)
					return text(`# Repo search\n\nNo repositories matched \`${query}\`.`);
				const lines = data.items.map((r) => {
					const flag = r.private ? "private" : "public";
					const desc = isNonEmpty(r.description) ? ` — ${r.description}` : "";
					const lang = isNonEmpty(r.language) ? ` | ${r.language}` : "";
					return `- **${r.full_name}** (${flag})${desc}\n  - ${r.html_url} | ${r.stargazers_count} stars${lang} | updated ${r.updated_at}`;
				});
				const pageNum = page ?? 1;
				// GitHub's Search API caps reachable results at 1000; pageNum * per_page
				// against that cap (not total_count alone) avoids a false "more" hint
				// on the final page when items.length happens to be less than total_count.
				const hasMore = pageNum * per_page < Math.min(data.total_count, 1000);
				const header = hasMore
					? `# Repo search results for \`${query}\` (page ${pageNum}, showing ${data.items.length} of ${data.total_count}; pass next \`page\` for more)`
					: `# Repo search results for \`${query}\` (showing ${data.items.length} of ${data.total_count})`;
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);
};
