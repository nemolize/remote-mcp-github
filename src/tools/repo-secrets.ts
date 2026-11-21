import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Octokit } from "octokit";
import { z } from "zod";

import {
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
import { ActionsName, RepoTarget, REST_PAGINATION, withinByteCap } from "./common.js";

type SecretsApi = Pick<
	Octokit["rest"]["codespaces"],
	"listRepoSecrets" | "getRepoPublicKey" | "createOrUpdateRepoSecret" | "deleteRepoSecret"
>;

type SecretFamily = {
	label: string;
	api: (octokit: Octokit) => SecretsApi;
	tools: { list: string; set: string; delete: string };
	access: string;
	consumer: string;
};

const FAMILIES: SecretFamily[] = [
	{
		label: "Codespaces",
		api: (octokit) => octokit.rest.codespaces,
		tools: {
			list: "list_codespaces_secrets",
			set: "set_codespaces_secret",
			delete: "delete_codespaces_secret",
		},
		access: "Listing needs read access; setting or deleting needs repository admin access.",
		consumer: "codespaces created for the repository",
	},
	{
		label: "Dependabot",
		api: (octokit) => octokit.rest.dependabot,
		tools: {
			list: "list_dependabot_secrets",
			set: "set_dependabot_secret",
			delete: "delete_dependabot_secret",
		},
		access: "Requires collaborator access to the repository.",
		consumer: "Dependabot updates for the repository",
	},
];

const registerFamily = (server: McpServer, client: OctokitFactory, f: SecretFamily): void => {
	server.registerTool(
		f.tools.list,
		{
			description: `List a repository's ${f.label} secrets — names and created/updated timestamps only; GitHub never returns secret values. Use to check whether a ${f.label} secret exists or when it last changed. ${f.access} Set or remove secrets with \`${f.tools.set}\` / \`${f.tools.delete}\`.`,
			inputSchema: { ...RepoTarget, ...REST_PAGINATION },
		},
		async ({ owner, repo, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await f
					.api(client())
					.listRepoSecrets(stripUndefined({ owner, repo, per_page, page }));
				logRateLimit(headers);
				if (data.secrets.length === 0) return text(`(no ${f.label} secrets found)`);
				const lines = data.secrets.map(
					(s) => `- **${s.name}** — created ${s.created_at}, updated ${s.updated_at}`,
				);
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: `${f.label} secrets`,
					count: data.secrets.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		f.tools.set,
		{
			description: `Create or update a repository ${f.label} secret (made available to ${f.consumer}). The value is encrypted client-side (libsodium sealed box against this family's own repository public key) before upload — GitHub never sees or returns the plaintext, and this tool echoes only the secret's name back, never its value. Use when the user asks to set / rotate a ${f.label} secret. ${f.access} Mutates repository configuration.`,
			inputSchema: {
				...RepoTarget,
				secret_name: ActionsName.describe(`Secret name (e.g. 'DEPLOY_TOKEN').`),
				value: withinByteCap(z.string().min(1)).describe(
					"Plaintext secret value (encrypted before upload; max 48 KB UTF-8).",
				),
			},
		},
		async ({ owner, repo, secret_name, value }) =>
			wrapTool(async () => {
				const api = f.api(client());
				const { data: publicKey } = await api.getRepoPublicKey({ owner, repo });
				const { headers, status } = await api.createOrUpdateRepoSecret({
					owner,
					repo,
					secret_name,
					encrypted_value: sealSecret(value, publicKey.key),
					key_id: publicKey.key_id,
				});
				logRateLimit(headers);
				logWrite({ tool: f.tools.set, owner, repo, secret_name });
				const action = status === 201 ? "created" : "updated";
				return text(
					`# ${f.label} secret ${action}\n\n- \`${secret_name}\` in ${owner}/${repo} ${action} (value encrypted client-side; not echoed back)`,
				);
			}),
	);

	server.registerTool(
		f.tools.delete,
		{
			description: `Delete a repository ${f.label} secret by name. Use when the user asks to remove a ${f.label} secret. A name that doesn't exist returns 404. ${f.access} Mutates repository configuration.`,
			inputSchema: {
				...RepoTarget,
				secret_name: ActionsName.describe("Secret name to delete."),
			},
		},
		async ({ owner, repo, secret_name }) =>
			wrapTool(async () => {
				const { headers } = await f.api(client()).deleteRepoSecret({ owner, repo, secret_name });
				logRateLimit(headers);
				logWrite({ tool: f.tools.delete, owner, repo, secret_name });
				return text(
					`# ${f.label} secret deleted\n\n- \`${secret_name}\` removed from ${owner}/${repo}`,
				);
			}),
	);
};

export const registerRepoSecretTools = (server: McpServer, client: OctokitFactory): void => {
	for (const family of FAMILIES) registerFamily(server, client, family);
};
