import { describe, expect, it } from "vitest";

import { registerIssueTools } from "../src/tools/issues.js";

const captureHandlers = () => {
	const handlers = new Map();
	const server = {
		registerTool: (name, _config, handler) => {
			handlers.set(name, handler);
		},
	};
	return { handlers, server };
};

const stubOctokit = (overrides) => ({
	rest: {
		issues: {
			get: async () => ({ data: {}, headers: {} }),
			listComments: async () => ({ data: [], headers: {} }),
			listLabelsForRepo: async () => ({ data: [], headers: {} }),
			update: async () => ({ data: {}, headers: {} }),
			addLabels: async () => ({ data: [], headers: {} }),
			removeLabel: async () => ({ data: [], headers: {} }),
			addAssignees: async () => ({ data: { assignees: [] }, headers: {} }),
			removeAssignees: async () => ({ data: { assignees: [] }, headers: {} }),
			...overrides,
		},
	},
});

const invoke = async (handlers, name, params) => {
	const handler = handlers.get(name);
	expect(handler, `tool ${name} was not registered`).toBeDefined();
	return handler(params);
};

describe("registerIssueTools", () => {
	it("get_issue renders title, labels, and assignees", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			get: async () => ({
				data: {
					number: 42,
					title: "Sample issue",
					state: "open",
					state_reason: null,
					user: { login: "alice" },
					labels: [{ name: "bug" }, { name: "p1" }],
					assignees: [{ login: "bob" }],
					milestone: null,
					body: "hello",
					created_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-02T00:00:00Z",
					html_url: "https://example.test/42",
					pull_request: undefined,
				},
				headers: {},
			}),
		});
		registerIssueTools(server, () => octokit);

		const result = await invoke(handlers, "get_issue", {
			owner: "o",
			repo: "r",
			issue_number: 42,
		});
		const body = result.content[0].text;
		expect(body).toContain("# Issue #42: Sample issue");
		expect(body).toContain("- labels: `bug`, `p1`");
		expect(body).toContain("- assignees: @bob");
		expect(body).toContain("- author: @alice");
		expect(result.isError).toBeUndefined();
	});

	it("update_issue omits labels when caller omits the field (preserves existing set)", async () => {
		const { handlers, server } = captureHandlers();
		let captured;
		const octokit = stubOctokit({
			update: async (params) => {
				captured = params;
				return {
					data: {
						number: 1,
						title: "x",
						state: "open",
						state_reason: null,
						html_url: "https://example.test/1",
					},
					headers: {},
				};
			},
		});
		registerIssueTools(server, () => octokit);

		await invoke(handlers, "update_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			title: "x",
		});
		expect(captured).toBeDefined();
		expect(captured.labels).toBeUndefined();
		expect(captured.assignees).toBeUndefined();
	});

	it("update_issue forwards empty arrays so callers can clear labels/assignees", async () => {
		const { handlers, server } = captureHandlers();
		let captured;
		const octokit = stubOctokit({
			update: async (params) => {
				captured = params;
				return {
					data: {
						number: 1,
						title: "x",
						state: "open",
						state_reason: null,
						html_url: "https://example.test/1",
					},
					headers: {},
				};
			},
		});
		registerIssueTools(server, () => octokit);

		await invoke(handlers, "update_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			labels: [],
			assignees: [],
		});
		expect(captured.labels).toEqual([]);
		expect(captured.assignees).toEqual([]);
	});

	it("remove_label surfaces Octokit errors via wrapTool (isError = true)", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			removeLabel: async () => {
				const err = new Error("Label does not exist");
				err.status = 404;
				throw err;
			},
		});
		registerIssueTools(server, () => octokit);

		const result = await invoke(handlers, "remove_label", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			name: "missing",
		});
		expect(result.isError).toBe(true);
		const body = result.content[0].text;
		expect(body).toContain("Label does not exist");
		expect(body).toContain("HTTP 404");
	});
});
