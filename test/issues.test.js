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

// Focused module-level tests for the issue #190 lifecycle + comment edit/delete
// tools. audit-log.test.js already covers one happy path per tool via a shared
// generous GraphQL mock; these tests exercise the branches that the generous
// shape hides — not-found paths, GraphQL null-payload guards, develop_issue's
// base_ref variant, list_linked_branches's render paths.

const lifecycleOctokit = (graphql, restOverrides = {}) => ({
	graphql,
	rest: {
		issues: {
			lock: async () => ({ data: undefined, headers: {} }),
			unlock: async () => ({ data: undefined, headers: {} }),
			updateComment: async () => ({ data: { html_url: "https://x/c" }, headers: {} }),
			deleteComment: async () => ({ data: undefined, headers: {} }),
			...restOverrides,
		},
	},
});

describe("registerIssueTools — lifecycle branches", () => {
	it("pin_issue surfaces an error when the issue is not found (null node id)", async () => {
		const graphql = async () => ({ repository: { issue: null } });
		const { handlers, server } = captureHandlers();
		registerIssueTools(server, () => lifecycleOctokit(graphql));
		const result = await invoke(handlers, "pin_issue", {
			owner: "o",
			repo: "r",
			issue_number: 999,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("o/r#999");
	});

	it("pin_issue surfaces an error when the mutation payload is null (silent-failure guard)", async () => {
		const graphql = async (query) => {
			if (query.includes("pinIssue(")) return { pinIssue: null };
			return {
				repository: {
					issue: { id: "I_1" },
					defaultBranchRef: { target: { oid: "oid0" } },
				},
			};
		};
		const { handlers, server } = captureHandlers();
		registerIssueTools(server, () => lifecycleOctokit(graphql));
		const result = await invoke(handlers, "pin_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to pin");
	});

	it("unpin_issue routes through its own mutation branch (unpinIssue, not pinIssue)", async () => {
		let sawUnpinMutation = false;
		const graphql = async (query) => {
			if (query.includes("unpinIssue(")) {
				sawUnpinMutation = true;
				return { unpinIssue: { issue: { url: "https://x/1" } } };
			}
			if (query.includes("pinIssue(")) {
				throw new Error("unpin_issue must not route through pinIssue mutation");
			}
			return { repository: { issue: { id: "I_1" } } };
		};
		const { handlers, server } = captureHandlers();
		registerIssueTools(server, () => lifecycleOctokit(graphql));
		const result = await invoke(handlers, "unpin_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
		});
		expect(result.isError).toBeFalsy();
		expect(sawUnpinMutation).toBe(true);
	});

	it("transfer_issue surfaces an error when the destination repo is not found", async () => {
		const graphql = async () => ({
			source: { issue: { id: "I_1" } },
			destination: null,
		});
		const { handlers, server } = captureHandlers();
		registerIssueTools(server, () => lifecycleOctokit(graphql));
		const result = await invoke(handlers, "transfer_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			new_repository_owner: "o2",
			new_repository_name: "r2",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("o2/r2");
	});

	it("transfer_issue surfaces an error when the mutation payload is null", async () => {
		const graphql = async (query) => {
			if (query.includes("transferIssue(")) return { transferIssue: { issue: null } };
			return {
				source: { issue: { id: "I_1" } },
				destination: { id: "R_2" },
			};
		};
		const { handlers, server } = captureHandlers();
		registerIssueTools(server, () => lifecycleOctokit(graphql));
		const result = await invoke(handlers, "transfer_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			new_repository_owner: "o2",
			new_repository_name: "r2",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to transfer");
	});

	it("transfer_issue forwards create_labels_if_missing to the GraphQL mutation", async () => {
		let capturedVars;
		const graphql = async (query, vars) => {
			if (query.includes("transferIssue(")) {
				capturedVars = vars;
				return {
					transferIssue: { issue: { number: 2, url: "https://x/o2/r2/issues/2" } },
				};
			}
			return {
				source: { issue: { id: "I_1" } },
				destination: { id: "R_2" },
			};
		};
		const { handlers, server } = captureHandlers();
		registerIssueTools(server, () => lifecycleOctokit(graphql));
		await invoke(handlers, "transfer_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			new_repository_owner: "o2",
			new_repository_name: "r2",
			create_labels_if_missing: true,
		});
		expect(capturedVars.create_labels_if_missing).toBe(true);

		// And the default path sends false when the caller omits it.
		let defaultVars;
		const graphql2 = async (query, vars) => {
			if (query.includes("transferIssue(")) {
				defaultVars = vars;
				return {
					transferIssue: { issue: { number: 2, url: "https://x/o2/r2/issues/2" } },
				};
			}
			return {
				source: { issue: { id: "I_1" } },
				destination: { id: "R_2" },
			};
		};
		const cap2 = captureHandlers();
		registerIssueTools(cap2.server, () => lifecycleOctokit(graphql2));
		await invoke(cap2.handlers, "transfer_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			new_repository_owner: "o2",
			new_repository_name: "r2",
		});
		expect(defaultVars.create_labels_if_missing).toBe(false);
	});

	it("delete_issue surfaces an error when the mutation payload is null", async () => {
		const graphql = async (query) => {
			if (query.includes("deleteIssue(")) return { deleteIssue: null };
			return { repository: { issue: { id: "I_1" } } };
		};
		const { handlers, server } = captureHandlers();
		registerIssueTools(server, () => lifecycleOctokit(graphql));
		const result = await invoke(handlers, "delete_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to delete");
	});

	it("develop_issue with base_ref queries the named ref (not defaultBranchRef)", async () => {
		let sawBaseRefQuery = false;
		const graphql = async (query, vars) => {
			if (query.includes("createLinkedBranch(")) {
				return {
					createLinkedBranch: {
						linkedBranch: {
							ref: { name: "1-feat", repository: { url: "https://x/o/r" } },
						},
					},
				};
			}
			if (query.includes("baseRef: ref(qualifiedName:")) {
				sawBaseRefQuery = true;
				expect(vars.base_ref).toBe("develop");
				return {
					repository: {
						issue: { id: "I_1" },
						baseRef: { target: { oid: "oid_dev" } },
					},
				};
			}
			// defaultBranchRef path must not fire when base_ref is given
			throw new Error(`unexpected query dispatched for base_ref call: ${query}`);
		};
		const { handlers, server } = captureHandlers();
		registerIssueTools(server, () => lifecycleOctokit(graphql));
		const result = await invoke(handlers, "develop_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			base_ref: "develop",
			branch_name: "1-feat",
		});
		expect(result.isError).toBeFalsy();
		expect(sawBaseRefQuery).toBe(true);
	});

	it("develop_issue surfaces an error when the base_ref does not exist", async () => {
		const graphql = async () => ({
			repository: {
				issue: { id: "I_1" },
				baseRef: null,
			},
		});
		const { handlers, server } = captureHandlers();
		registerIssueTools(server, () => lifecycleOctokit(graphql));
		const result = await invoke(handlers, "develop_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			base_ref: "nope",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Base ref `nope`");
	});

	it("develop_issue URL-encodes special characters in the created branch name", async () => {
		const graphql = async (query) => {
			if (query.includes("createLinkedBranch(")) {
				return {
					createLinkedBranch: {
						linkedBranch: {
							ref: { name: "issue-#42/name%foo", repository: { url: "https://x/o/r" } },
						},
					},
				};
			}
			return {
				repository: {
					issue: { id: "I_1" },
					defaultBranchRef: { target: { oid: "oid0" } },
				},
			};
		};
		const { handlers, server } = captureHandlers();
		registerIssueTools(server, () => lifecycleOctokit(graphql));
		const result = await invoke(handlers, "develop_issue", {
			owner: "o",
			repo: "r",
			issue_number: 42,
		});
		expect(result.isError).toBeFalsy();
		const body = result.content[0].text;
		expect(body).toContain("issue-%23");
		expect(body).toContain("%25foo");
	});

	it("list_linked_branches renders the empty-list case", async () => {
		const graphql = async () => ({
			repository: {
				issue: {
					linkedBranches: { pageInfo: { hasNextPage: false }, nodes: [] },
				},
			},
		});
		const { handlers, server } = captureHandlers();
		registerIssueTools(server, () => lifecycleOctokit(graphql));
		const result = await invoke(handlers, "list_linked_branches", {
			owner: "o",
			repo: "r",
			issue_number: 1,
		});
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("(no linked branches)");
	});

	it("list_linked_branches surfaces hasNextPage even when the filtered page is empty", async () => {
		// GitHub reports more entries, but the first page's only nodes had null
		// refs (deleted / inaccessible). Empty display + truncation hint.
		const graphql = async () => ({
			repository: {
				issue: {
					linkedBranches: {
						pageInfo: { hasNextPage: true },
						nodes: [{ ref: null }, { ref: null }],
					},
				},
			},
		});
		const { handlers, server } = captureHandlers();
		registerIssueTools(server, () => lifecycleOctokit(graphql));
		const result = await invoke(handlers, "list_linked_branches", {
			owner: "o",
			repo: "r",
			issue_number: 1,
		});
		expect(result.isError).toBeFalsy();
		const body = result.content[0].text;
		expect(body).toContain("(no linked branches)");
		expect(body).toContain("more linked branches exist");
	});

	it("list_linked_branches filters null nodes/refs and lists valid ones", async () => {
		const graphql = async () => ({
			repository: {
				issue: {
					linkedBranches: {
						pageInfo: { hasNextPage: false },
						nodes: [
							null,
							{ ref: null },
							{ ref: { name: "feat/a", repository: { nameWithOwner: "o/r" } } },
							{ ref: { name: "feat/b", repository: { nameWithOwner: "o/r" } } },
						],
					},
				},
			},
		});
		const { handlers, server } = captureHandlers();
		registerIssueTools(server, () => lifecycleOctokit(graphql));
		const result = await invoke(handlers, "list_linked_branches", {
			owner: "o",
			repo: "r",
			issue_number: 1,
		});
		expect(result.isError).toBeFalsy();
		const body = result.content[0].text;
		expect(body).toContain("(2)");
		expect(body).toContain("`feat/a`");
		expect(body).toContain("`feat/b`");
	});

	it("list_linked_branches appends a truncation hint when hasNextPage is true", async () => {
		const graphql = async () => ({
			repository: {
				issue: {
					linkedBranches: {
						pageInfo: { hasNextPage: true },
						nodes: [{ ref: { name: "feat/a", repository: { nameWithOwner: "o/r" } } }],
					},
				},
			},
		});
		const { handlers, server } = captureHandlers();
		registerIssueTools(server, () => lifecycleOctokit(graphql));
		const result = await invoke(handlers, "list_linked_branches", {
			owner: "o",
			repo: "r",
			issue_number: 1,
		});
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("more linked branches exist");
	});

	it("list_linked_branches surfaces an error when the issue is not found", async () => {
		const graphql = async () => ({ repository: { issue: null } });
		const { handlers, server } = captureHandlers();
		registerIssueTools(server, () => lifecycleOctokit(graphql));
		const result = await invoke(handlers, "list_linked_branches", {
			owner: "o",
			repo: "r",
			issue_number: 999,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("o/r#999");
	});
});
