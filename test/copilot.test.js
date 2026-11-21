import { afterEach, describe, expect, it, vi } from "vitest";

import { registerCopilotTools } from "../src/tools/copilot.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const run = async (octokit, tool, params) => {
	const { handlers, server } = captureHandlers();
	registerCopilotTools(server, () => octokit);
	return invoke(handlers, tool, params);
};

const textOf = (result) => result.content[0].text;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("assign_copilot_to_issue", () => {
	it("assigns the coding-agent bot and forwards agent_assignment", async () => {
		const addAssignees = vi.fn(async () => ({
			data: { assignees: [{ login: "a" }, { login: "Copilot" }] },
			headers: {},
		}));
		const result = await run({ rest: { issues: { addAssignees } } }, "assign_copilot_to_issue", {
			owner: "o",
			repo: "r",
			issue_number: 3,
			base_branch: "dev",
			custom_instructions: "be brief",
		});
		expect(result.isError).toBeUndefined();
		expect(addAssignees).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			issue_number: 3,
			assignees: ["copilot-swe-agent[bot]"],
			agent_assignment: { target_repo: "o/r", base_branch: "dev", custom_instructions: "be brief" },
		});
		expect(textOf(result)).toContain("@Copilot");
	});

	it("omits unset optional fields from agent_assignment", async () => {
		const addAssignees = vi.fn(async () => ({
			data: { assignees: [{ login: "copilot-swe-agent[bot]" }] },
			headers: {},
		}));
		await run({ rest: { issues: { addAssignees } } }, "assign_copilot_to_issue", {
			owner: "o",
			repo: "r",
			issue_number: 3,
		});
		expect(addAssignees.mock.calls[0][0].agent_assignment).toEqual({ target_repo: "o/r" });
	});

	it("errors without an audit line when the bot is absent from the returned assignees", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const addAssignees = vi.fn(async () => ({
			data: { assignees: [{ login: "a" }] },
			headers: {},
		}));
		const result = await run({ rest: { issues: { addAssignees } } }, "assign_copilot_to_issue", {
			owner: "o",
			repo: "r",
			issue_number: 3,
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("did not assign Copilot");
		expect(logSpy.mock.calls.some(([line]) => String(line).includes("github-audit"))).toBe(false);
	});
});

describe("request_copilot_review", () => {
	it("requests the reviewer bot", async () => {
		const requestReviewers = vi.fn(async () => ({
			data: {
				html_url: "https://x/pull/4",
				requested_reviewers: [{ login: "Copilot" }],
			},
			headers: {},
		}));
		const result = await run({ rest: { pulls: { requestReviewers } } }, "request_copilot_review", {
			owner: "o",
			repo: "r",
			pull_number: 4,
		});
		expect(result.isError).toBeUndefined();
		expect(requestReviewers).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			pull_number: 4,
			reviewers: ["copilot-pull-request-reviewer[bot]"],
		});
		expect(textOf(result)).toContain("https://x/pull/4");
	});

	it("errors without an audit line when the bot is absent from requested_reviewers", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const requestReviewers = vi.fn(async () => ({
			data: { html_url: "https://x/pull/4", requested_reviewers: [] },
			headers: {},
		}));
		const result = await run({ rest: { pulls: { requestReviewers } } }, "request_copilot_review", {
			owner: "o",
			repo: "r",
			pull_number: 4,
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("did not request a Copilot review");
		expect(logSpy.mock.calls.some(([line]) => String(line).includes("github-audit"))).toBe(false);
	});
});
