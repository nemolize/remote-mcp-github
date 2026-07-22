import { describe, expect, it, vi } from "vitest";

import { registerPullTools } from "../src/tools/pulls.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

// Octokit stub whose `graphql` member is driven by the test. The review-thread
// tools call `client().graphql(query, vars)` and ignore the REST surface, so
// only `graphql` needs stubbing here.
const stubOctokit = (graphql) => ({ graphql });

const threadsResult = (threads, { totalCount, hasNextPage = false, endCursor = null } = {}) => ({
	repository: {
		pullRequest: {
			reviewThreads: {
				totalCount: totalCount ?? threads.length,
				pageInfo: { hasNextPage, endCursor },
				nodes: threads,
			},
		},
	},
});

describe("registerPullTools — review thread tools", () => {
	it("registers all four review-thread tools", () => {
		const { handlers, server } = captureHandlers();
		registerPullTools(server, () => stubOctokit(async () => ({})));
		expect(handlers.has("list_pr_review_threads")).toBe(true);
		expect(handlers.has("list_pr_review_thread_comments")).toBe(true);
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
								databaseId: 4242,
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
		expect(body).toContain("reply to comment 4242");
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
		expect(capturedVars).toEqual({
			owner: "o",
			repo: "r",
			pull_number: 5,
			first: 50,
			after: undefined,
		});
	});

	it("list_pr_review_threads forwards the `after` cursor to graphql", async () => {
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
			after: "CURSOR_abc",
		});
		expect(capturedVars).toEqual({
			owner: "o",
			repo: "r",
			pull_number: 5,
			first: 50,
			after: "CURSOR_abc",
		});
	});

	it("list_pr_review_threads omits the snippet block for an empty-body comment", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () =>
			threadsResult([
				{
					id: "PRRT_aaa",
					isResolved: false,
					isOutdated: false,
					comments: {
						nodes: [{ author: { login: "alice" }, path: "src/foo.ts", line: 1, body: "" }],
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
		expect(body).toContain("@alice on src/foo.ts:1");
		expect(body).not.toContain("\n  > ");
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

	it("list_pr_review_threads shows a cursor pagination hint when more threads exist", async () => {
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
				{ totalCount: 10, hasNextPage: true, endCursor: "CURSOR_next" },
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
		expect(body).toContain('after: "CURSOR_next"');
		expect(body).not.toContain("Raise `first`");
	});

	it("list_pr_review_threads keeps the cursor hint when a large page overflows the truncation cap", async () => {
		const { handlers, server } = captureHandlers();
		// 100 threads each with a near-max-width snippet — the joined body easily
		// exceeds MAX_RESPONSE_CHARS (8000), so a naive "truncate(body + hint)"
		// would drop the trailing cursor and make later pages unreachable (#50).
		const bigThreads = Array.from({ length: 100 }, (_, i) => ({
			id: `PRRT_${i}`,
			isResolved: false,
			isOutdated: false,
			comments: {
				nodes: [{ author: { login: "alice" }, path: "src/foo.ts", line: i, body: "y".repeat(120) }],
			},
		}));
		const octokit = stubOctokit(async () =>
			threadsResult(bigThreads, { totalCount: 250, hasNextPage: true, endCursor: "CURSOR_tail" }),
		);
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_review_threads", {
			owner: "o",
			repo: "r",
			pull_number: 5,
		});
		const body = result.content[0].text;
		expect(body).toContain("truncated;");
		expect(body).toContain('after: "CURSOR_tail"');
	});

	it("list_pr_review_threads omits the pagination hint when there is no next page", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () =>
			threadsResult(
				[{ id: "PRRT_aaa", isResolved: false, isOutdated: false, comments: { nodes: [] } }],
				{ totalCount: 1, hasNextPage: false },
			),
		);
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_review_threads", {
			owner: "o",
			repo: "r",
			pull_number: 5,
		});
		const body = result.content[0].text;
		expect(body).not.toContain("shown; more results exist");
		expect(body).not.toContain("after:");
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

	// --- list_pr_review_thread_comments ---

	const threadCommentsResult = (
		comments,
		{ totalCount, hasNextPage = false, endCursor = null, threadId = "PRRT_zzz" } = {},
	) => ({
		node: {
			__typename: "PullRequestReviewThread",
			id: threadId,
			comments: {
				totalCount: totalCount ?? comments.length,
				pageInfo: { hasNextPage, endCursor },
				nodes: comments,
			},
		},
	});

	it("list_pr_review_thread_comments renders each comment with root/reply role, author, location, snippet", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () =>
			threadCommentsResult(
				[
					{
						databaseId: 4242,
						author: { login: "alice" },
						path: "src/foo.ts",
						line: 12,
						body: "Please fix this\nsecond line ignored",
						replyTo: null,
					},
					{
						databaseId: 4243,
						author: { login: "bob" },
						path: "src/foo.ts",
						line: 12,
						body: "Done in commit abc",
						replyTo: { databaseId: 4242 },
					},
				],
				{ threadId: "PRRT_aaa" },
			),
		);
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_review_thread_comments", {
			thread_id: "PRRT_aaa",
		});
		const body = result.content[0].text;
		expect(body).toContain("# Comments in review thread `PRRT_aaa` (2)");
		expect(body).toContain("- comment `4242` — root — @alice on src/foo.ts:12");
		expect(body).toContain("  > Please fix this");
		expect(body).toContain("- comment `4243` — reply to `4242` — @bob on src/foo.ts:12");
		expect(body).toContain("  > Done in commit abc");
	});

	it("list_pr_review_thread_comments passes thread_id / first / after to graphql", async () => {
		const { handlers, server } = captureHandlers();
		let capturedVars;
		const octokit = stubOctokit(async (_query, vars) => {
			capturedVars = vars;
			return threadCommentsResult([], { threadId: "PRRT_aaa" });
		});
		registerPullTools(server, () => octokit);

		await invoke(handlers, "list_pr_review_thread_comments", {
			thread_id: "PRRT_aaa",
			first: 10,
			after: "CURSOR_x",
		});
		expect(capturedVars).toEqual({ thread_id: "PRRT_aaa", first: 10, after: "CURSOR_x" });
	});

	it("list_pr_review_thread_comments forwards first/after as-passed", async () => {
		// The raw handler bypasses Zod, so `.default(30)` isn't applied — pass `first` explicitly.
		const { handlers, server } = captureHandlers();
		let capturedVars;
		const octokit = stubOctokit(async (_query, vars) => {
			capturedVars = vars;
			return threadCommentsResult([], { threadId: "PRRT_aaa" });
		});
		registerPullTools(server, () => octokit);

		await invoke(handlers, "list_pr_review_thread_comments", {
			thread_id: "PRRT_aaa",
			first: 30,
		});
		expect(capturedVars).toEqual({
			thread_id: "PRRT_aaa",
			first: 30,
			after: undefined,
		});
	});

	it("list_pr_review_thread_comments reports an empty page with totalCount", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () =>
			threadCommentsResult([], { totalCount: 0, threadId: "PRRT_empty" }),
		);
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_review_thread_comments", {
			thread_id: "PRRT_empty",
		});
		const body = result.content[0].text;
		expect(body).toContain("# Comments in review thread `PRRT_empty` (0/0)");
		expect(body).toContain("No comments on this page.");
	});

	it("list_pr_review_thread_comments shows a pagination hint when hasNextPage", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () =>
			threadCommentsResult(
				[
					{
						databaseId: 1,
						author: { login: "alice" },
						path: "a",
						line: 1,
						body: "hi",
						replyTo: null,
					},
				],
				{ totalCount: 50, hasNextPage: true, endCursor: "CURSOR_more", threadId: "PRRT_aaa" },
			),
		);
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_review_thread_comments", {
			thread_id: "PRRT_aaa",
		});
		const body = result.content[0].text;
		expect(body).toContain('after: "CURSOR_more"');
	});

	it("list_pr_review_thread_comments omits the pagination hint when no next page", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () =>
			threadCommentsResult(
				[
					{
						databaseId: 1,
						author: { login: "alice" },
						path: "a",
						line: 1,
						body: "hi",
						replyTo: null,
					},
				],
				{ totalCount: 1, hasNextPage: false, threadId: "PRRT_aaa" },
			),
		);
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_review_thread_comments", {
			thread_id: "PRRT_aaa",
		});
		const body = result.content[0].text;
		expect(body).not.toContain("after:");
	});

	it("list_pr_review_thread_comments keeps the cursor hint when a large page overflows the truncation cap", async () => {
		// Parallel to the sibling #50 regression test on list_pr_review_threads:
		// a thread with 100 long-snippet comments overflows MAX_RESPONSE_CHARS (8000),
		// so a naive `truncate(body + hint)` would drop the trailing cursor and make
		// later pages unreachable. The tool reserves the hint's length before
		// truncating body, so both survive.
		const { handlers, server } = captureHandlers();
		const bigComments = Array.from({ length: 100 }, (_, i) => ({
			databaseId: 1000 + i,
			author: { login: "alice" },
			path: "src/foo.ts",
			line: i,
			body: "y".repeat(120),
			replyTo: i === 0 ? null : { databaseId: 1000 },
		}));
		const octokit = stubOctokit(async () =>
			threadCommentsResult(bigComments, {
				totalCount: 250,
				hasNextPage: true,
				endCursor: "CURSOR_tail",
				threadId: "PRRT_big",
			}),
		);
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_review_thread_comments", {
			thread_id: "PRRT_big",
		});
		const body = result.content[0].text;
		expect(body).toContain("truncated;");
		expect(body).toContain('after: "CURSOR_tail"');
	});

	it("list_pr_review_thread_comments handles a missing databaseId gracefully", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () =>
			threadCommentsResult(
				[
					{
						databaseId: null,
						author: null,
						path: null,
						line: null,
						body: "",
						replyTo: null,
					},
				],
				{ threadId: "PRRT_aaa" },
			),
		);
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_review_thread_comments", {
			thread_id: "PRRT_aaa",
		});
		const body = result.content[0].text;
		expect(body).toContain("- comment (no databaseId) — root — (unknown) on (no location)");
	});

	it("list_pr_review_thread_comments renders a reply as reply even if parent databaseId is null", async () => {
		// Defensive: a reply always carries `replyTo` (non-null); the parent's
		// databaseId can be null (deleted parent, permission gap). The role tag
		// must stay "reply to …" instead of silently collapsing to "root".
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () =>
			threadCommentsResult(
				[
					{
						databaseId: 999,
						author: { login: "bob" },
						path: "a",
						line: 1,
						body: "orphaned reply",
						replyTo: { databaseId: null },
					},
				],
				{ threadId: "PRRT_aaa" },
			),
		);
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_review_thread_comments", {
			thread_id: "PRRT_aaa",
		});
		const body = result.content[0].text;
		expect(body).toContain("reply to (unknown)");
		expect(body).not.toContain("— root —");
	});

	it("list_pr_review_thread_comments errors when the node is not found", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ node: null }));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_review_thread_comments", {
			thread_id: "PRRT_missing",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not found");
	});

	it("list_pr_review_thread_comments errors when the node is a different type", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ node: { __typename: "Issue" } }));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_review_thread_comments", {
			thread_id: "I_notathread",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not a PullRequestReviewThread");
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

