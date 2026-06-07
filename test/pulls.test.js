import { describe, expect, it } from "vitest";

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
		expect(body).not.toContain("shown; more threads exist");
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

	it("returns an error when the API reports the PR was not merged", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = stubPullsMerge(async () => ({
			data: { merged: false, sha: "", message: "Base branch was modified. Review and try again." },
			headers: {},
		}));
		registerPullTools(server, () => octokit);

		const result = await invoke(handlers, "merge_pull_request", {
			owner: "o",
			repo: "r",
			pull_number: 42,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Merge not completed for #42");
		expect(result.content[0].text).toContain("Base branch was modified");
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
