import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logRateLimit, text, truncate, wrapTool } from "../mcp/response.js";
import type { OctokitFactory } from "./common.js";

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
				const pageNum = page ?? 1;
				// GitHub's Search API caps reachable results at 1000; pageNum * per_page
				// against that cap (not total_count alone) avoids a false "more" hint
				// on the final page when items.length happens to be less than total_count.
				const hasMore = pageNum * per_page < Math.min(data.total_count, 1000);
				const header = hasMore
					? `# Code search results for \`${query}\` (page ${pageNum}, showing ${data.items.length} of ${data.total_count}; pass next \`page\` for more)`
					: `# Code search results for \`${query}\` (showing ${data.items.length} of ${data.total_count})`;
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);
};
