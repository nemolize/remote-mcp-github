import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorResult, logRateLimit, logWrite, text, wrapTool } from "../mcp/response.js";
import { stripUndefined } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { MAX_TEXT_FIELD_LENGTH, maxCharsMessage, RepoTarget } from "./common.js";

const COPILOT_CODING_AGENT = "copilot-swe-agent[bot]";
const COPILOT_REVIEWER = "copilot-pull-request-reviewer[bot]";

const isBot = (login: string | undefined, botLogin: string): boolean => {
	const l = login?.toLowerCase();
	return l === botLogin || l === "copilot";
};

export const registerCopilotTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"assign_copilot_to_issue",
		{
			description:
				"Assign GitHub Copilot's coding agent to an issue, which starts an autonomous run that opens a pull request. Use when the user asks to have Copilot work on, implement, or fix an issue. Requires write access and Copilot coding agent enabled on the repository; when it is not, GitHub ignores the assignment and this tool returns an error. Existing assignees are kept. Returns the issue's assignees after the change.",
			inputSchema: {
				...RepoTarget,
				issue_number: z.number().int().positive().describe("Issue number to hand to Copilot."),
				base_branch: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Branch Copilot bases its pull request on. Defaults to the repo's default branch.",
					),
				custom_instructions: z
					.string()
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("custom_instructions", MAX_TEXT_FIELD_LENGTH))
					.optional()
					.describe("Extra instructions for Copilot, passed to GitHub verbatim."),
			},
		},
		async ({ owner, repo, issue_number, base_branch, custom_instructions }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.addAssignees({
					owner,
					repo,
					issue_number,
					assignees: [COPILOT_CODING_AGENT],
					agent_assignment: stripUndefined({
						target_repo: `${owner}/${repo}`,
						base_branch,
						custom_instructions,
					}),
				});
				logRateLimit(headers);
				const logins = (data.assignees ?? []).map((a) => a.login);
				if (!logins.some((l) => isBot(l, COPILOT_CODING_AGENT))) {
					return errorResult(
						`GitHub did not assign Copilot to #${issue_number}. Copilot coding agent may not be enabled on ${owner}/${repo}, or the token lacks write access.`,
					);
				}
				logWrite({ tool: "assign_copilot_to_issue", owner, repo, issue_number });
				return text(
					`# Copilot assigned\n\n- on #${issue_number}\n- assignees now: ${logins.map((l) => `@${l}`).join(", ")}`,
				);
			}),
	);

	server.registerTool(
		"request_copilot_review",
		{
			description:
				"Request a GitHub Copilot code review on a pull request. Use when the user asks for a Copilot review or a first-pass AI review of a PR. Requires write access and Copilot code review available on the repository; when it is not, GitHub ignores the request and this tool returns an error. Returns the PR URL and the requested reviewers.",
			inputSchema: {
				...RepoTarget,
				pull_number: z.number().int().positive().describe("Pull request number."),
			},
		},
		async ({ owner, repo, pull_number }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.pulls.requestReviewers({
					owner,
					repo,
					pull_number,
					reviewers: [COPILOT_REVIEWER],
				});
				logRateLimit(headers);
				const logins = (data.requested_reviewers ?? []).map((u) => u.login);
				if (!logins.some((l) => isBot(l, COPILOT_REVIEWER))) {
					return errorResult(
						`GitHub did not request a Copilot review on #${pull_number}. Copilot code review may not be available on ${owner}/${repo}, or the token lacks write access.`,
					);
				}
				logWrite({ tool: "request_copilot_review", owner, repo, pull_number });
				return text(
					`# Copilot review requested\n\n- PR: #${pull_number} — ${data.html_url}\n- requested: ${logins.map((l) => `@${l}`).join(", ")}`,
				);
			}),
	);
};
