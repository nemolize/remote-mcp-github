import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveDefaultBranch } from "../github/helpers.js";
import { errorResult, logRateLimit, logWrite, text, truncate, wrapTool } from "../mcp/response.js";
import type { OctokitFactory } from "./common.js";
import {
	CrossRepoHeadPattern,
	MAX_TEXT_FIELD_LENGTH,
	maxCharsMessage,
	RepoTarget,
	SameRepoBranchPattern,
} from "./common.js";

export const registerPullTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"get_pr_diff",
		{
			description:
				"Fetch the unified diff of a pull request. Use when the user asks to review, summarise, or inspect the changes in a specific PR. Returns the diff as a fenced code block (truncated for very large PRs).",
			inputSchema: {
				...RepoTarget,
				pull_number: z.number().int().positive().describe("Pull request number."),
			},
		},
		async ({ owner, repo, pull_number }) =>
			wrapTool(async () => {
				const response = await client().rest.pulls.get({
					owner,
					repo,
					pull_number,
					mediaType: { format: "diff" },
				});
				logRateLimit(response.headers);
				// `mediaType: { format: "diff" }` makes Octokit return the raw diff text,
				// but the generated TS types still claim a structured PR object.
				const raw: unknown = response.data;
				if (typeof raw !== "string") {
					return errorResult("Expected raw diff response from GitHub.");
				}
				const diff = raw;
				return text(
					truncate(`# Diff for ${owner}/${repo}#${pull_number}\n\n\`\`\`diff\n${diff}\n\`\`\``),
				);
			}),
	);

	server.registerTool(
		"create_pull_request",
		{
			description:
				"Open a new pull request in a repository. Use when the user asks to open, file, or create a PR. `head` is a branch in the target repo by default; for cross-repo (fork) PRs, set `cross_repo_head: 'owner:branch'` instead. `base` defaults to the repo's default branch.",
			inputSchema: {
				...RepoTarget,
				title: z.string().min(1).describe("Pull request title."),
				head: z
					.string()
					.min(1)
					.regex(
						SameRepoBranchPattern,
						"Use cross_repo_head for 'owner:branch' form (cross-repo PRs).",
					)
					.optional()
					.describe(
						"Branch in the target repo containing your changes. Required unless cross_repo_head is set.",
					),
				cross_repo_head: z
					.string()
					.min(1)
					.regex(CrossRepoHeadPattern, "Cross-repo head must be of form 'owner:branch'.")
					.optional()
					.describe(
						"For cross-repo (fork) PRs only. Format: 'owner:branch'. Mutually exclusive with `head`.",
					),
				base: z
					.string()
					.optional()
					.describe("Branch to merge into. Defaults to the repo's default branch."),
				body: z
					.string()
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("PR description", MAX_TEXT_FIELD_LENGTH))
					.optional()
					.describe("PR description (Markdown supported)."),
				draft: z.boolean().optional().describe("Create as a draft PR."),
				maintainer_can_modify: z
					.boolean()
					.optional()
					.describe("Allow maintainers to edit the PR branch (cross-repo PRs)."),
			},
		},
		async ({
			owner,
			repo,
			title,
			head,
			cross_repo_head,
			base,
			body,
			draft,
			maintainer_can_modify,
		}) =>
			wrapTool(async () => {
				const effectiveHead = cross_repo_head ?? head;
				if (effectiveHead == null) {
					return errorResult(
						"Provide either `head` (same-repo branch) or `cross_repo_head` ('owner:branch' for fork PRs).",
					);
				}
				if (head != null && cross_repo_head != null) {
					return errorResult(
						"`head` and `cross_repo_head` are mutually exclusive; pass exactly one.",
					);
				}
				const octo = client();
				const target = base ?? (await resolveDefaultBranch(octo, owner, repo));
				const { data, headers } = await octo.rest.pulls.create({
					owner,
					repo,
					title,
					head: effectiveHead,
					base: target,
					body,
					draft,
					maintainer_can_modify,
				});
				logRateLimit(headers);
				logWrite({ tool: "create_pull_request", owner, repo, pull_number: data.number });
				const flag = data.draft === true ? " (draft)" : "";
				return text(
					`# Pull request opened${flag}\n\n- **${data.title}** (#${data.number}) — \`${effectiveHead}\` → \`${target}\`\n- ${data.html_url}`,
				);
			}),
	);

	server.registerTool(
		"request_pr_review",
		{
			description:
				"Request reviewers (users and/or teams) on an existing pull request. Use when the user asks to assign, request, or add reviewers to a PR. At least one of `reviewers` or `team_reviewers` must be non-empty. Returns the PR URL and the list of requested reviewers.",
			inputSchema: {
				...RepoTarget,
				pull_number: z.number().int().positive().describe("Pull request number."),
				reviewers: z
					.array(z.string())
					.optional()
					.describe(
						"GitHub usernames to request review from. At least one of `reviewers` or `team_reviewers` must be non-empty.",
					),
				team_reviewers: z
					.array(z.string())
					.optional()
					.describe(
						"Team slugs (within the repo's org) to request review from. At least one of `reviewers` or `team_reviewers` must be non-empty.",
					),
			},
		},
		async ({ owner, repo, pull_number, reviewers, team_reviewers }) =>
			wrapTool(async () => {
				const reviewerCount = (reviewers?.length ?? 0) + (team_reviewers?.length ?? 0);
				if (reviewerCount === 0) {
					return errorResult("At least one of `reviewers` or `team_reviewers` must be non-empty.");
				}
				const octo = client();
				const { data, headers } = await octo.rest.pulls.requestReviewers({
					owner,
					repo,
					pull_number,
					reviewers,
					team_reviewers,
				});
				logRateLimit(headers);
				logWrite({ tool: "request_pr_review", owner, repo, pull_number });
				const users = (data.requested_reviewers ?? []).map((u) => `@${u.login}`);
				const teams = (data.requested_teams ?? []).map((t) => `@${owner}/${t.slug}`);
				const requested = [...users, ...teams];
				const list = requested.length > 0 ? requested.join(", ") : "(none)";
				return text(
					`# Reviewers requested\n\n- PR: #${pull_number} — ${data.html_url}\n- requested: ${list}`,
				);
			}),
	);
};