// Octokit stub exposing only `rest.pulls.get`, which is all get_pull_request calls.
const stubPullsGet = (impl) => ({ rest: { pulls: { get: impl } } });

const prData = (overrides = {}) => ({
	number: 42,
	node_id: "PR_abc123",
	title: "Add widget",
	state: "open",
	merged: false,
	merged_at: null,
	draft: false,
	mergeable_state: "clean",
	user: { login: "alice" },
	requested_reviewers: [{ login: "bob" }],
	requested_teams: [{ slug: "core" }],
	head: { ref: "feature/widget", sha: "abcdef1234567890" },
	base: { ref: "main", sha: "1234567abcdef890" },
	commits: 3,
	additions: 120,
	deletions: 8,
	changed_files: 5,
	created_at: "2026-06-01T00:00:00Z",
	updated_at: "2026-06-02T00:00:00Z",
	body: "PR body text",
	html_url: "https://github.com/o/r/pull/42",
	...overrides,
});

describe("registerPullTools — get_pull_request", () => {
	it("registers get_pull_request", () => {
		const { handlers, server } = captureHandlers();
		registerPullTools(server, () => stubPullsGet(async () => ({ data: prData(), headers: {} })));
		expect(handlers.has("get_pull_request")).toBe(true);
	});

	it("renders state, mergeable, head/base SHAs, reviewers, counts, and body", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubPullsGet(async () => ({ data: prData(), headers: {} }));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		const body = result.content[0].text;
		expect(body).toContain("# PR #42: Add widget");
		expect(body).toContain("state: **open**");
		expect(body).toContain("mergeable: clean");
		expect(body).toContain("`feature/widget` (abcdef1) → `main` (1234567)");
		expect(body).toContain("requested_reviewers: @bob, @o/core");
		expect(body).toContain("commits: 3, +120 / -8 across 5 file(s)");
		expect(body).toContain("- node_id: `PR_abc123`");
		expect(body).toContain("PR body text");
		expect(result.isError).toBeUndefined();
	});

	it("reports merged state and merged_at when the PR is merged", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubPullsGet(async () => ({
			data: prData({ merged: true, merged_at: "2026-06-03T00:00:00Z", state: "closed" }),
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		const body = result.content[0].text;
		expect(body).toContain("state: **merged**");
		expect(body).toContain("merged: 2026-06-03T00:00:00Z");
	});

	it("falls back to placeholders for missing optional fields", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubPullsGet(async () => ({
			data: prData({
				draft: true,
				mergeable_state: null,
				requested_reviewers: [],
				requested_teams: [],
				body: null,
			}),
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		const body = result.content[0].text;
		expect(body).toContain("# PR #42: Add widget (draft)");
		expect(body).toContain("mergeable: unknown");
		expect(body).toContain("requested_reviewers: (none)");
		expect(body).toContain("(no body)");
	});

	it("propagates REST errors via wrapTool", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubPullsGet(async () => {
			throw new Error("Not Found");
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request", {
			owner: "o",
			repo: "r",
			pull_number: 999,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Not Found");
	});
});

// Octokit stub exposing only `rest.pulls.listFiles`.
const stubListFiles = (impl) => ({ rest: { pulls: { listFiles: impl } } });

describe("registerPullTools — get_pull_request_files", () => {
	it("registers get_pull_request_files", () => {
		const { handlers, server } = captureHandlers();
		registerPullTools(server, () => stubListFiles(async () => ({ data: [], headers: {} })));
		expect(handlers.has("get_pull_request_files")).toBe(true);
	});

	it("renders status, filename, additions/deletions, and a patch snippet", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubListFiles(async () => ({
			data: [
				{
					filename: "src/foo.ts",
					status: "modified",
					additions: 10,
					deletions: 2,
					changes: 12,
					// previewLine collapses all whitespace (incl. newlines) into single
					// spaces before applying its length cap — this patch is well under
					// 160 chars, so every hunk line is expected to survive in the snippet.
					patch: "@@ -1,3 +1,3 @@\n-old\n+new",
				},
				{ filename: "src/bar.ts", status: "added", additions: 5, deletions: 0, changes: 5 },
			],
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request_files", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		const body = result.content[0].text;
		expect(body).toContain("# Files changed in o/r#42 (2)");
		expect(body).toContain("**modified** `src/foo.ts` (+10/-2)");
		expect(body).toContain("> @@ -1,3 +1,3 @@ -old +new");
		expect(body).toContain("**added** `src/bar.ts` (+5/-0)");
		expect(result.isError).toBeUndefined();
	});

	it("truncates a patch snippet past 160 collapsed characters with an ellipsis", async () => {
		const { handlers, server } = captureHandlers();
		const longPatch = `@@ -1,3 +1,3 @@\n${"x".repeat(200)}`;
		const octokit = stubListFiles(async () => ({
			data: [
				{
					filename: "src/foo.ts",
					status: "modified",
					additions: 1,
					deletions: 1,
					changes: 2,
					patch: longPatch,
				},
			],
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request_files", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		const body = result.content[0].text;
		expect(body).toContain(`> @@ -1,3 +1,3 @@ ${"x".repeat(160 - "@@ -1,3 +1,3 @@ ".length)}…`);
		expect(body).not.toContain("x".repeat(161));
	});

	it("omits the patch block for a file with no patch (e.g. binary)", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubListFiles(async () => ({
			data: [{ filename: "img.png", status: "added", additions: 0, deletions: 0, changes: 0 }],
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request_files", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		expect(result.content[0].text).not.toContain("\n  > ");
	});

	it("reports no files when the PR has no changes", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubListFiles(async () => ({ data: [], headers: {} }));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request_files", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		expect(result.content[0].text).toContain("No files changed.");
	});

	it("surfaces a pagination hint when more pages exist", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubListFiles(async () => ({
			data: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 1, changes: 2 }],
			headers: { link: '<https://api.github.com/...&page=2>; rel="next"' },
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request_files", {
			owner: "o",
			repo: "r",
			pull_number: 42,
			page: 1,
		});
		expect(result.content[0].text).toContain("page 1, 1 shown; more available");
	});

	it("propagates REST errors via wrapTool", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubListFiles(async () => {
			throw new Error("Not Found");
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request_files", {
			owner: "o",
			repo: "r",
			pull_number: 999,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Not Found");
	});
});

// Octokit stub exposing `rest.pulls.get`, `rest.checks.listForRef`, and
// `rest.repos.getCombinedStatusForRef` — everything get_pull_request_status calls.
// `checkRunPages` is an array of check-run arrays, one per page (in `page` order),
// letting pagination tests drive multi-page responses; a single flat `checkRuns`
// array is sugar for the common one-page case.
const stubPrStatus = ({
	prHeadSha = "deadbeef1234567890",
	checkRuns,
	checkRunPages,
	combinedStatus,
}) => {
	const pages = checkRunPages ?? (checkRuns != null ? [checkRuns] : [[]]);
	const listForRefCalls = [];
	return {
		rest: {
			pulls: { get: async () => ({ data: { head: { sha: prHeadSha } }, headers: {} }) },
			checks: {
				listForRef: async ({ page = 1 }) => {
					listForRefCalls.push(page);
					const runs = pages[page - 1] ?? [];
					return { data: { total_count: pages.flat().length, check_runs: runs }, headers: {} };
				},
			},
			repos: {
				getCombinedStatusForRef: async () => ({
					data: combinedStatus ?? { state: "pending", total_count: 0, statuses: [] },
					headers: {},
				}),
			},
		},
		listForRefCalls,
	};
};

describe("registerPullTools — get_pull_request_status", () => {
	it("registers get_pull_request_status", () => {
		const { handlers, server } = captureHandlers();
		registerPullTools(server, () => stubPrStatus({}));
		expect(handlers.has("get_pull_request_status")).toBe(true);
	});

	it("reports overall success when every check-run concluded success", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubPrStatus({
			checkRuns: [
				{ name: "build", status: "completed", conclusion: "success" },
				{ name: "test", status: "completed", conclusion: "success" },
			],
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request_status", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		const body = result.content[0].text;
		expect(body).toContain("# PR status for o/r#42");
		expect(body).toContain("head sha: `deadbee`");
		expect(body).toContain("overall: **success**");
		expect(body).toContain("build: **completed** — success");
		expect(body).toContain("test: **completed** — success");
		expect(result.isError).toBeUndefined();
	});

	it("reports overall failure when any check-run concluded failure", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubPrStatus({
			checkRuns: [
				{ name: "build", status: "completed", conclusion: "success" },
				{ name: "test", status: "completed", conclusion: "failure" },
			],
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request_status", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		expect(result.content[0].text).toContain("overall: **failure**");
	});

	it("reports overall pending while a check-run is still in progress", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubPrStatus({
			checkRuns: [{ name: "build", status: "in_progress", conclusion: null }],
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request_status", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		const body = result.content[0].text;
		expect(body).toContain("overall: **pending**");
		expect(body).toContain("build: **in_progress** — (pending)");
	});

	it("treats a neutral conclusion as non-blocking (overall still success)", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubPrStatus({
			checkRuns: [
				{ name: "build", status: "completed", conclusion: "success" },
				{ name: "optional-lint", status: "completed", conclusion: "neutral" },
			],
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request_status", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		expect(result.content[0].text).toContain("overall: **success**");
	});

	it("treats a skipped conclusion as non-blocking (overall still success)", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubPrStatus({
			checkRuns: [
				{ name: "build", status: "completed", conclusion: "success" },
				{ name: "skipped-job", status: "completed", conclusion: "skipped" },
			],
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request_status", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		expect(result.content[0].text).toContain("overall: **success**");
	});

	it("reports overall failure when a required legacy status fails despite all check-runs succeeding", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubPrStatus({
			checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
			combinedStatus: {
				state: "failure",
				total_count: 1,
				statuses: [{ context: "ci/legacy-required", state: "failure" }],
			},
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request_status", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		expect(result.content[0].text).toContain("overall: **failure**");
	});

	it("falls back to the legacy combined status when there are no check-runs", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubPrStatus({
			combinedStatus: {
				state: "success",
				total_count: 1,
				statuses: [{ context: "ci/legacy", state: "success" }],
			},
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request_status", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		const body = result.content[0].text;
		expect(body).toContain("overall: **success**");
		expect(body).toContain("## Check runs (0)");
		expect(body).toContain("## Legacy commit statuses (1)");
		expect(body).toContain("ci/legacy: **success**");
	});

	it("pages past 100 check-runs and evaluates the full set for the overall verdict", async () => {
		const { handlers, server } = captureHandlers();
		const page1 = Array.from({ length: 100 }, (_, i) => ({
			name: `job-${i}`,
			status: "completed",
			conclusion: "success",
		}));
		const page2 = [{ name: "job-100", status: "completed", conclusion: "failure" }];
		const octokit = stubPrStatus({ checkRunPages: [page1, page2] });
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request_status", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		const body = result.content[0].text;
		expect(octokit.listForRefCalls).toEqual([1, 2]);
		expect(body).toContain("## Check runs (101)");
		expect(body).toContain("overall: **failure**");
		expect(body).toContain("job-100: **completed** — failure");
	});

	it("stops paging once a page returns fewer than 100 check-runs", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubPrStatus({
			checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
		});
		registerPullTools(server, () => octokit);

		await invoke(handlers, "get_pull_request_status", { owner: "o", repo: "r", pull_number: 42 });
		expect(octokit.listForRefCalls).toEqual([1]);
	});

	it("propagates REST errors via wrapTool", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = {
			rest: {
				pulls: {
					get: async () => {
						throw new Error("Not Found");
					},
				},
			},
		};
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "get_pull_request_status", {
			owner: "o",
			repo: "r",
			pull_number: 999,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Not Found");
	});
});

// Octokit stub exposing only `rest.pulls.listReviews`.
const stubListReviews = (impl) => ({ rest: { pulls: { listReviews: impl } } });

describe("registerPullTools — list_pr_reviews", () => {
	it("registers list_pr_reviews", () => {
		const { handlers, server } = captureHandlers();
		registerPullTools(server, () => stubListReviews(async () => ({ data: [], headers: {} })));
		expect(handlers.has("list_pr_reviews")).toBe(true);
	});

	it("renders each review's author, state, submitted_at, and body snippet", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubListReviews(async () => ({
			data: [
				{
					user: { login: "alice" },
					state: "APPROVED",
					submitted_at: "2026-06-01T00:00:00Z",
					body: "LGTM\nsecond line ignored",
				},
				{
					user: { login: "bob" },
					state: "CHANGES_REQUESTED",
					submitted_at: "2026-06-02T00:00:00Z",
					body: "",
				},
			],
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_reviews", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		const body = result.content[0].text;
		expect(body).toContain("# Reviews on o/r#42 (2)");
		expect(body).toContain("@alice — **APPROVED** (2026-06-01T00:00:00Z)");
		expect(body).toContain("> LGTM");
		expect(body).not.toContain("second line ignored");
		expect(body).toContain("@bob — **CHANGES_REQUESTED** (2026-06-02T00:00:00Z)");
		expect(result.isError).toBeUndefined();
	});

	it("reports no reviews when the list is empty", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubListReviews(async () => ({ data: [], headers: {} }));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_reviews", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		expect(result.content[0].text).toContain("No reviews submitted.");
	});

	it("surfaces a pagination hint when more pages exist", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubListReviews(async () => ({
			data: [{ user: { login: "alice" }, state: "COMMENTED", submitted_at: null, body: "" }],
			headers: { link: '<https://api.github.com/...&page=2>; rel="next"' },
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_reviews", {
			owner: "o",
			repo: "r",
			pull_number: 42,
			page: 1,
		});
		const body = result.content[0].text;
		expect(body).toContain("page 1, 1 shown; more available");
	});

	it("falls back to (unknown) when a review has no user", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubListReviews(async () => ({
			data: [{ user: null, state: "DISMISSED", submitted_at: "2026-06-01T00:00:00Z", body: "" }],
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_reviews", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		expect(result.content[0].text).toContain("(unknown) — **DISMISSED**");
	});

	it("omits the snippet block for a whitespace-only body", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubListReviews(async () => ({
			data: [{ user: { login: "alice" }, state: "COMMENTED", submitted_at: null, body: "   " }],
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_reviews", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		expect(result.content[0].text).not.toContain("\n  > ");
	});

	it("propagates REST errors via wrapTool", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubListReviews(async () => {
			throw new Error("Not Found");
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "list_pr_reviews", {
			owner: "o",
			repo: "r",
			pull_number: 999,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Not Found");
	});
});

// Octokit stub exposing only `rest.pulls.update`. `impl` receives the call args
// directly (so a throwing impl rejects cleanly via the same promise the handler
// awaits); the test reads back the captured args from `calls`.
const stubPullsUpdate = (impl) => {
	const calls = [];
	const octokit = {
		rest: {
			pulls: {
				update: (args) => {
					calls.push(args);
					return impl(args);
				},
			},
		},
	};
	return { octokit, calls };
};

const updatedPr = (overrides = {}) => ({
	number: 42,
	title: "Updated title",
	state: "open",
	merged: false,
	base: { ref: "main" },
	html_url: "https://github.com/o/r/pull/42",
	...overrides,
});

describe("registerPullTools — update_pull_request", () => {
	it("registers update_pull_request", () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = stubPullsUpdate(async () => ({ data: updatedPr(), headers: {} }));
		registerPullTools(server, () => octokit);
		expect(handlers.has("update_pull_request")).toBe(true);
	});

	it("updates title and renders the new state and base", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubPullsUpdate(async () => ({
			data: updatedPr({ title: "New title" }),
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "update_pull_request", {
			owner: "o",
			repo: "r",
			pull_number: 42,
			title: "New title",
		});
		const body = result.content[0].text;
		expect(body).toContain("# Pull request updated");
		expect(body).toContain("**New title** (#42) — state: **open** → base `main`");
		expect(calls[0]).toEqual({ owner: "o", repo: "r", pull_number: 42, title: "New title" });
		expect(result.isError).toBeUndefined();
	});

	it("passes an empty-string body through to clear it", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubPullsUpdate(async () => ({ data: updatedPr(), headers: {} }));
		registerPullTools(server, () => octokit);

		await invoke(handlers, "update_pull_request", {
			owner: "o",
			repo: "r",
			pull_number: 42,
			body: "",
		});
		expect(calls[0]).toEqual({ owner: "o", repo: "r", pull_number: 42, body: "" });
	});

	it("renders merged state when closing a merged PR", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = stubPullsUpdate(async () => ({
			data: updatedPr({ merged: true, state: "closed" }),
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "update_pull_request", {
			owner: "o",
			repo: "r",
			pull_number: 42,
			state: "closed",
		});
		expect(result.content[0].text).toContain("state: **merged**");
	});

	it("rejects a call with no fields to update without hitting the API", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubPullsUpdate(async () => ({ data: updatedPr(), headers: {} }));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "update_pull_request", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Provide at least one field");
		expect(calls).toHaveLength(0);
	});

	it("propagates REST errors via wrapTool", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = stubPullsUpdate(async () => {
			throw new Error("Not Found");
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "update_pull_request", {
			owner: "o",
			repo: "r",
			pull_number: 999,
			title: "x",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Not Found");
	});
});

// Octokit stub exposing only `rest.pulls.updateBranch`. `impl` receives the call
// args directly; the test reads back the captured args from `calls`.
const stubUpdateBranch = (impl) => {
	const calls = [];
	const octokit = {
		rest: {
			pulls: {
				updateBranch: (args) => {
					calls.push(args);
					return impl(args);
				},
			},
		},
	};
	return { octokit, calls };
};

describe("registerPullTools — update_pull_request_branch", () => {
	it("registers update_pull_request_branch", () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = stubUpdateBranch(async () => ({
			data: { message: "Updating branch." },
			headers: {},
		}));
		registerPullTools(server, () => octokit);
		expect(handlers.has("update_pull_request_branch")).toBe(true);
	});

	it("queues the branch update and renders the response message", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubUpdateBranch(async () => ({
			data: { message: "Updating pull request branch." },
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "update_pull_request_branch", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		const body = result.content[0].text;
		expect(body).toContain("# Pull request branch update queued");
		expect(body).toContain("PR #42 on o/r");
		expect(body).toContain("Updating pull request branch.");
		expect(calls[0]).toEqual({ owner: "o", repo: "r", pull_number: 42 });
		expect(result.isError).toBeUndefined();
	});

	it("passes expected_head_sha through as a concurrency guard", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubUpdateBranch(async () => ({
			data: { message: "Updating branch." },
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		await invoke(handlers, "update_pull_request_branch", {
			owner: "o",
			repo: "r",
			pull_number: 42,
			expected_head_sha: "abc123",
		});
		expect(calls[0]).toEqual({
			owner: "o",
			repo: "r",
			pull_number: 42,
			expected_head_sha: "abc123",
		});
	});

	it("propagates REST errors via wrapTool (e.g. 422 when not behind base)", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = stubUpdateBranch(async () => {
			throw new Error("Validation Failed");
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "update_pull_request_branch", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Validation Failed");
	});
});

// Octokit stub exposing only `rest.pulls.merge`, capturing the args passed.
const stubPullsMerge = (impl) => {
	const calls = [];
	const octokit = {
		rest: {
			pulls: {
				merge: (args) => {
					calls.push(args);
					return impl(args);
				},
			},
		},
	};
	return { octokit, calls };
};

describe("registerPullTools — merge_pull_request", () => {
	it("registers merge_pull_request", () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = stubPullsMerge(async () => ({
			data: { merged: true, sha: "deadbeef", message: "Pull Request successfully merged" },
			headers: {},
		}));
		registerPullTools(server, () => octokit);
		expect(handlers.has("merge_pull_request")).toBe(true);
	});

	it("merges and reports the merge commit SHA", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubPullsMerge(async () => ({
			data: { merged: true, sha: "deadbeef", message: "Pull Request successfully merged" },
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			// The raw handler bypasses Zod, so the `merge_method` default isn't applied
			// here — pass it explicitly, mirroring what the framework hands the handler.
			const result = await invoke(handlers, "merge_pull_request", {
				owner: "o",
				repo: "r",
				pull_number: 42,
				merge_method: "merge",
			});
			const body = result.content[0].text;
			expect(body).toContain("# Pull request merged");
			expect(body).toContain("PR #42 merged via `merge`");
			expect(body).toContain("merge commit: `deadbeef`");
			expect(calls[0]).toEqual({ owner: "o", repo: "r", pull_number: 42, merge_method: "merge" });
			expect(result.isError).toBeUndefined();
			// A successful merge records exactly one audit line.
			const auditLines = logSpy.mock.calls.filter(([first]) =>
				String(first).includes("[github-audit]"),
			);
			expect(auditLines).toHaveLength(1);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("forwards squash method, commit_title/message, and sha guard", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubPullsMerge(async () => ({
			data: { merged: true, sha: "cafe1234", message: "merged" },
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		await invoke(handlers, "merge_pull_request", {
			owner: "o",
			repo: "r",
			pull_number: 42,
			merge_method: "squash",
			commit_title: "Squashed!",
			commit_message: "body",
			sha: "abc123",
		});
		expect(calls[0]).toEqual({
			owner: "o",
			repo: "r",
			pull_number: 42,
			merge_method: "squash",
			commit_title: "Squashed!",
			commit_message: "body",
			sha: "abc123",
		});
	});

	it("returns an error and emits no audit log when the API reports the PR was not merged", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = stubPullsMerge(async () => ({
			data: { merged: false, sha: "", message: "Base branch was modified. Review and try again." },
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		// `logWrite` emits a `[github-audit]` line via console.log on success only;
		// a non-merge must not record a write event.
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const result = await invoke(handlers, "merge_pull_request", {
				owner: "o",
				repo: "r",
				pull_number: 42,
			});
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("Merge not completed for #42");
			expect(result.content[0].text).toContain("Base branch was modified");
			const auditLines = logSpy.mock.calls.filter(([first]) =>
				String(first).includes("[github-audit]"),
			);
			expect(auditLines).toHaveLength(0);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("propagates REST errors (e.g. 405 disallowed method) via wrapTool", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = stubPullsMerge(async () => {
			throw new Error("Rebase merges are not allowed on this repository");
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "merge_pull_request", {
			owner: "o",
			repo: "r",
			pull_number: 42,
			merge_method: "rebase",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Rebase merges are not allowed");
	});
});

const stubCreateReply = (impl) => {
	const calls = [];
	const octokit = {
		rest: {
			pulls: {
				createReplyForReviewComment: (args) => {
					calls.push(args);
					return impl(args);
				},
			},
		},
	};
	return { octokit, calls };
};

const replyData = (overrides = {}) => ({
	user: { login: "octocat" },
	html_url: "https://github.com/o/r/pull/42#discussion_r999",
	...overrides,
});

describe("registerPullTools — add_pr_review_comment_reply", () => {
	it("registers add_pr_review_comment_reply", () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = stubCreateReply(async () => ({ data: replyData(), headers: {} }));
		registerPullTools(server, () => octokit);
		expect(handlers.has("add_pr_review_comment_reply")).toBe(true);
	});

	it("posts a reply and renders the author and url", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubCreateReply(async () => ({ data: replyData(), headers: {} }));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "add_pr_review_comment_reply", {
			owner: "o",
			repo: "r",
			pull_number: 42,
			comment_id: 555,
			body: "Thanks, fixed.",
		});
		const body = result.content[0].text;
		expect(body).toContain("# Review comment reply posted");
		expect(body).toContain("in reply to comment 555 on o/r#42");
		expect(body).toContain("@octocat");
		expect(body).toContain("#discussion_r999");
		expect(calls[0]).toEqual({
			owner: "o",
			repo: "r",
			pull_number: 42,
			comment_id: 555,
			body: "Thanks, fixed.",
		});
		expect(result.isError).toBeUndefined();
	});

	it("renders (unknown) when the reply has no user", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = stubCreateReply(async () => ({
			data: replyData({ user: null }),
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "add_pr_review_comment_reply", {
			owner: "o",
			repo: "r",
			pull_number: 42,
			comment_id: 555,
			body: "ok",
		});
		expect(result.content[0].text).toContain("by (unknown)");
	});
});

const stubCreateReview = (impl) => {
	const calls = [];
	const octokit = {
		rest: {
			pulls: {
				createReview: (args) => {
					calls.push(args);
					return impl(args);
				},
			},
		},
	};
	return { octokit, calls };
};

const reviewData = (overrides = {}) => ({
	id: 12345,
	state: "APPROVED",
	html_url: "https://github.com/o/r/pull/42#pullrequestreview-12345",
	...overrides,
});

describe("registerPullTools — create_pr_review", () => {
	it("registers create_pr_review", () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = stubCreateReview(async () => ({ data: reviewData(), headers: {} }));
		registerPullTools(server, () => octokit);
		expect(handlers.has("create_pr_review")).toBe(true);
	});

	it("submits an APPROVE without a body and renders the state", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubCreateReview(async () => ({
			data: reviewData(),
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "create_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 42,
			event: "APPROVE",
		});
		const body = result.content[0].text;
		expect(body).toContain("# Review submitted");
		expect(body).toContain("**APPROVED** on o/r#42");
		expect(body).not.toContain("inline comment");
		expect(calls[0]).toEqual({ owner: "o", repo: "r", pull_number: 42, event: "APPROVE" });
		expect(result.isError).toBeUndefined();
	});

	it("requires a body for REQUEST_CHANGES without hitting the API", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubCreateReview(async () => ({
			data: reviewData(),
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "create_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 42,
			event: "REQUEST_CHANGES",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("non-empty `body` is required");
		expect(calls).toHaveLength(0);
	});

	it("submits inline comments and strips per-element undefined", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubCreateReview(async () => ({
			data: reviewData({ state: "COMMENTED" }),
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "create_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 42,
			event: "COMMENT",
			body: "A couple of notes.",
			comments: [{ path: "src/foo.ts", line: 10, body: "rename this" }],
		});
		const body = result.content[0].text;
		expect(body).toContain("**COMMENTED** on o/r#42 with 1 inline comment(s)");
		// `side` / `start_line` were omitted; they must not reach Octokit as undefined.
		expect(calls[0].comments).toEqual([{ path: "src/foo.ts", line: 10, body: "rename this" }]);
		expect(result.isError).toBeUndefined();
	});

	it("passes a multi-line comment's side / start_line / start_side through unchanged", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubCreateReview(async () => ({
			data: reviewData({ state: "CHANGES_REQUESTED" }),
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "create_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 42,
			event: "REQUEST_CHANGES",
			body: "Range finding.",
			comments: [
				{
					path: "src/foo.ts",
					line: 20,
					side: "RIGHT",
					start_line: 18,
					start_side: "RIGHT",
					body: "this whole block",
				},
			],
		});
		expect(result.content[0].text).toContain(
			"**CHANGES_REQUESTED** on o/r#42 with 1 inline comment(s)",
		);
		// Provided values must survive the per-element strip (it drops only undefined).
		expect(calls[0].comments).toEqual([
			{
				path: "src/foo.ts",
				line: 20,
				side: "RIGHT",
				start_line: 18,
				start_side: "RIGHT",
				body: "this whole block",
			},
		]);
		expect(result.isError).toBeUndefined();
	});

	it("rejects a whitespace-only body for REQUEST_CHANGES without hitting the API", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubCreateReview(async () => ({
			data: reviewData(),
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "create_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 42,
			event: "REQUEST_CHANGES",
			body: "   ",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("non-empty `body` is required");
		expect(calls).toHaveLength(0);
	});

	it("surfaces the GitHub error when approving your own PR", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = stubCreateReview(async () => {
			throw new Error("Unprocessable Entity: Can not approve your own pull request");
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "create_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 42,
			event: "APPROVE",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Can not approve your own pull request");
	});
});

const pendingReviewData = (overrides = {}) => ({
	id: 42,
	node_id: "PRR_pending_42",
	state: "PENDING",
	body: null,
	html_url: "https://github.com/o/r/pull/7#pullrequestreview-42",
	...overrides,
});

const stubPendingReviewOctokit = ({
	createReview,
	getReview,
	submitReview,
	deletePendingReview,
	graphql,
} = {}) => {
	const calls = {
		createReview: [],
		getReview: [],
		submitReview: [],
		deletePendingReview: [],
		graphql: [],
	};
	const octokit = {
		rest: {
			pulls: {
				createReview: async (args) => {
					calls.createReview.push(args);
					return (createReview ?? (async () => ({ data: pendingReviewData(), headers: {} })))(args);
				},
				getReview: async (args) => {
					calls.getReview.push(args);
					return (getReview ?? (async () => ({ data: pendingReviewData(), headers: {} })))(args);
				},
				submitReview: async (args) => {
					calls.submitReview.push(args);
					return (
						submitReview ??
						(async () => ({ data: pendingReviewData({ state: "COMMENTED" }), headers: {} }))
					)(args);
				},
				deletePendingReview: async (args) => {
					calls.deletePendingReview.push(args);
					return (deletePendingReview ?? (async () => ({ data: {}, headers: {} })))(args);
				},
			},
		},
		graphql: async (query, vars) => {
			calls.graphql.push({ query, vars });
			return (
				graphql ??
				(async () => ({
					addPullRequestReviewThread: {
						thread: { id: "PRRT_1", comments: { nodes: [{ databaseId: 101 }] } },
					},
				}))
			)(query, vars);
		},
	};
	return { octokit, calls };
};

describe("registerPullTools — pending pr review lifecycle", () => {
	it("registers all four pending-review tools", () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = stubPendingReviewOctokit();
		registerPullTools(server, () => octokit);
		expect(handlers.has("create_pending_pr_review")).toBe(true);
		expect(handlers.has("add_comment_to_pending_pr_review")).toBe(true);
		expect(handlers.has("submit_pending_pr_review")).toBe(true);
		expect(handlers.has("delete_pending_pr_review")).toBe(true);
	});

	it("create_pending_pr_review surfaces both review_id and node_id", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubPendingReviewOctokit();
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "create_pending_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 7,
			body: "draft summary",
		});
		const body = result.content[0].text;
		expect(body).toContain("# Pending review created");
		expect(body).toContain("review_id: `42`");
		expect(body).toContain("node_id: `PRR_pending_42`");
		expect(body).toContain("state: **PENDING**");
		expect(calls.createReview[0]).toEqual({
			owner: "o",
			repo: "r",
			pull_number: 7,
			body: "draft summary",
		});
		expect(result.isError).toBeUndefined();
	});

	it("create_pending_pr_review seeds inline comments and strips per-element undefined", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubPendingReviewOctokit();
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "create_pending_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 7,
			comments: [{ path: "src/foo.ts", line: 10, body: "seed" }],
		});
		expect(result.content[0].text).toContain("with 1 inline comment(s)");
		expect(calls.createReview[0].comments).toEqual([
			{ path: "src/foo.ts", line: 10, body: "seed" },
		]);
	});

	it("add_comment_to_pending_pr_review with review_node_id skips the getReview lookup", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubPendingReviewOctokit();
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "add_comment_to_pending_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 7,
			review_id: 42,
			review_node_id: "PRR_from_caller",
			path: "src/foo.ts",
			body: "comment",
			line: 3,
		});
		expect(result.content[0].text).toContain("comment_id: `101`");
		expect(calls.getReview).toHaveLength(0);
		expect(calls.graphql[0].vars.pullRequestReviewId).toBe("PRR_from_caller");
		expect(calls.graphql[0].vars.side).toBe("RIGHT");
	});

	it("add_comment_to_pending_pr_review resolves node_id via getReview when omitted", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubPendingReviewOctokit();
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "add_comment_to_pending_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 7,
			review_id: 42,
			path: "src/foo.ts",
			body: "comment",
			line: 3,
		});
		expect(result.isError).toBeUndefined();
		expect(calls.getReview).toHaveLength(1);
		expect(calls.graphql[0].vars.pullRequestReviewId).toBe("PRR_pending_42");
	});

	it("add_comment_to_pending_pr_review surfaces an error when the graphql thread is null", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = stubPendingReviewOctokit({
			graphql: async () => ({ addPullRequestReviewThread: { thread: null } }),
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "add_comment_to_pending_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 7,
			review_id: 42,
			review_node_id: "PRR_from_caller",
			path: "src/foo.ts",
			body: "comment",
			line: 3,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to add pending review comment");
	});

	it("submit_pending_pr_review submits a COMMENT with an explicit body", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubPendingReviewOctokit();
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "submit_pending_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 7,
			review_id: 42,
			event: "COMMENT",
			body: "please look",
		});
		expect(result.content[0].text).toContain("**COMMENTED** on o/r#7");
		expect(calls.submitReview[0]).toEqual({
			owner: "o",
			repo: "r",
			pull_number: 7,
			review_id: 42,
			event: "COMMENT",
			body: "please look",
		});
		// Body supplied → no draft lookup required.
		expect(calls.getReview).toHaveLength(0);
	});

	it("submit_pending_pr_review reuses the pending draft body when the caller omits it", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubPendingReviewOctokit({
			getReview: async () => ({
				data: pendingReviewData({ body: "existing draft body" }),
				headers: {},
			}),
		});
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "submit_pending_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 7,
			review_id: 42,
			event: "COMMENT",
		});
		expect(result.isError).toBeUndefined();
		expect(calls.getReview).toHaveLength(1);
		expect(calls.submitReview[0].body).toBeUndefined();
	});

	it("submit_pending_pr_review rejects COMMENT when no body is provided and the draft has none", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubPendingReviewOctokit();
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "submit_pending_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 7,
			review_id: 42,
			event: "COMMENT",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("non-empty `body` is required");
		expect(calls.submitReview).toHaveLength(0);
	});

	it("delete_pending_pr_review discards a pending review", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit, calls } = stubPendingReviewOctokit();
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "delete_pending_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 7,
			review_id: 42,
		});
		expect(result.content[0].text).toContain("# Pending review deleted");
		expect(calls.deletePendingReview[0]).toEqual({
			owner: "o",
			repo: "r",
			pull_number: 7,
			review_id: 42,
		});
	});

	it("delete_pending_pr_review surfaces the GitHub 422 for already-submitted reviews", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = {
			rest: {
				pulls: {
					deletePendingReview: async () => {
						throw new Error("Can not delete a non-pending pull request review");
					},
				},
			},
		};
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "delete_pending_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 7,
			review_id: 42,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Can not delete a non-pending");
	});
});
