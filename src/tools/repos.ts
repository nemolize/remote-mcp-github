import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logRateLimit, text, truncate, wrapTool } from "../mcp/response.js";
import { isNonEmpty } from "../utils.js";
import type { OctokitFactory } from "./common.js";

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
};
