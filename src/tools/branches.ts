import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getBranchHeadSha, resolveDefaultBranch } from "../github/helpers.js";
import { errorResult, logRateLimit, logWrite, text, truncate, wrapTool } from "../mcp/response.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget, SameRepoBranchPattern } from "./common.js";

export const registerBranchTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"list_branches",
		{
			description:
				"List branches in a repository. Use when the user asks to see, enumerate, or browse the branches of a repo. Returns one bullet per branch with name, head SHA (short), and protected flag.",
			inputSchema: {
				...RepoTarget,
				protected: z.boolean().optional().describe("Filter to protected branches only."),
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
		async ({ owner, repo, protected: protectedOnly, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.listBranches({
					owner,
					repo,
					protected: protectedOnly,
					per_page,
					page,
				});
				logRateLimit(headers);
				if (data.length === 0) return text("(no branches found)");
				const lines = data.map((b) => {
					const flag = b.protected ? "protected" : "unprotected";
					return `- **${b.name}** (${flag}) — \`${b.commit.sha.slice(0, 7)}\``;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const pageNum = page ?? 1;
				const header = hasMore
					? `# Branches in ${owner}/${repo} (page ${pageNum}, ${data.length} shown; more available — pass next \`page\` or raise \`per_page\` up to 100)`
					: `# Branches in ${owner}/${repo} (${data.length})`;
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"create_branch",
		{
			description:
				"Create a new branch in a repository, pointing at the tip of a base branch (default: the repo's default branch). Use when the user asks to branch off, start a new feature branch, or fork the current state. Returns the new ref name and SHA.",
			inputSchema: {
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
				logWrite({ tool: "create_branch", owner, repo, branch });
				return text(
					`# Branch created\n\n- **${branch}** ← branched from \`${base}\` @ \`${baseSha.slice(0, 7)}\`\n- ref: ${created.data.ref}`,
				);
			}),
	);

	server.registerTool(
		"delete_branch",
		{
			description:
				"Delete a branch from a repository. Use when the user asks to delete, remove, or clean up a branch. Refuses to delete the repo's default branch. Returns the deleted branch name and the SHA it pointed at (useful if the caller needs to recreate the ref).",
			inputSchema: {
				...RepoTarget,
				branch: z
					.string()
					.min(1)
					.regex(SameRepoBranchPattern, "Use a same-repo branch name.")
					.describe("Branch name to delete (without 'refs/heads/' prefix)."),
			},
		},
		async ({ owner, repo, branch }) =>
			wrapTool(async () => {
				const octo = client();
				const defaultBranch = await resolveDefaultBranch(octo, owner, repo);
				if (branch === defaultBranch) {
					return errorResult(`Refusing to delete the repo's default branch \`${branch}\`.`);
				}
				const headSha = await getBranchHeadSha(octo, owner, repo, branch);
				const res = await octo.rest.git.deleteRef({
					owner,
					repo,
					ref: `heads/${branch}`,
				});
				logRateLimit(res.headers);
				logWrite({ tool: "delete_branch", owner, repo, branch });
				return text(
					`# Branch deleted\n\n- **${branch}** removed from ${owner}/${repo}\n- was @ \`${headSha.slice(0, 7)}\` (full: \`${headSha}\`)`,
				);
			}),
	);
};
