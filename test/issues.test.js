import { describe, expect, it } from "vitest";

import { registerIssueTools } from "../src/tools/issues.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

// `overrides` patches the `rest.issues.*` methods (the bulk of the issue tools);
// `search` separately patches `rest.search.issuesAndPullRequests` (search_issues).
const stubOctokit = (overrides = {}, search = {}) => ({
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
		search: {
			issuesAndPullRequests: async () => ({
				data: { total_count: 0, items: [] },
				headers: {},
			}),
			...search,
		},
	},
});

describe("registerIssueTools", () => {
	it("get_issue renders title, labels, and assignees", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			get: async () => ({
				data: {
					number: 42,
					node_id: "I_abc123",
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
		expect(body).toContain("- node_id: `I_abc123`");
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

	it("update_issue forwards explicit null for state_reason/milestone so callers can clear them", async () => {
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
			state_reason: null,
			milestone: null,
		});
		// The conditional-spread guard is on `undefined` only, so a deliberate
		// `null` must reach Octokit as `null` (the "clear" signal) — not be omitted.
		expect(captured.state_reason).toBeNull();
		expect(captured.milestone).toBeNull();
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

	// NOTE: the zod `.default("open")` on `state` is applied by the MCP SDK's
	// schema validation, which handler-direct invocation bypasses — so this test
	// passes state explicitly rather than relying on the default.
	it("search_issues composes the repo+state qualifier and reports no matches", async () => {
		const { handlers, server } = captureHandlers();
		let capturedQ;
		const octokit = stubOctokit(
			{},
			{
				issuesAndPullRequests: async ({ q }) => {
					capturedQ = q;
					return { data: { total_count: 0, items: [] }, headers: {} };
				},
			},
		);
		registerIssueTools(server, () => octokit);

		const result = await invoke(handlers, "search_issues", {
			owner: "o",
			repo: "r",
			query: "boom",
			state: "open",
		});
		expect(capturedQ).toBe("boom repo:o/r state:open");
		const body = result.content[0].text;
		expect(body).toContain("No issues or PRs matched `boom repo:o/r state:open`.");
		expect(result.isError).toBeUndefined();
	});

	it("search_issues drops the state qualifier when state is 'all'", async () => {
		const { handlers, server } = captureHandlers();
		let capturedQ;
		const octokit = stubOctokit(
			{},
			{
				issuesAndPullRequests: async ({ q }) => {
					capturedQ = q;
					return { data: { total_count: 0, items: [] }, headers: {} };
				},
			},
		);
		registerIssueTools(server, () => octokit);

		await invoke(handlers, "search_issues", {
			owner: "o",
			repo: "r",
			query: "boom",
			state: "all",
		});
		expect(capturedQ).toBe("boom repo:o/r");
	});

	it("search_issues distinguishes PR and Issue rows", async () => {
		const { handlers, server } = captureHandlers();
		const items = [
			{
				number: 7,
				title: "A pull request",
				state: "open",
				user: { login: "alice" },
				html_url: "https://example.test/7",
				pull_request: { url: "https://example.test/pulls/7" },
			},
			{
				number: 8,
				title: "An issue",
				state: "closed",
				user: { login: "bob" },
				html_url: "https://example.test/8",
				pull_request: undefined,
			},
		];
		const octokit = stubOctokit(
			{},
			{
				issuesAndPullRequests: async () => ({
					data: { total_count: 2, items },
					headers: {},
				}),
			},
		);
		registerIssueTools(server, () => octokit);

		const result = await invoke(handlers, "search_issues", {
			owner: "o",
			repo: "r",
			query: "x",
			state: "all",
			per_page: 20,
			page: 1,
		});
		const body = result.content[0].text;
		expect(body).toContain("- [PR #7] **A pull request** (open) by @alice");
		expect(body).toContain("- [Issue #8] **An issue** (closed) by @bob");
		expect(body).toContain("(showing 2 of 2)");
	});

	it("search_issues falls back to (unknown) author when user is null", async () => {
		const { handlers, server } = captureHandlers();
		const items = [
			{
				number: 9,
				title: "Orphaned issue",
				state: "open",
				user: null,
				html_url: "https://example.test/9",
				pull_request: undefined,
			},
		];
		const octokit = stubOctokit(
			{},
			{
				issuesAndPullRequests: async () => ({
					data: { total_count: 1, items },
					headers: {},
				}),
			},
		);
		registerIssueTools(server, () => octokit);

		const result = await invoke(handlers, "search_issues", {
			owner: "o",
			repo: "r",
			query: "x",
			state: "all",
			per_page: 20,
			page: 1,
		});
		const body = result.content[0].text;
		expect(body).toContain("- [Issue #9] **Orphaned issue** (open) by (unknown)");
		expect(body).not.toContain("@undefined");
	});

	it("search_issues surfaces Octokit errors via wrapTool (isError = true)", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(
			{},
			{
				issuesAndPullRequests: async () => {
					const err = new Error("Validation Failed");
					err.status = 422;
					throw err;
				},
			},
		);
		registerIssueTools(server, () => octokit);

		const result = await invoke(handlers, "search_issues", {
			owner: "o",
			repo: "r",
			query: "bad:qualifier",
		});
		expect(result.isError).toBe(true);
		const body = result.content[0].text;
		expect(body).toContain("Validation Failed");
		expect(body).toContain("HTTP 422");
	});
});
