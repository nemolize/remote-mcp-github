import { afterEach, describe, expect, it, vi } from "vitest";

import { logWrite } from "../src/mcp/response.js";
import { registerActionTools } from "../src/tools/actions.js";
import { registerBranchTools } from "../src/tools/branches.js";
import { registerFileTools } from "../src/tools/files.js";
import { registerGistTools } from "../src/tools/gists.js";
import { registerIssueTools } from "../src/tools/issues.js";
import { registerProjectTools } from "../src/tools/projects.js";
import { registerPullTools } from "../src/tools/pulls.js";
import { registerRepoTools } from "../src/tools/repos.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

// Returns every `[github-audit]` JSON payload logged during the spy's lifetime,
// parsed back into objects. Isolates the audit trail from the `[github-ratelimit]`
// lines that share the same console.log channel.
const auditEntries = (logSpy) =>
	logSpy.mock.calls
		.map(([line]) => (typeof line === "string" ? line : ""))
		.filter((line) => line.startsWith("[github-audit] "))
		.map((line) => JSON.parse(line.slice("[github-audit] ".length)));

describe("logWrite", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("emits a single JSON line under the [github-audit] prefix", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		logWrite({ tool: "commit_file", owner: "o", repo: "r", branch: "main", path: "a.ts" });
		expect(logSpy).toHaveBeenCalledTimes(1);
		const [line] = logSpy.mock.calls[0];
		expect(line).toBe(
			'[github-audit] {"tool":"commit_file","owner":"o","repo":"r","branch":"main","path":"a.ts"}',
		);
	});

	it("drops null and undefined fields so only touched fields appear", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		logWrite({
			tool: "create_branch",
			owner: "o",
			repo: "r",
			branch: "feat",
			path: undefined,
			issue_number: undefined,
		});
		expect(auditEntries(logSpy)).toEqual([
			{ tool: "create_branch", owner: "o", repo: "r", branch: "feat" },
		]);
	});

	it("keeps a zero file_count rather than dropping it", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		logWrite({ tool: "commit_files", owner: "o", repo: "r", branch: "main", file_count: 0 });
		expect(auditEntries(logSpy)[0]).toHaveProperty("file_count", 0);
	});
});

