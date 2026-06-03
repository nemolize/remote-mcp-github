import { afterEach, describe, expect, it, vi } from "vitest";

import { logWrite } from "../src/mcp/response.js";
import { registerBranchTools } from "../src/tools/branches.js";
import { registerFileTools } from "../src/tools/files.js";
import { registerIssueTools } from "../src/tools/issues.js";
import { registerPullTools } from "../src/tools/pulls.js";

const captureHandlers = () => {
	const handlers = new Map();
	const server = {
		registerTool: (name, _config, handler) => {
			handlers.set(name, handler);
		},
	};
	return { handlers, server };
};

const invoke = async (handlers, name, params) => {
	const handler = handlers.get(name);
	expect(handler, `tool ${name} was not registered`).toBeDefined();
	return handler(params);
};

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
		expect(line).toBe('[github-audit] {"tool":"commit_file","owner":"o","repo":"r","branch":"main","path":"a.ts"}');
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
						data: { commit: { sha: "deadbeef0000", html_url: "https://x/commit" }, content: { html_url: "https://x/file" } },
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
					createCommit: async () => ({ data: { sha: "commit00", html_url: "https://x" }, headers: {} }),
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
		await invoke(handlers, "create_branch", { owner: "o", repo: "r", branch: "feat", from: "main" });
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
