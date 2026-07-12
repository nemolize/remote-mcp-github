import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	errorResult,
	logRateLimit,
	logWrite,
	restListHeader,
	text,
	truncate,
	wrapTool,
} from "../mcp/response.js";
import { sealSecret } from "../sealed-box.js";
import { stripUndefined } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { maxCharsMessage, RepoTarget } from "./common.js";

// GitHub caps a single Actions secret and a single Actions variable value at
// 48 KB. Mirror that as the app-level input cap so an oversized payload is
// rejected by schema validation with a clear message instead of an opaque 422
// after the (pointless) public-key fetch + encryption work.
export const MAX_SECRET_VALUE_LENGTH = 48_000;
export const MAX_VARIABLE_VALUE_LENGTH = 48_000;

// Same filename-or-numeric-ID polymorphism as the run tools in actions.ts.
const WorkflowId = z.union([z.number().int().positive(), z.string().min(1)]);

// Secret and variable names share GitHub's naming rule (alphanumeric + `_`,
// not starting with a digit). Validated here so a typo like `MY-SECRET` fails
// fast with the rule spelled out rather than as a remote 422.
const SecretName = z
	.string()
	.regex(
		/^[A-Za-z_][A-Za-z0-9_]*$/,
		"Name must contain only alphanumeric characters or underscores and must not start with a digit.",
	);

const REST_PAGINATION = {
	per_page: z.number().int().min(1).max(100).optional().default(30),
	page: z.number().int().min(1).optional().describe("Page number (1-indexed). Defaults to 1."),
} as const;

