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
import { stripUndefined } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";

const KEY_PREVIEW_CHARS = 40;

type DeployKey = {
	id: number;
	title: string;
	key: string;
	read_only: boolean;
	verified: boolean;
	created_at: string;
};

const keyPreview = (key: string): string =>
	key.length > KEY_PREVIEW_CHARS ? `${key.slice(0, KEY_PREVIEW_CHARS)}…` : key;

const keyLine = (k: DeployKey): string =>
	`- \`${k.id}\` **${k.title}** — ${k.read_only ? "read-only" : "read/write"}, ${k.verified ? "verified" : "unverified"}, added ${k.created_at}, \`${keyPreview(k.key)}\``;

export const registerRepoDeployKeyTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"list_deploy_keys",
		{
			description:
				"List a repository's deploy keys (`gh repo deploy-key list`): one line per key with its ID, title, access level, verified state, creation date and the start of the public key. Use the `id` with `delete_deploy_key`. Requires admin rights on the repo and the `repo` OAuth scope.",
			inputSchema: {
				...RepoTarget,
				per_page: z.number().int().min(1).max(100).optional().default(30),
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
				const { data, headers } = await client().rest.repos.listDeployKeys(
					stripUndefined({ owner, repo, per_page, page }),
				);
				logRateLimit(headers);
				if (data.length === 0) {
					return text(
						page != null && page > 1 ? "(no deploy keys on this page)" : "(no deploy keys found)",
					);
				}
				const header = restListHeader({
					title: `Deploy keys of ${owner}/${repo}`,
					count: data.length,
					page,
					hasMore: (headers.link ?? "").includes('rel="next"'),
				});
				return text(truncate(`${header}\n\n${data.map(keyLine).join("\n")}`));
			}),
	);

	server.registerTool(
		"add_deploy_key",
		{
			description:
				"Add a deploy key to a repository (`gh repo deploy-key add`). `key` is the public key line (for example `ssh-ed25519 AAAA…`). Keys are read-only by default; `read_only: false` gives the key push access to the repo, so set it only when the user asks for write access. Requires admin rights on the repo and the `repo` OAuth scope.",
			inputSchema: {
				...RepoTarget,
				key: z.string().min(1).describe("The public key contents (one line)."),
				title: z.string().min(1).optional().describe("A name for the key."),
				read_only: z
					.boolean()
					.optional()
					.default(true)
					.describe(
						"If true (default) the key can only read the repo. If false it can also push — grants write access.",
					),
			},
		},
		async ({ owner, repo, key, title, read_only }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.createDeployKey(
					stripUndefined({ owner, repo, key, title, read_only }),
				);
				logRateLimit(headers);
				logWrite({ tool: "add_deploy_key", owner, repo, deploy_key_id: data.id });
				return text(truncate(`# Deploy key added\n\n${keyLine(data)}`));
			}),
	);

	server.registerTool(
		"delete_deploy_key",
		{
			description:
				"Delete a deploy key from a repository (`gh repo deploy-key delete`). Destructive — whatever authenticates with that key loses access at once, and the key cannot be restored (it must be added again). Get the `key_id` from `list_deploy_keys`. Requires admin rights on the repo and the `repo` OAuth scope.",
			inputSchema: {
				...RepoTarget,
				key_id: z
					.number()
					.int()
					.positive()
					.describe("Deploy key ID (the `id` from `list_deploy_keys`)."),
			},
		},
		async ({ owner, repo, key_id }) =>
			wrapTool(async () => {
				const { headers } = await client().rest.repos.deleteDeployKey({ owner, repo, key_id });
				logRateLimit(headers);
				logWrite({ tool: "delete_deploy_key", owner, repo, deploy_key_id: key_id });
				return text(`# Deploy key deleted\n\n- \`${key_id}\` removed from **${owner}/${repo}**.`);
			}),
	);
};
