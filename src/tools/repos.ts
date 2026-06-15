import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	logRateLimit,
	logWrite,
	restListHeader,
	text,
	truncate,
	wrapTool,
} from "../mcp/response.js";
import { isNonEmpty, stripUndefined } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";
import { searchHeader } from "./search-helpers.js";

/**
 * Render the post-mutation summary for a created or forked repository. Mirrors
 * the field selection of `get_repo` but keyed off a heading rather than the full
 * `# full_name` block, since these are confirmation outputs for a write.
 */
const renderRepoSummary = (
	heading: string,
	data: {
		full_name: string;
		private: boolean;
		visibility?: string;
		html_url: string;
		default_branch?: string;
		description?: string | null;
	},
	extra: string[] = [],
): string => {
	const visibility = data.visibility ?? (data.private ? "private" : "public");
	const lines = [
		`# ${heading}`,
		"",
		`- **${data.full_name}** (${visibility})`,
		isNonEmpty(data.description) ? `- ${data.description}` : null,
		`- URL: ${data.html_url}`,
		isNonEmpty(data.default_branch) ? `- Default branch: \`${data.default_branch}\`` : null,
		...extra,
	].filter((l): l is string => l != null);
	return lines.join("\n");
};

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
					const flag = r.visibility ?? (r.private ? "private" : "public");
					const desc = isNonEmpty(r.description) ? ` — ${r.description}` : "";
					return `- **${r.full_name}** (${flag})${desc}\n  - ${r.html_url} | ${r.stargazers_count} stars | updated ${r.updated_at}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: "Repositories",
					count: data.length,
					page,
					hasMore,
				});
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
				const visibility = data.visibility ?? (data.private ? "private" : "public");
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
					`- Stars: ${data.stargazers_count} | Forks: ${data.forks_count} | Open issues+PRs: ${data.open_issues_count}`,
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
				const { data, headers } = await client().rest.search.repos(
					stripUndefined({
						q: query,
						sort,
						order,
						per_page,
						page,
					}),
				);
				logRateLimit(headers);
				if (data.total_count === 0)
					return text(`# Repo search\n\nNo repositories matched \`${query}\`.`);
				const lines = data.items.map((r) => {
					const flag = r.visibility ?? (r.private ? "private" : "public");
					const desc = isNonEmpty(r.description) ? ` — ${r.description}` : "";
					const lang = isNonEmpty(r.language) ? ` | ${r.language}` : "";
					return `- **${r.full_name}** (${flag})${desc}\n  - ${r.html_url} | ${r.stargazers_count} stars${lang} | updated ${r.updated_at}`;
				});
				const header = searchHeader({
					label: "Repo search results",
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
		"create_repository",
		{
			description:
				"Create a new repository for the authenticated user, or for an organisation when `org` is given. Use when the user asks to create, make, or initialise a new repo. Returns the new repo's metadata (name, visibility, default branch, URL). Requires the `repo` OAuth scope (org repos also require membership permitting repo creation).",
			inputSchema: {
				name: z.string().min(1).max(100).describe("Repository name (without the owner prefix)."),
				org: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Organisation login to own the repo. Omit to create under the authenticated user.",
					),
				description: z.string().max(350).optional().describe("Short repo description."),
				private: z
					.boolean()
					.optional()
					.default(false)
					.describe("Create a private repository (default: public)."),
				auto_init: z
					.boolean()
					.optional()
					.default(false)
					.describe("Initialise with an empty README commit so the repo has a default branch."),
				gitignore_template: z
					.string()
					.min(1)
					.optional()
					.describe("Language `.gitignore` template name, e.g. `Node` (requires auto_init)."),
				license_template: z
					.string()
					.min(1)
					.optional()
					.describe("License keyword, e.g. `mit` (requires auto_init)."),
			},
		},
		async ({
			name,
			org,
			description,
			private: isPrivate,
			auto_init,
			gitignore_template,
			license_template,
		}) =>
			wrapTool(async () => {
				const octo = client();
				const params = stripUndefined({
					name,
					description,
					private: isPrivate,
					auto_init,
					gitignore_template,
					license_template,
				});
				const { data, headers } =
					org != null
						? await octo.rest.repos.createInOrg({ org, ...params })
						: await octo.rest.repos.createForAuthenticatedUser(params);
				logRateLimit(headers);
				logWrite({
					tool: "create_repository",
					owner: data.owner?.login,
					repo: data.name,
					...(org != null ? { org } : {}),
				});
				return text(truncate(renderRepoSummary("Repository created", data)));
			}),
	);

	server.registerTool(
		"fork_repository",
		{
			description:
				"Fork an existing repository to the authenticated user, or to an organisation when `organization` is given. Use when the user asks to fork a repo to contribute to it. Forking is asynchronous on GitHub's side — the fork may take a moment to fully populate. Returns the fork's metadata. Requires the `repo` OAuth scope.",
			inputSchema: {
				...RepoTarget,
				organization: z
					.string()
					.min(1)
					.optional()
					.describe("Organisation login to own the fork. Omit to fork to the authenticated user."),
				default_branch_only: z
					.boolean()
					.optional()
					.default(false)
					.describe("Fork only the source repo's default branch instead of all branches."),
			},
		},
		async ({ owner, repo, organization, default_branch_only }) =>
			wrapTool(async () => {
				const octo = client();
				const { data, headers } = await octo.rest.repos.createFork(
					stripUndefined({ owner, repo, organization, default_branch_only }),
				);
				logRateLimit(headers);
				logWrite({
					tool: "fork_repository",
					owner: data.owner?.login,
					repo: data.name,
					...(organization != null ? { org: organization } : {}),
				});
				const extra =
					data.parent != null
						? [`- Forked from: ${data.parent.full_name} (${data.parent.html_url})`]
						: [];
				return text(truncate(renderRepoSummary("Repository forked", data, extra)));
			}),
	);
};
