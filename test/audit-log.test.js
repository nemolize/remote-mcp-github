import { afterEach, describe, expect, it, vi } from "vitest";

import { logWrite } from "../src/mcp/response.js";
import { registerBranchTools } from "../src/tools/branches.js";
import { registerFileTools } from "../src/tools/files.js";
import { registerIssueTools } from "../src/tools/issues.js";
import { registerPullTools } from "../src/tools/pulls.js";
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
// fixture covers all 14 — this keeps the all-tools coverage table below from
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
			},
		},
	};
};

// Every write tool, the register function that owns it, the minimal params it
// needs, and the audit `tool` name it must log. Read tools are intentionally
// absent — they must NOT emit an audit line.
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
];

describe("every write tool emits exactly one audit line tagged with its own name", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each(WRITE_TOOLS.map(([register, toolName, params]) => ({ register, toolName, params })))(
		"$toolName",
		async ({ register, toolName, params }) => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const { handlers, server } = captureHandlers();
			register(server, () => wideOctokit());
			await invoke(handlers, toolName, params);
			const entries = auditEntries(logSpy);
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ tool: toolName, owner: "o", repo: "r" });
		},
	);
});