export const registerActionAdminTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"list_actions_secrets",
		{
			description:
				"List a repository's GitHub Actions secrets — names and created/updated timestamps only; GitHub never returns secret values. Use to check whether a secret exists or when it last changed. Requires admin access to the repository. Set or remove secrets with `set_actions_secret` / `delete_actions_secret`.",
			inputSchema: { ...RepoTarget, ...REST_PAGINATION },
		},
		async ({ owner, repo, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.actions.listRepoSecrets(
					stripUndefined({ owner, repo, per_page, page }),
				);
				logRateLimit(headers);
				if (data.secrets.length === 0) return text("(no Actions secrets found)");
				const lines = data.secrets.map(
					(s) => `- **${s.name}** — created ${s.created_at}, updated ${s.updated_at}`,
				);
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: "Actions secrets",
					count: data.secrets.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"set_actions_secret",
		{
			description:
				"Create or update a repository GitHub Actions secret. The value is encrypted client-side (libsodium sealed box against the repo's public key) before upload — GitHub never sees or returns the plaintext, and this tool echoes only the secret's name back, never its value. Use when the user asks to set / rotate an Actions secret. Requires admin access to the repository. Mutates repository configuration.",
			inputSchema: {
				...RepoTarget,
				secret_name: SecretName.describe("Secret name (e.g. 'DEPLOY_TOKEN')."),
				value: z
					.string()
					.min(1)
					.max(MAX_SECRET_VALUE_LENGTH, maxCharsMessage("value", MAX_SECRET_VALUE_LENGTH))
					.describe("Plaintext secret value (encrypted before upload; max 48 KB)."),
			},
		},
		async ({ owner, repo, secret_name, value }) =>
			wrapTool(async () => {
				const octokit = client();
				const { data: publicKey } = await octokit.rest.actions.getRepoPublicKey({ owner, repo });
				// 201 = the secret was created, 204 = an existing one was updated —
				// surfaced so "did I overwrite something?" is answerable.
				const { headers, status } = await octokit.rest.actions.createOrUpdateRepoSecret({
					owner,
					repo,
					secret_name,
					encrypted_value: sealSecret(value, publicKey.key),
					key_id: publicKey.key_id,
				});
				logRateLimit(headers);
				logWrite({ tool: "set_actions_secret", owner, repo, secret_name });
				const action = status === 201 ? "created" : "updated";
				return text(
					`# Actions secret ${action}\n\n- \`${secret_name}\` in ${owner}/${repo} ${action} (value encrypted client-side; not echoed back)`,
				);
			}),
	);

	server.registerTool(
		"delete_actions_secret",
		{
			description:
				"Delete a repository GitHub Actions secret by name. Use when the user asks to remove a secret. A name that doesn't exist returns 404. Requires admin access to the repository. Mutates repository configuration.",
			inputSchema: {
				...RepoTarget,
				secret_name: SecretName.describe("Secret name to delete."),
			},
		},
		async ({ owner, repo, secret_name }) =>
			wrapTool(async () => {
				const { headers } = await client().rest.actions.deleteRepoSecret({
					owner,
					repo,
					secret_name,
				});
				logRateLimit(headers);
				logWrite({ tool: "delete_actions_secret", owner, repo, secret_name });
				return text(
					`# Actions secret deleted\n\n- \`${secret_name}\` removed from ${owner}/${repo}`,
				);
			}),
	);

	server.registerTool(
		"list_actions_variables",
		{
			description:
				"List a repository's GitHub Actions variables (name, value, created/updated timestamps). Unlike secrets, variable values are plaintext and are returned. Use to inspect repo-level configuration values workflows read via the `vars` context. Requires admin access to the repository.",
			inputSchema: { ...RepoTarget, ...REST_PAGINATION },
		},
		async ({ owner, repo, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.actions.listRepoVariables(
					stripUndefined({ owner, repo, per_page, page }),
				);
				logRateLimit(headers);
				if (data.variables.length === 0) return text("(no Actions variables found)");
				const lines = data.variables.map(
					(v) => `- **${v.name}** = \`${v.value}\` — updated ${v.updated_at}`,
				);
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: "Actions variables",
					count: data.variables.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"get_actions_variable",
		{
			description:
				"Fetch a single repository GitHub Actions variable by name: its value and created/updated timestamps. Use when the user asks what a specific variable is set to. Requires admin access to the repository.",
			inputSchema: {
				...RepoTarget,
				name: SecretName.describe("Variable name."),
			},
		},
		async ({ owner, repo, name }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.actions.getRepoVariable({
					owner,
					repo,
					name,
				});
				logRateLimit(headers);
				const lines = [
					`# Actions variable \`${data.name}\` in ${owner}/${repo}`,
					"",
					`> value: \`${data.value}\``,
					"",
					`- created: ${data.created_at}`,
					`- updated: ${data.updated_at}`,
				];
				return text(truncate(lines.join("\n")));
			}),
	);

	server.registerTool(
		"set_actions_variable",
		{
			description:
				"Create or update a repository GitHub Actions variable (plaintext, readable by workflows via the `vars` context — use `set_actions_secret` for anything sensitive). Creates the variable if it doesn't exist, updates it otherwise. Requires admin access to the repository. Mutates repository configuration.",
			inputSchema: {
				...RepoTarget,
				name: SecretName.describe("Variable name (e.g. 'NODE_VERSION')."),
				value: z
					.string()
					.max(MAX_VARIABLE_VALUE_LENGTH, maxCharsMessage("value", MAX_VARIABLE_VALUE_LENGTH))
					.describe("Variable value (plaintext; max 48 KB)."),
			},
		},
		async ({ owner, repo, name, value }) =>
			wrapTool(async () => {
				const octokit = client();
				// Create-then-fallback keeps the common case (new variable) at one
				// request; GitHub answers 409 Conflict when the name already exists,
				// which routes to the update endpoint instead.
				let action = "created";
				try {
					const { headers } = await octokit.rest.actions.createRepoVariable({
						owner,
						repo,
						name,
						value,
					});
					logRateLimit(headers);
				} catch (e: unknown) {
					const status = e != null && typeof e === "object" && "status" in e ? e.status : null;
					if (status !== 409) throw e;
					const { headers } = await octokit.rest.actions.updateRepoVariable({
						owner,
						repo,
						name,
						value,
					});
					logRateLimit(headers);
					action = "updated";
				}
				logWrite({ tool: "set_actions_variable", owner, repo, variable_name: name });
				return text(
					`# Actions variable ${action}\n\n- \`${name}\` in ${owner}/${repo} ${action} (value: \`${value}\`)`,
				);
			}),
	);

	server.registerTool(
		"delete_actions_variable",
		{
			description:
				"Delete a repository GitHub Actions variable by name. Use when the user asks to remove a variable. A name that doesn't exist returns 404. Requires admin access to the repository. Mutates repository configuration.",
			inputSchema: {
				...RepoTarget,
				name: SecretName.describe("Variable name to delete."),
			},
		},
		async ({ owner, repo, name }) =>
			wrapTool(async () => {
				const { headers } = await client().rest.actions.deleteRepoVariable({
					owner,
					repo,
					name,
				});
				logRateLimit(headers);
				logWrite({ tool: "delete_actions_variable", owner, repo, variable_name: name });
				return text(`# Actions variable deleted\n\n- \`${name}\` removed from ${owner}/${repo}`);
			}),
	);

	server.registerTool(
		"list_actions_caches",
		{
			description:
				"List a repository's GitHub Actions caches (one line per cache: ID, key, ref, size, last-accessed time). Use to see what `actions/cache` has stored or to find a cache to evict with `delete_actions_cache`. Filter by `key` (prefix match) and `ref`. Requires write access to the repository.",
			inputSchema: {
				...RepoTarget,
				key: z.string().optional().describe("Only caches whose key matches this prefix."),
				ref: z
					.string()
					.optional()
					.describe(
						"Only caches for this fully-qualified ref (e.g. 'refs/heads/main' or 'refs/pull/123/merge').",
					),
				sort: z
					.enum(["created_at", "last_accessed_at", "size_in_bytes"])
					.optional()
					.describe("Sort field. Defaults to last_accessed_at."),
				direction: z.enum(["asc", "desc"]).optional().describe("Sort direction. Defaults to desc."),
				...REST_PAGINATION,
			},
		},
		async ({ owner, repo, key, ref, sort, direction, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.actions.getActionsCacheList(
					stripUndefined({ owner, repo, key, ref, sort, direction, per_page, page }),
				);
				logRateLimit(headers);
				if (data.actions_caches.length === 0) return text("(no Actions caches found)");
				const lines = data.actions_caches.map((c) => {
					const size =
						c.size_in_bytes != null ? `${(c.size_in_bytes / 1048576).toFixed(1)} MiB` : "?";
					return `- \`${c.id ?? "?"}\` **${c.key ?? "(no key)"}** — ${size} on \`${c.ref ?? "?"}\`, last accessed ${c.last_accessed_at ?? "(unknown)"}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: "Actions caches",
					count: data.actions_caches.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"delete_actions_cache",
		{
			description:
				"Delete GitHub Actions caches — either one cache by `cache_id` (from `list_actions_caches`), or every cache matching a full `key` (optionally narrowed to one `ref`). Provide exactly one of `cache_id` / `key`. Use to evict a stale or poisoned cache so the next run rebuilds it. Requires write access to the repository. Mutates repository state.",
			inputSchema: {
				...RepoTarget,
				cache_id: z.number().int().positive().optional().describe("Cache ID to delete."),
				key: z
					.string()
					.min(1)
					.optional()
					.describe("Delete all caches with exactly this key (across refs unless `ref` is given)."),
				ref: z
					.string()
					.optional()
					.describe("With `key`: only delete that key's cache on this fully-qualified ref."),
			},
		},
		async ({ owner, repo, cache_id, key, ref }) =>
			wrapTool(async () => {
				if (cache_id != null && key != null) {
					return errorResult("Provide exactly one of `cache_id` or `key`, not both.");
				}
				const octokit = client();
				if (cache_id != null) {
					const { headers } = await octokit.rest.actions.deleteActionsCacheById({
						owner,
						repo,
						cache_id,
					});
					logRateLimit(headers);
					logWrite({ tool: "delete_actions_cache", owner, repo, cache_id });
					return text(
						`# Actions cache deleted\n\n- cache \`${cache_id}\` removed from ${owner}/${repo}`,
					);
				}
				if (key == null) {
					return errorResult("Provide exactly one of `cache_id` or `key`.");
				}
				const { data, headers } = await octokit.rest.actions.deleteActionsCacheByKey(
					stripUndefined({ owner, repo, key, ref }),
				);
				logRateLimit(headers);
				logWrite({ tool: "delete_actions_cache", owner, repo, cache_key: key });
				const count = data.total_count ?? data.actions_caches?.length ?? 0;
				return text(
					`# Actions cache deleted\n\n- ${count} cache(s) with key \`${key}\`${ref != null ? ` on \`${ref}\`` : ""} removed from ${owner}/${repo}`,
				);
			}),
	);

	server.registerTool(
		"enable_workflow",
		{
			description:
				"Enable a disabled GitHub Actions workflow so its triggers fire again. Identify the workflow by filename (e.g. 'ci.yml') or numeric ID (see `list_workflows`, which shows each workflow's state). Enabling an already-active workflow is a no-op. Mutates repository configuration.",
			inputSchema: {
				...RepoTarget,
				workflow_id: WorkflowId.describe("Workflow filename (e.g. 'ci.yml') or numeric ID."),
			},
		},
		async ({ owner, repo, workflow_id }) =>
			wrapTool(async () => {
				const { headers } = await client().rest.actions.enableWorkflow({
					owner,
					repo,
					workflow_id,
				});
				logRateLimit(headers);
				logWrite({ tool: "enable_workflow", owner, repo, workflow_id });
				return text(
					`# Workflow enabled\n\n- \`${workflow_id}\` in ${owner}/${repo} is active; its triggers fire again (confirm state with \`list_workflows\`)`,
				);
			}),
	);

	server.registerTool(
		"disable_workflow",
		{
			description:
				"Disable a GitHub Actions workflow: its triggers (push, schedule, workflow_dispatch, …) stop firing until re-enabled with `enable_workflow`. Identify the workflow by filename (e.g. 'ci.yml') or numeric ID (see `list_workflows`). Use when the user asks to pause / turn off a workflow. Mutates repository configuration.",
			inputSchema: {
				...RepoTarget,
				workflow_id: WorkflowId.describe("Workflow filename (e.g. 'ci.yml') or numeric ID."),
			},
		},
		async ({ owner, repo, workflow_id }) =>
			wrapTool(async () => {
				const { headers } = await client().rest.actions.disableWorkflow({
					owner,
					repo,
					workflow_id,
				});
				logRateLimit(headers);
				logWrite({ tool: "disable_workflow", owner, repo, workflow_id });
				return text(
					`# Workflow disabled\n\n- \`${workflow_id}\` in ${owner}/${repo} no longer runs on its triggers; re-activate with \`enable_workflow\``,
				);
			}),
	);
};
