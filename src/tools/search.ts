import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logRateLimit, text, truncate, wrapTool } from "../mcp/response.js";
import type { OctokitFactory } from "./common.js";

export const registerSearchTools = (server: McpServer, client: OctokitFactory): void => {
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
				if (data.total_count === 0) return text(`# Code search\n\nNo matches for \`${query}\`.`);
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
};