describe("write tools emit audit logs", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("commit_file logs tool, owner, repo, branch, path on success", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { handlers, server } = captureHandlers();
		const octokit = {
			rest: {
				repos: {
					getContent: async () => ({ data: { type: "file", sha: "abc" }, headers: {} }),
					createOrUpdateFileContents: async () => ({
						data: {
							commit: { sha: "deadbeef0000", html_url: "https://x/commit" },
							content: { html_url: "https://x/file" },
						},
						headers: {},
					}),
				},
			},
		};
		registerFileTools(server, () => octokit);
		await invoke(handlers, "commit_file", {
			owner: "o",
			repo: "r",
			branch: "main",
			path: "a.ts",
			content: "x",
			encoding: "utf-8",
			message: "m",
		});
		expect(auditEntries(logSpy)).toEqual([
			{ tool: "commit_file", owner: "o", repo: "r", branch: "main", path: "a.ts" },
		]);
	});

	it("commit_files logs file_count instead of path", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { handlers, server } = captureHandlers();
		const octokit = {
			rest: {
				git: {
					getRef: async () => ({ data: { object: { sha: "parent" } }, headers: {} }),
					getCommit: async () => ({ data: { tree: { sha: "t" } }, headers: {} }),
					createTree: async () => ({ data: { sha: "tree" }, headers: {} }),
					createCommit: async () => ({
						data: { sha: "commit00", html_url: "https://x" },
						headers: {},
					}),
					updateRef: async () => ({ data: {}, headers: {} }),
				},
			},
		};
		registerFileTools(server, () => octokit);
		await invoke(handlers, "commit_files", {
			owner: "o",
			repo: "r",
			branch: "main",
			message: "m",
			files: [
				{ path: "a.ts", content: "x", encoding: "utf-8", mode: "100644" },
				{ path: "b.ts", content: "y", encoding: "utf-8", mode: "100644" },
			],
		});
		expect(auditEntries(logSpy)).toEqual([
			{ tool: "commit_files", owner: "o", repo: "r", branch: "main", file_count: 2 },
		]);
	});

	it("create_branch logs the new branch", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { handlers, server } = captureHandlers();
		const octokit = {
			rest: {
				repos: {
					get: async () => ({ data: { default_branch: "main" }, headers: {} }),
				},
				git: {
					getRef: async () => ({ data: { object: { sha: "basesha0000" } }, headers: {} }),
					createRef: async () => ({ data: { ref: "refs/heads/feat" }, headers: {} }),
				},
			},
		};
		registerBranchTools(server, () => octokit);
		await invoke(handlers, "create_branch", {
			owner: "o",
			repo: "r",
			branch: "feat",
			from: "main",
		});
		expect(auditEntries(logSpy)).toEqual([
			{ tool: "create_branch", owner: "o", repo: "r", branch: "feat" },
		]);
	});

	it("create_issue logs the created issue number", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { handlers, server } = captureHandlers();
		const octokit = {
			rest: {
				issues: {
					create: async () => ({
						data: { number: 99, title: "t", html_url: "https://x" },
						headers: {},
					}),
				},
			},
		};
		registerIssueTools(server, () => octokit);
		await invoke(handlers, "create_issue", { owner: "o", repo: "r", title: "t" });
		expect(auditEntries(logSpy)).toEqual([
			{ tool: "create_issue", owner: "o", repo: "r", issue_number: 99 },
		]);
	});

	it("create_pull_request logs the created PR number", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { handlers, server } = captureHandlers();
		const octokit = {
			rest: {
				repos: { get: async () => ({ data: { default_branch: "main" }, headers: {} }) },
				pulls: {
					create: async () => ({
						data: { number: 7, title: "t", draft: false, html_url: "https://x" },
						headers: {},
					}),
				},
			},
		};
		registerPullTools(server, () => octokit);
		await invoke(handlers, "create_pull_request", {
			owner: "o",
			repo: "r",
			title: "t",
			head: "feat",
		});
		expect(auditEntries(logSpy)).toEqual([
			{ tool: "create_pull_request", owner: "o", repo: "r", pull_number: 7 },
		]);
	});

	it("cancel_workflow_run logs the run_id", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { handlers, server } = captureHandlers();
		const octokit = {
			rest: { actions: { cancelWorkflowRun: async () => ({ data: {}, headers: {} }) } },
		};
		registerActionTools(server, () => octokit);
		await invoke(handlers, "cancel_workflow_run", { owner: "o", repo: "r", run_id: 42 });
		expect(auditEntries(logSpy)).toEqual([
			{ tool: "cancel_workflow_run", owner: "o", repo: "r", run_id: 42 },
		]);
	});

	it("trigger_workflow_dispatch logs the workflow_id and ref", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { handlers, server } = captureHandlers();
		const octokit = {
			rest: { actions: { createWorkflowDispatch: async () => ({ data: {}, headers: {} }) } },
		};
		registerActionTools(server, () => octokit);
		await invoke(handlers, "trigger_workflow_dispatch", {
			owner: "o",
			repo: "r",
			workflow_id: "ci.yml",
			ref: "main",
		});
		expect(auditEntries(logSpy)).toEqual([
			{
				tool: "trigger_workflow_dispatch",
				owner: "o",
				repo: "r",
				workflow_id: "ci.yml",
				ref: "main",
			},
		]);
	});

	it("does not emit an audit log when the write fails", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { handlers, server } = captureHandlers();
		const octokit = {
			rest: {
				issues: {
					create: async () => {
						throw new Error("boom");
					},
				},
			},
		};
		registerIssueTools(server, () => octokit);
		const result = await invoke(handlers, "create_issue", { owner: "o", repo: "r", title: "t" });
		expect(result.isError).toBe(true);
		expect(auditEntries(logSpy)).toEqual([]);
	});
});

