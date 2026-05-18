import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	getBranchHeadSha,
	resolveDefaultBranch,
} from "../github/helpers.js";
import { errorResult, logRateLimit, text, wrapTool } from "../mcp/response.js";
import { OctokitFactory, RepoTarget, SameRepoBranchPattern } from "./common.js";

export const registerBranchTools = (
	server: McpServer,
	client: OctokitFactory,
): void => {
	server.tool(
		"create_branch",
		"Create a new branch in a repository, pointing at the tip of a base branch (default: the repo's default branch). Use when the user asks to branch off, start a new feature branch, or fork the current state. Returns the new ref name and SHA.",
		{
			...RepoTarget,
			branch: z
				.string()
				.min(1)
				.regex(SameRepoBranchPattern, "Use a same-repo branch name.")
				.describe("New branch name (without 'refs/heads/' prefix)."),
			from: z
				.string()
				.optional()
				.describe("Base branch name to branch from. Defaults to the repo's default branch."),
		},
		async ({ owner, repo, branch, from }) =>
			wrapTool(async () => {
				const octo = client();
				const base = from ?? (await resolveDefaultBranch(octo, owner, repo));
				const baseSha = await getBranchHeadSha(octo, owner, repo, base);
				const created = await octo.rest.git.createRef({
					owner,
					repo,
					ref: `refs/heads/${branch}`,
					sha: baseSha,
				});
				logRateLimit(created.headers);
				return text(
					`# Branch created\n\n- **${branch}** ← branched from \`${base}\` @ \`${baseSha.slice(0, 7)}\`\n- ref: ${created.data.ref}`,
				);
			}),
	);

	server.tool(
		"delete_branch",
		"Delete a branch from a repository. Use when the user asks to delete, remove, or clean up a branch. Refuses to delete the repo's default branch. Returns the deleted branch name and the SHA it pointed at (useful if the caller needs to recreate the ref).",
		{
			...RepoTarget,
			branch: z
				.string()
				.min(1)
				.regex(SameRepoBranchPattern, "Use a same-repo branch name.")
				.describe("Branch name to delete (without 'refs/heads/' prefix)."),
		},
		async ({ owner, repo, branch }) =>
			wrapTool(async () => {
				const octo = client();
				const defaultBranch = await resolveDefaultBranch(octo, owner, repo);
				if (branch === defaultBranch) {
					return errorResult(
						`Refusing to delete the repo's default branch \`${branch}\`.`,
					);
				}
				const headSha = await getBranchHeadSha(octo, owner, repo, branch);
				const res = await octo.rest.git.deleteRef({
					owner,
					repo,
					ref: `heads/${branch}`,
				});
				logRateLimit(res.headers);
				return text(
					`# Branch deleted\n\n- **${branch}** removed from ${owner}/${repo}\n- was @ \`${headSha.slice(0, 7)}\` (full: \`${headSha}\`)`,
				);
			}),
	);
};
