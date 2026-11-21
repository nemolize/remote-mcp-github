import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logRateLimit, logWrite, text, truncate, wrapTool } from "../mcp/response.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";

type Autolink = {
	id: number;
	key_prefix: string;
	url_template: string;
	is_alphanumeric: boolean;
};

const autolinkLine = (a: Autolink): string =>
	`- \`${a.id}\` \`${a.key_prefix}\` → ${a.url_template} (${a.is_alphanumeric ? "alphanumeric" : "numeric"})`;

const AutolinkId = z
	.number()
	.int()
	.positive()
	.describe("Autolink ID (the `id` from `list_autolinks`).");

export const registerRepoAutolinkTools = (server: McpServer, client: OctokitFactory): void => {
	// GitHub documents no `page` / `per_page` for this endpoint, so the list is one
	// response; `truncate` bounds it and keeps the count line first.
	server.registerTool(
		"list_autolinks",
		{
			description:
				"List a repository's custom autolink references (`gh repo autolink list`): one line per autolink with its ID, key prefix, URL template and whether it matches alphanumeric or numeric references. Requires admin rights on the repo and the `repo` OAuth scope.",
			inputSchema: { ...RepoTarget },
		},
		async ({ owner, repo }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.listAutolinks({ owner, repo });
				logRateLimit(headers);
				if (data.length === 0) return text("(no autolinks found)");
				return text(
					truncate(
						`# Autolinks of ${owner}/${repo} (${data.length})\n\n${data.map(autolinkLine).join("\n")}`,
					),
				);
			}),
	);

	server.registerTool(
		"get_autolink",
		{
			description:
				"Show one autolink reference (`gh repo autolink view`): ID, key prefix, URL template and reference type. Get the `autolink_id` from `list_autolinks`. Requires admin rights on the repo and the `repo` OAuth scope.",
			inputSchema: { ...RepoTarget, autolink_id: AutolinkId },
		},
		async ({ owner, repo, autolink_id }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.getAutolink({
					owner,
					repo,
					autolink_id,
				});
				logRateLimit(headers);
				return text(truncate(`# Autolink\n\n${autolinkLine(data)}`));
			}),
	);

	server.registerTool(
		"create_autolink",
		{
			description:
				"Create a custom autolink reference (`gh repo autolink create`): any `key_prefix` followed by a reference (for example `TICKET-123`) in an issue, pull request or commit becomes a link to `url_template`. `url_template` must contain `<num>`, replaced by the reference number. `is_alphanumeric` (default true) lets `<num>` match `A-Z`, `0-9` and `-`; false limits it to digits. Requires admin rights on the repo and the `repo` OAuth scope.",
			inputSchema: {
				...RepoTarget,
				key_prefix: z.string().min(1).describe("Prefix that triggers the link, e.g. `TICKET-`."),
				url_template: z
					.string()
					.min(1)
					.describe(
						"Target URL containing `<num>`, e.g. `https://example.com/TICKET?query=<num>`.",
					),
				is_alphanumeric: z
					.boolean()
					.optional()
					.default(true)
					.describe("If true (default) `<num>` matches A-Z, 0-9 and `-`; if false, digits only."),
			},
		},
		async ({ owner, repo, key_prefix, url_template, is_alphanumeric }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.createAutolink({
					owner,
					repo,
					key_prefix,
					url_template,
					is_alphanumeric,
				});
				logRateLimit(headers);
				logWrite({ tool: "create_autolink", owner, repo, autolink_id: data.id });
				return text(truncate(`# Autolink created\n\n${autolinkLine(data)}`));
			}),
	);

	server.registerTool(
		"delete_autolink",
		{
			description:
				"Delete a custom autolink reference (`gh repo autolink delete`). Destructive — matching references stop being linked in issues, pull requests and commits, and the autolink cannot be restored (recreate it with `create_autolink`). Get the `autolink_id` from `list_autolinks`. Requires admin rights on the repo and the `repo` OAuth scope.",
			inputSchema: { ...RepoTarget, autolink_id: AutolinkId },
		},
		async ({ owner, repo, autolink_id }) =>
			wrapTool(async () => {
				const { headers } = await client().rest.repos.deleteAutolink({ owner, repo, autolink_id });
				logRateLimit(headers);
				logWrite({ tool: "delete_autolink", owner, repo, autolink_id });
				return text(
					`# Autolink deleted\n\n- \`${autolink_id}\` removed from **${owner}/${repo}**.`,
				);
			}),
	);
};