// A permissive Octokit stub whose every method resolves with a shape generous
// enough for any single write handler. Each handler only reads a subset, so one
// fixture covers all 18 — this keeps the all-tools coverage table below from
// repeating a bespoke mock per tool.
const wideOctokit = () => {
	const ok = (data) => async () => ({ data, headers: {} });
	return {
		rest: {
			repos: {
				get: ok({ default_branch: "main" }),
				getContent: ok({ type: "file", sha: "abc" }),
				createOrUpdateFileContents: ok({
					commit: { sha: "deadbeef0000", html_url: "https://x/commit" },
					content: { html_url: "https://x/file" },
				}),
				deleteFile: ok({ commit: { sha: "deadbeef0000", html_url: "https://x/commit" } }),
				createForAuthenticatedUser: ok({
					owner: { login: "o" },
					name: "r",
					full_name: "o/r",
					private: false,
					html_url: "https://x/o/r",
					default_branch: "main",
				}),
				createInOrg: ok({
					owner: { login: "o" },
					name: "r",
					full_name: "o/r",
					private: false,
					html_url: "https://x/o/r",
					default_branch: "main",
				}),
				createFork: ok({
					owner: { login: "o" },
					name: "r",
					full_name: "o/r",
					private: false,
					html_url: "https://x/o/r",
					default_branch: "main",
				}),
				delete: ok(undefined),
			},
			git: {
				getRef: ok({ object: { sha: "parent000000" } }),
				getCommit: ok({ tree: { sha: "t" } }),
				createTree: ok({ sha: "tree" }),
				createCommit: ok({ sha: "commit00", html_url: "https://x" }),
				createRef: ok({ ref: "refs/heads/feat" }),
				deleteRef: ok({}),
				updateRef: ok({}),
			},
			issues: {
				create: ok({ number: 99, title: "t", html_url: "https://x" }),
				createComment: ok({ html_url: "https://x" }),
				update: ok({ number: 5, title: "t", state: "open", html_url: "https://x" }),
				addLabels: ok([{ name: "bug" }]),
				removeLabel: ok([]),
				addAssignees: ok({ assignees: [{ login: "a" }] }),
				removeAssignees: ok({ assignees: [] }),
			},
			pulls: {
				create: ok({ number: 7, title: "t", draft: false, html_url: "https://x" }),
				requestReviewers: ok({ requested_reviewers: [{ login: "a" }], requested_teams: [] }),
				updateBranch: ok({ message: "Updating branch." }),
				get: ok({ head: { sha: "deadbeef" } }),
				getReview: ok({ node_id: "PRR_node_42", state: "PENDING" }),
				createReview: ok({
					id: 42,
					node_id: "PRR_node_42",
					state: "PENDING",
					html_url: "https://x/review/42",
				}),
				submitReview: ok({ id: 42, state: "COMMENTED", html_url: "https://x/review/42" }),
				deletePendingReview: ok({ id: 42 }),
			},
			actions: {
				reRunWorkflow: ok({}),
				reRunWorkflowFailedJobs: ok({}),
				cancelWorkflowRun: ok({}),
				createWorkflowDispatch: ok({}),
			},
			gists: {
				create: ok({
					id: "g1",
					description: "d",
					public: false,
					owner: { login: "o" },
					files: {},
					updated_at: "2026-06-27T00:00:00Z",
					created_at: "2026-06-27T00:00:00Z",
					html_url: "https://gist.github.com/o/g1",
				}),
				update: ok({
					id: "g1",
					description: "d",
					public: false,
					owner: { login: "o" },
					files: {},
					updated_at: "2026-06-27T00:00:00Z",
					created_at: "2026-06-27T00:00:00Z",
					html_url: "https://gist.github.com/o/g1",
				}),
				delete: ok({}),
			},
		},
		// The GraphQL-backed tools share one function, so dispatch on the query
		// text: project writes resolve the project first, then mutate.
		graphql: async (query) => {
			if (query.includes("addProjectV2ItemById")) {
				return {
					addProjectV2ItemById: {
						item: {
							id: "PVTI_1",
							type: "ISSUE",
							content: { title: "t", number: 1, repository: { nameWithOwner: "o/r" } },
						},
					},
				};
			}
			if (query.includes("deleteProjectV2Item")) {
				return { deleteProjectV2Item: { deletedItemId: "PVTI_1" } };
			}
			if (query.includes("updateProjectV2ItemFieldValue")) {
				return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } };
			}
			if (query.includes("addProjectV2DraftIssue")) {
				return { addProjectV2DraftIssue: { projectItem: { id: "PVTI_1" } } };
			}
			if (query.includes("projectV2(number: $number)")) {
				return {
					repositoryOwner: {
						projectV2: { id: "PVT_1", number: 4, title: "Roadmap", owner: { login: "o" } },
					},
				};
			}
			return {
				addPullRequestReviewThread: {
					thread: { id: "PRRT_1", comments: { nodes: [{ databaseId: 101 }] } },
				},
			};
		},
	};
};

