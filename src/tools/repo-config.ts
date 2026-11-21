import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveDefaultBranch } from "../github/helpers.js";
import { errorResult, logRateLimit, logWrite, text, truncate, wrapTool } from "../mcp/response.js";
import { isNonEmpty, stripUndefined } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";
import { renderRepoSummary } from "./repos.js";

const UpdateFields = {
	description: z
		.string()
		.max(350)
		.optional()
		.describe("Short repo description. Pass an empty string to clear it."),
	homepage: z.string().optional().describe("Repo homepage URL. Pass an empty string to clear it."),
	visibility: z
		.enum(["public", "private"])
		.optional()
		.describe("Change visibility. Making a private repo public exposes its code and history."),
	default_branch: z.string().min(1).optional().describe("Default branch name."),
	has_issues: z.boolean().optional().describe("Enable or disable Issues."),
	has_wiki: z.boolean().optional().describe("Enable or disable the wiki."),
	has_projects: z.boolean().optional().describe("Enable or disable repository Projects."),
	has_discussions: z.boolean().optional().describe("Enable or disable Discussions."),
	is_template: z.boolean().optional().describe("Mark or unmark the repo as a template."),
	allow_squash_merge: z.boolean().optional().describe("Allow squash-merging pull requests."),
	allow_merge_commit: z.boolean().optional().describe("Allow merge commits on pull requests."),
	allow_rebase_merge: z.boolean().optional().describe("Allow rebase-merging pull requests."),
	allow_auto_merge: z.boolean().optional().describe("Allow auto-merge on pull requests."),
	delete_branch_on_merge: z
		.boolean()
		.optional()
		.describe("Delete head branches automatically after a pull request merges."),
	allow_update_branch: z
		.boolean()
		.optional()
		.describe("Always suggest updating a pull request's branch."),
};

const splitApplied = (
	sent: Record<string, unknown>,
	got: Record<string, unknown>,
): { applied: string[]; notApplied: string[] } => {
	const applied: string[] = [];
	const notApplied: string[] = [];
	for (const [key, value] of Object.entries(sent)) {
		const returned = got[key];
		if (returned === value || (value === "" && returned == null)) applied.push(key);
		else
			notApplied.push(
				`${key} (sent ${JSON.stringify(value)}, GitHub returned ${JSON.stringify(returned ?? null)})`,
			);
	}
	return { applied, notApplied };
};

export const registerRepoConfigTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"update_repository",
		{
			description:
				"Edit a repository's settings: description, homepage, visibility, default branch, feature flags (issues / wiki / projects / discussions / template) and merge options. Send only the fields to change; at least one is required. Changing `visibility` to public exposes the repo's code and history. Use `rename_repository` to rename and `archive_repository` to archive. Requires admin rights on the repo and the `repo` OAuth scope.",
			inputSchema: { ...RepoTarget, ...UpdateFields },
		},
		async ({ owner, repo, ...fields }) =>
			wrapTool(async () => {
				const changes = stripUndefined(fields);
				const names = Object.keys(changes);
				if (names.length === 0) {
					return errorResult("update_repository needs at least one field to change.");
				}
				const { data, headers } = await client().rest.repos.update({ owner, repo, ...changes });
				logRateLimit(headers);
				logWrite({ tool: "update_repository", owner, repo, updated_fields: names.join(",") });
				const { applied, notApplied } = splitApplied(changes, data);
				const extra = [
					applied.length > 0 ? `- Applied: ${applied.join(", ")}` : null,
					notApplied.length > 0 ? `- Not applied by GitHub: ${notApplied.join("; ")}` : null,
				].filter((l): l is string => l != null);
				return text(truncate(renderRepoSummary("Repository updated", data, extra)));
			}),
	);

	server.registerTool(
		"rename_repository",
		{
			description:
				"Rename `owner/repo` to `new_name`. Disruptive — GitHub redirects the old web and git URLs, but references to the old name elsewhere (for example GitHub Pages sites or external integrations that store the name) are not redirected. Requires admin rights on the repo and the `repo` OAuth scope.",
			inputSchema: {
				...RepoTarget,
				new_name: z.string().min(1).max(100).describe("New repository name (without the owner)."),
			},
		},
		async ({ owner, repo, new_name }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.update({ owner, repo, name: new_name });
				logRateLimit(headers);
				logWrite({ tool: "rename_repository", owner, repo, new_name: data.name });
				return text(
					truncate(
						renderRepoSummary("Repository renamed", data, [`- Previous name: ${owner}/${repo}`]),
					),
				);
			}),
	);

	for (const archive of [true, false]) {
		const tool = archive ? "archive_repository" : "unarchive_repository";
		server.registerTool(
			tool,
			{
				description: archive
					? "Archive `owner/repo`, making it read-only: no pushes, issues, pull requests or comments until it is unarchived with `unarchive_repository`. Requires admin rights on the repo and the `repo` OAuth scope."
					: "Unarchive `owner/repo`, making it writable again. Use after `archive_repository`. Requires admin rights on the repo and the `repo` OAuth scope.",
				inputSchema: { ...RepoTarget },
			},
			async ({ owner, repo }) =>
				wrapTool(async () => {
					const { data, headers } = await client().rest.repos.update({
						owner,
						repo,
						archived: archive,
					});
					logRateLimit(headers);
					logWrite({ tool, owner, repo });
					return text(
						truncate(
							renderRepoSummary(archive ? "Repository archived" : "Repository unarchived", data, [
								`- Archived: ${data.archived}`,
							]),
						),
					);
				}),
		);
	}

	server.registerTool(
		"sync_fork",
		{
			description:
				"Sync a fork's branch with its upstream repository (`gh repo sync`): brings the fork's branch up to date with the upstream branch of the same name. Fails with GitHub's conflict error when the branch cannot be synced cleanly, and with a validation error when the repo is not a fork. Requires the `repo` OAuth scope.",
			inputSchema: {
				...RepoTarget,
				branch: z
					.string()
					.min(1)
					.optional()
					.describe("Branch to sync. Defaults to the fork's default branch."),
			},
		},
		async ({ owner, repo, branch }) =>
			wrapTool(async () => {
				const octo = client();
				const target = branch ?? (await resolveDefaultBranch(octo, owner, repo));
				const { data, headers } = await octo.rest.repos.mergeUpstream({
					owner,
					repo,
					branch: target,
				});
				logRateLimit(headers);
				logWrite({ tool: "sync_fork", owner, repo, branch: target });
				const lines = [
					"# Fork synced",
					"",
					`- **${owner}/${repo}** branch \`${target}\``,
					isNonEmpty(data.base_branch) ? `- Upstream: \`${data.base_branch}\`` : null,
					isNonEmpty(data.merge_type) ? `- Merge type: ${data.merge_type}` : null,
					isNonEmpty(data.message) ? `- ${data.message}` : null,
				].filter((l): l is string => l != null);
				return text(truncate(lines.join("\n")));
			}),
	);
};
