import { describe, expect, it } from "vitest";

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

// Octokit stub whose `graphql` member is driven by the test. The review-thread
// tools call `client().graphql(query, vars)` and ignore the REST surface, so
// only `graphql` needs stubbing here.
const stubOctokit = (graphql) => ({ graphql });

const invoke = async (handlers, name, params) => {
	const handler = handlers.get(name);
	expect(handler, `tool ${name} was not registered`).toBeDefined();
	return handler(params);
};

const threadsResult = (threads, { totalCount, hasNextPage = false } = {}) => ({
	repository: {
		pullRequest: {
			reviewThreads: {
				totalCount: totalCount ?? threads.length,
				pageInfo: { hasNextPage },
				nodes: threads,
			},
		},
	},
});

describe("registerPullTools — review thread tools", () => {
	it("registers all three review-thread tools", () => {
		const { handlers, server } = captureHandlers();
		registerPullTools(server, () => stubOctokit(async () => ({})));
		expect(handlers.has("list_pr_review_threads")).toBe(true);
		expect(handlers.has("resolve_review_thread")).toBe(true);
		expect(handlers.has("unresolve_review_thread")).toBe(true);
	});

	it("list_pr_review_threads renders thread id, state, author, location, snippet", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () =>
			threadsResult([
				{
					id: "PRRT_aaa",
					isResolved: false,
					isOutdated: false,
					comments: {
						nodes: [
							{
								author: { login: "alice" },
								path: "src/foo.ts",
								line: 12,
								body: "Please fix this\nsecond line ignored",
							},
						],
					},
				},
			]),
		);
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_review_threads", {
			owner: "o",
			repo: "r",
			pull_number: 5,
		});
		const body = result.content[0].text;
		expect(body).toContain("# Review threads on o/r#5 (1)");
		expect(body).toContain("`PRRT_aaa`");
		expect(body).toContain("unresolved");
		expect(body).toContain("@alice on src/foo.ts:12");
		expect(body).toContain("> Please fix this");
		expect(body).not.toContain("second line ignored");
		expect(result.isError).toBeUndefined();
	});

	it("list_pr_review_threads trims a long snippet with a plain ellipsis, not the paginate hint", async () => {
		const { handlers, server } = captureHandlers();
		const longBody = "x".repeat(200);
		const octokit = stubOctokit(async () =>
			threadsResult([
				{
					id: "PRRT_aaa",
					isResolved: false,
					isOutdated: false,
					comments: {
						nodes: [{ author: { login: "alice" }, path: "src/foo.ts", line: 1, body: longBody }],
					},
				},
			]),
		);
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_review_threads", {
			owner: "o",
			repo: "r",
			pull_number: 5,
		});
		const body = result.content[0].text;
		expect(body).toContain(`> ${"x".repeat(120)}…`);
		expect(body).not.toContain("paginate");
		expect(body).not.toContain("truncated;");
	});

	it("list_pr_review_threads forwards the `first` default and passes vars to graphql", async () => {
		const { handlers, server } = captureHandlers();
		let capturedVars;
		const octokit = stubOctokit(async (_query, vars) => {
			capturedVars = vars;
			return threadsResult([]);
		});
		registerPullTools(server, () => octokit);

		await invoke(handlers, "list_pr_review_threads", {
			owner: "o",
			repo: "r",
			pull_number: 5,
			first: 50,
		});
		expect(capturedVars).toEqual({ owner: "o", repo: "r", pull_number: 5, first: 50 });
	});

	it("list_pr_review_threads reports an empty thread list", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => threadsResult([]));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_review_threads", {
			owner: "o",
			repo: "r",
			pull_number: 5,
		});
		expect(result.content[0].text).toContain("No review threads.");
	});

	it("list_pr_review_threads shows a pagination hint when more threads exist", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () =>
			threadsResult(
				[
					{
						id: "PRRT_aaa",
						isResolved: true,
						isOutdated: true,
						comments: { nodes: [] },
					},
				],
				{ totalCount: 10, hasNextPage: true },
			),
		);
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_review_threads", {
			owner: "o",
			repo: "r",
			pull_number: 5,
		});
		const body = result.content[0].text;
		expect(body).toContain("resolved, outdated");
		expect(body).toContain("(unknown) on (no location)");
		expect(body).toContain("1 of 10 shown");
	});

	it("list_pr_review_threads errors when the PR is not found", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ repository: { pullRequest: null } }));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_review_threads", {
			owner: "o",
			repo: "r",
			pull_number: 999,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not found");
	});

	it("resolve_review_thread reports the resolved state and passes thread_id", async () => {
		const { handlers, server } = captureHandlers();
		let capturedVars;
		const octokit = stubOctokit(async (_query, vars) => {
			capturedVars = vars;
			return { resolveReviewThread: { thread: { id: "PRRT_aaa", isResolved: true } } };
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "resolve_review_thread", { thread_id: "PRRT_aaa" });
		expect(capturedVars).toEqual({ thread_id: "PRRT_aaa" });
		const body = result.content[0].text;
		expect(body).toContain("# Review thread resolved");
		expect(body).toContain("`PRRT_aaa` — resolved: true");
		expect(result.isError).toBeUndefined();
	});

	it("resolve_review_thread errors when the mutation returns no thread", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ resolveReviewThread: { thread: null } }));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "resolve_review_thread", { thread_id: "PRRT_bad" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to resolve review thread PRRT_bad");
	});

	it("unresolve_review_thread reports the re-opened state", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({
			unresolveReviewThread: { thread: { id: "PRRT_aaa", isResolved: false } },
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "unresolve_review_thread", { thread_id: "PRRT_aaa" });
		const body = result.content[0].text;
		expect(body).toContain("# Review thread re-opened");
		expect(body).toContain("`PRRT_aaa` — resolved: false");
		expect(result.isError).toBeUndefined();
	});

	it("review-thread tools propagate graphql errors via wrapTool", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => {
			throw new Error("Bad credentials");
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "resolve_review_thread", { thread_id: "PRRT_aaa" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Bad credentials");
	});
});