// Every write tool, the register function that owns it, the minimal params it
// needs, the audit `tool` name it must log, and (optionally) a per-tool extra
// set of audit fields that must appear on the emitted line. Tools that don't
// supply the 4th element default to `{ owner: "o", repo: "r" }`; tools whose
// mutation is account-scoped rather than repo-scoped (gists) provide their own.
// Read tools are intentionally absent — they must NOT emit an audit line.
const WRITE_TOOLS = [
	[
		registerFileTools,
		"commit_file",
		{
			owner: "o",
			repo: "r",
			branch: "main",
			path: "a.ts",
			content: "x",
			encoding: "utf-8",
			message: "m",
		},
	],
	[
		registerFileTools,
		"delete_file",
		{ owner: "o", repo: "r", branch: "main", path: "a.ts", message: "m" },
	],
	[
		registerFileTools,
		"commit_files",
		{
			owner: "o",
			repo: "r",
			branch: "main",
			message: "m",
			files: [{ path: "a.ts", content: "x", encoding: "utf-8", mode: "100644" }],
		},
	],
	[registerBranchTools, "create_branch", { owner: "o", repo: "r", branch: "feat", from: "main" }],
	[registerBranchTools, "delete_branch", { owner: "o", repo: "r", branch: "feat" }],
	[registerIssueTools, "create_issue", { owner: "o", repo: "r", title: "t" }],
	[registerIssueTools, "add_comment", { owner: "o", repo: "r", issue_number: 1, body: "b" }],
	[registerIssueTools, "update_issue", { owner: "o", repo: "r", issue_number: 1, title: "t" }],
	[registerIssueTools, "add_labels", { owner: "o", repo: "r", issue_number: 1, labels: ["bug"] }],
	[registerIssueTools, "remove_label", { owner: "o", repo: "r", issue_number: 1, name: "bug" }],
	[
		registerIssueTools,
		"add_assignees",
		{ owner: "o", repo: "r", issue_number: 1, assignees: ["a"] },
	],
	[
		registerIssueTools,
		"remove_assignees",
		{ owner: "o", repo: "r", issue_number: 1, assignees: ["a"] },
	],
	[registerPullTools, "create_pull_request", { owner: "o", repo: "r", title: "t", head: "feat" }],
	[
		registerPullTools,
		"request_pr_review",
		{ owner: "o", repo: "r", pull_number: 1, reviewers: ["a"] },
	],
	[registerPullTools, "update_pull_request_branch", { owner: "o", repo: "r", pull_number: 1 }],
	[
		registerPullTools,
		"create_pending_pr_review",
		{ owner: "o", repo: "r", pull_number: 1 },
		{ owner: "o", repo: "r", review_id: 42 },
	],
	[
		registerPullTools,
		"add_comment_to_pending_pr_review",
		{
			owner: "o",
			repo: "r",
			pull_number: 1,
			review_id: 42,
			path: "a.ts",
			body: "b",
			line: 1,
		},
		{ owner: "o", repo: "r", review_id: 42, comment_id: 101 },
	],
	[
		registerPullTools,
		"submit_pending_pr_review",
		{ owner: "o", repo: "r", pull_number: 1, review_id: 42, event: "COMMENT", body: "b" },
		{ owner: "o", repo: "r", review_id: 42 },
	],
	[
		registerPullTools,
		"delete_pending_pr_review",
		{ owner: "o", repo: "r", pull_number: 1, review_id: 42 },
		{ owner: "o", repo: "r", review_id: 42 },
	],
	[registerActionTools, "rerun_workflow_run", { owner: "o", repo: "r", run_id: 1 }],
	[registerActionTools, "rerun_failed_jobs", { owner: "o", repo: "r", run_id: 1 }],
	[registerActionTools, "cancel_workflow_run", { owner: "o", repo: "r", run_id: 1 }],
	[
		registerActionTools,
		"trigger_workflow_dispatch",
		{ owner: "o", repo: "r", workflow_id: "ci.yml", ref: "main" },
	],
	[registerRepoTools, "create_repository", { name: "r" }],
	[registerRepoTools, "fork_repository", { owner: "o", repo: "r" }],
	[registerRepoTools, "delete_repository", { owner: "o", repo: "r" }],
	[registerGistTools, "create_gist", { files: { "a.txt": { content: "x" } } }, { gist_id: "g1" }],
	[registerGistTools, "update_gist", { gist_id: "g1", description: "new" }, { gist_id: "g1" }],
	[registerGistTools, "delete_gist", { gist_id: "g1" }, { gist_id: "g1" }],
	// Projects v2 mutations are project-scoped, not repo-scoped: the audit line
	// carries the project owner login + node IDs, and no `repo` field.
	[
		registerProjectTools,
		"add_project_item",
		{ owner: "o", number: 4, content_id: "I_1" },
		{ owner: "o", project_id: "PVT_1", content_id: "I_1", item_id: "PVTI_1" },
	],
	[
		registerProjectTools,
		"remove_project_item",
		{ owner: "o", number: 4, item_id: "PVTI_1" },
		{ owner: "o", project_id: "PVT_1", item_id: "PVTI_1" },
	],
	[
		registerProjectTools,
		"update_project_item_field",
		{ owner: "o", number: 4, item_id: "PVTI_1", field_id: "F_1", value: { text: "x" } },
		{ owner: "o", project_id: "PVT_1", item_id: "PVTI_1", field_id: "F_1" },
	],
	[
		registerProjectTools,
		"create_project_draft_item",
		{ owner: "o", number: 4, title: "t" },
		{ owner: "o", project_id: "PVT_1", item_id: "PVTI_1" },
	],
];

describe("every write tool emits exactly one audit line tagged with its own name", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each(
		WRITE_TOOLS.map(([register, toolName, params, extraExpected]) => ({
			register,
			toolName,
			params,
			extraExpected: extraExpected ?? { owner: "o", repo: "r" },
		})),
	)("$toolName", async ({ register, toolName, params, extraExpected }) => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { handlers, server } = captureHandlers();
		register(server, () => wideOctokit());
		await invoke(handlers, toolName, params);
		const entries = auditEntries(logSpy);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ tool: toolName, ...extraExpected });
	});
});
