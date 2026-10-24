import { describe, expect, it } from "vitest";

import { registerSearchTools } from "../src/tools/search.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const stubOctokit = ({ code, users, issuesAndPullRequests } = {}) => ({
	rest: {
		search: {
			code: code ?? (async () => ({ data: { total_count: 0, items: [] }, headers: {} })),
			users: users ?? (async () => ({ data: { total_count: 0, items: [] }, headers: {} })),
			issuesAndPullRequests:
				issuesAndPullRequests ??
				(async () => ({ data: { total_count: 0, items: [] }, headers: {} })),
		},
	},
});

const register = (octokit) => {
	const { handlers, server } = captureHandlers();
	registerSearchTools(server, () => octokit);
	return handlers;
};

const codeItem = (i) => ({
	path: `src/file-${i}.ts`,
	html_url: `https://example.test/o/r/blob/main/src/file-${i}.ts`,
	repository: { full_name: "o/r" },
});

const userItem = (i, overrides = {}) => ({
	login: `user${i}`,
	type: "User",
	html_url: `https://example.test/user${i}`,
	...overrides,
});

const prItem = (i, overrides = {}) => ({
	number: 100 + i,
	title: `PR ${i}`,
	state: "open",
	user: { login: `author${i}` },
	html_url: `https://example.test/o/r/pull/${100 + i}`,
	repository_url: "https://api.example.test/repos/o/r",
	pull_request: {},
	...overrides,
});

describe("registerSearchTools — search_code", () => {
	it("reports no matches for an empty result set", async () => {
		const handlers = register(
			stubOctokit({ code: async () => ({ data: { total_count: 0, items: [] }, headers: {} }) }),
		);
		const result = await invoke(handlers, "search_code", { query: "needle" });
		const body = result.content[0].text;
		expect(result.isError).toBeUndefined();
		expect(body).toContain("No matches for `needle`.");
	});

	it("renders a final-page header and per-match bullets", async () => {
		const items = [codeItem(0)];
		const handlers = register(
			stubOctokit({ code: async () => ({ data: { total_count: 1, items }, headers: {} }) }),
		);
		const result = await invoke(handlers, "search_code", {
			query: "repo:o/r foo",
			per_page: 20,
			page: 1,
		});
		const body = result.content[0].text;
		expect(body).toContain("# Code search results for `repo:o/r foo` (showing 1 of 1)");
		expect(body).toContain("- **o/r** — `src/file-0.ts`");
		expect(body).toContain("https://example.test/o/r/blob/main/src/file-0.ts");
	});

	// NOTE: per_page/page defaults come from the MCP SDK schema layer, which
	// handler-direct invocation bypasses — pass them explicitly here.
	it("emits a paging hint when more results remain", async () => {
		const items = Array.from({ length: 20 }, (_, i) => codeItem(i));
		const handlers = register(
			stubOctokit({ code: async () => ({ data: { total_count: 250, items }, headers: {} }) }),
		);
		const result = await invoke(handlers, "search_code", {
			query: "language:ts",
			per_page: 20,
			page: 1,
		});
		const body = result.content[0].text;
		expect(body).toContain("(page 1, showing 20 of 250; pass next `page` for more)");
	});

	it("surfaces Octokit errors via wrapTool (isError = true)", async () => {
		const handlers = register(
			stubOctokit({
				code: async () => {
					const err = new Error("Validation Failed");
					err.status = 422;
					throw err;
				},
			}),
		);
		const result = await invoke(handlers, "search_code", { query: "bad:qualifier" });
		expect(result.isError).toBe(true);
		const body = result.content[0].text;
		expect(body).toContain("Validation Failed");
		expect(body).toContain("HTTP 422");
	});
});

describe("registerSearchTools — search_users", () => {
	it("reports no matches for an empty result set", async () => {
		const handlers = register(stubOctokit());
		const result = await invoke(handlers, "search_users", { query: "nobody-here", per_page: 20 });
		const body = result.content[0].text;
		expect(result.isError).toBeUndefined();
		expect(body).toContain("No users matched `type:user nobody-here`.");
	});

	it("forces `type:user` and renders login + profile URL", async () => {
		let capturedQ;
		const handlers = register(
			stubOctokit({
				users: async ({ q }) => {
					capturedQ = q;
					return { data: { total_count: 1, items: [userItem(0)] }, headers: {} };
				},
			}),
		);
		const result = await invoke(handlers, "search_users", {
			query: "fullname:jane location:tokyo",
			per_page: 20,
			page: 1,
		});
		const body = result.content[0].text;
		expect(capturedQ).toBe("type:user fullname:jane location:tokyo");
		expect(body).toContain(
			"# User search results for `type:user fullname:jane location:tokyo` (showing 1 of 1)",
		);
		expect(body).toContain("- **@user0** — https://example.test/user0");
	});

	it("overrides a conflicting `type:org` with the forced `type:user`", async () => {
		let capturedQ;
		const handlers = register(
			stubOctokit({
				users: async ({ q }) => {
					capturedQ = q;
					return { data: { total_count: 0, items: [] }, headers: {} };
				},
			}),
		);
		await invoke(handlers, "search_users", {
			query: "type:org followers:>100",
			per_page: 20,
		});
		expect(capturedQ).toBe("type:user followers:>100");
	});

	it("forwards sort/order and paging hint", async () => {
		let captured;
		const items = Array.from({ length: 20 }, (_, i) => userItem(i));
		const handlers = register(
			stubOctokit({
				users: async (args) => {
					captured = args;
					return { data: { total_count: 250, items }, headers: {} };
				},
			}),
		);
		const result = await invoke(handlers, "search_users", {
			query: "followers:>100",
			sort: "followers",
			order: "desc",
			per_page: 20,
			page: 1,
		});
		expect(captured).toMatchObject({
			q: "type:user followers:>100",
			sort: "followers",
			order: "desc",
			per_page: 20,
			page: 1,
		});
		const body = result.content[0].text;
		expect(body).toContain("(page 1, showing 20 of 250; pass next `page` for more)");
	});
});

describe("registerSearchTools — search_orgs", () => {
	it("forces `type:org` on a query that lacks it", async () => {
		let capturedQ;
		const handlers = register(
			stubOctokit({
				users: async ({ q }) => {
					capturedQ = q;
					return {
						data: { total_count: 1, items: [userItem(0, { type: "Organization" })] },
						headers: {},
					};
				},
			}),
		);
		const result = await invoke(handlers, "search_orgs", {
			query: "location:tokyo",
			per_page: 20,
		});
		expect(capturedQ).toBe("type:org location:tokyo");
		const body = result.content[0].text;
		expect(body).toContain("# Org search results for `type:org location:tokyo` (showing 1 of 1)");
		expect(body).toContain("- **@user0** — https://example.test/user0");
	});

	it("overrides a conflicting `type:user` with the forced `type:org`", async () => {
		let capturedQ;
		const handlers = register(
			stubOctokit({
				users: async ({ q }) => {
					capturedQ = q;
					return { data: { total_count: 0, items: [] }, headers: {} };
				},
			}),
		);
		await invoke(handlers, "search_orgs", {
			query: "type:user location:tokyo",
			per_page: 20,
		});
		expect(capturedQ).toBe("type:org location:tokyo");
	});

	it("strips a negated `-type:org` before forcing `type:org`", async () => {
		let capturedQ;
		const handlers = register(
			stubOctokit({
				users: async ({ q }) => {
					capturedQ = q;
					return { data: { total_count: 0, items: [] }, headers: {} };
				},
			}),
		);
		await invoke(handlers, "search_orgs", {
			query: "-type:org repos:>10",
			per_page: 20,
		});
		expect(capturedQ).toBe("type:org repos:>10");
	});

	it("does not duplicate `type:org` when the caller already supplied it", async () => {
		let capturedQ;
		const handlers = register(
			stubOctokit({
				users: async ({ q }) => {
					capturedQ = q;
					return { data: { total_count: 0, items: [] }, headers: {} };
				},
			}),
		);
		await invoke(handlers, "search_orgs", { query: "type:org repos:>10", per_page: 20 });
		expect(capturedQ).toBe("type:org repos:>10");
	});

	it("reports no matches for an empty result set", async () => {
		const handlers = register(stubOctokit());
		const result = await invoke(handlers, "search_orgs", {
			query: "location:antarctica",
			per_page: 20,
		});
		const body = result.content[0].text;
		expect(body).toContain("No organizations matched `type:org location:antarctica`.");
	});
});

describe("registerSearchTools — search_pull_requests", () => {
	it("reports no matches for an empty result set", async () => {
		const handlers = register(stubOctokit());
		const result = await invoke(handlers, "search_pull_requests", {
			query: "repo:o/r nomatch",
			per_page: 20,
		});
		const body = result.content[0].text;
		expect(body).toContain("No pull requests matched `is:pr repo:o/r nomatch`.");
	});

	it("forces `is:pr` and renders repo, number, state, author", async () => {
		let capturedArgs;
		const handlers = register(
			stubOctokit({
				issuesAndPullRequests: async (args) => {
					capturedArgs = args;
					return { data: { total_count: 1, items: [prItem(0)] }, headers: {} };
				},
			}),
		);
		const result = await invoke(handlers, "search_pull_requests", {
			query: "repo:o/r author:jane",
			per_page: 20,
			page: 1,
		});
		expect(capturedArgs.q).toBe("is:pr repo:o/r author:jane");
		const body = result.content[0].text;
		expect(body).toContain("# PR search results for `is:pr repo:o/r author:jane` (showing 1 of 1)");
		expect(body).toContain("- [PR o/r #100] **PR 0** (open) by @author0");
		expect(body).toContain("https://example.test/o/r/pull/100");
	});

	it("overrides `is:issue` with the forced `is:pr` while keeping other `is:*` state filters", async () => {
		let capturedQ;
		const handlers = register(
			stubOctokit({
				issuesAndPullRequests: async ({ q }) => {
					capturedQ = q;
					return { data: { total_count: 0, items: [] }, headers: {} };
				},
			}),
		);
		await invoke(handlers, "search_pull_requests", {
			query: "is:issue is:merged repo:o/r",
			per_page: 20,
		});
		expect(capturedQ).toBe("is:pr is:merged repo:o/r");
	});

	it("does not duplicate `is:pr` when the caller already supplied it", async () => {
		let capturedQ;
		const handlers = register(
			stubOctokit({
				issuesAndPullRequests: async ({ q }) => {
					capturedQ = q;
					return { data: { total_count: 0, items: [] }, headers: {} };
				},
			}),
		);
		await invoke(handlers, "search_pull_requests", {
			query: "is:pr repo:o/r",
			per_page: 20,
		});
		expect(capturedQ).toBe("is:pr repo:o/r");
	});

	it("renders `merged` for a merged PR and `draft` for a draft PR", async () => {
		const items = [
			prItem(0, { pull_request: { merged_at: "2026-01-01T00:00:00Z" } }),
			prItem(1, { draft: true, state: "open" }),
			prItem(2, { state: "closed" }),
		];
		const handlers = register(
			stubOctokit({
				issuesAndPullRequests: async () => ({
					data: { total_count: 3, items },
					headers: {},
				}),
			}),
		);
		const result = await invoke(handlers, "search_pull_requests", {
			query: "repo:o/r",
			per_page: 20,
		});
		const body = result.content[0].text;
		expect(body).toContain("[PR o/r #100] **PR 0** (merged)");
		expect(body).toContain("[PR o/r #101] **PR 1** (draft)");
		expect(body).toContain("[PR o/r #102] **PR 2** (closed)");
	});

	it("forwards sort/order to Octokit and emits a paging hint", async () => {
		let captured;
		const items = Array.from({ length: 20 }, (_, i) => prItem(i));
		const handlers = register(
			stubOctokit({
				issuesAndPullRequests: async (args) => {
					captured = args;
					return { data: { total_count: 250, items }, headers: {} };
				},
			}),
		);
		const result = await invoke(handlers, "search_pull_requests", {
			query: "author:jane",
			sort: "updated",
			order: "desc",
			per_page: 20,
			page: 1,
		});
		expect(captured).toMatchObject({
			q: "is:pr author:jane",
			sort: "updated",
			order: "desc",
			per_page: 20,
			page: 1,
		});
		const body = result.content[0].text;
		expect(body).toContain("(page 1, showing 20 of 250; pass next `page` for more)");
	});
});

describe.each([
	{ tool: "search_code", method: "code", prefix: "" },
	{ tool: "search_pull_requests", method: "issuesAndPullRequests", prefix: "is:pr " },
])("registerSearchTools — $tool owner / repo scope", ({ tool, method, prefix }) => {
	const run = async (params) => {
		const calls = [];
		const handlers = register(
			stubOctokit({
				[method]: async (args) => {
					calls.push(args);
					return { data: { total_count: 0, items: [] }, headers: {} };
				},
			}),
		);
		const result = await invoke(handlers, tool, { per_page: 20, ...params });
		return { calls, result };
	};

	it("adds `repo:<owner>/<repo>` when both are given", async () => {
		const { calls, result } = await run({ query: "needle", owner: "banaris", repo: "website" });
		expect(calls).toHaveLength(1);
		expect(calls[0].q).toBe(`${prefix}needle repo:banaris/website`);
		expect(result.content[0].text).toContain(`${prefix}needle repo:banaris/website`);
	});

	it("adds `user:<owner>` when only `owner` is given", async () => {
		const { calls } = await run({ query: "needle", owner: "banaris" });
		expect(calls[0].q).toBe(`${prefix}needle user:banaris`);
	});

	it("leaves the query untouched without owner / repo, `repo:` in query included", async () => {
		const { calls } = await run({ query: "needle repo:o/r" });
		expect(calls[0].q).toBe(`${prefix}needle repo:o/r`);
	});

	it.each([
		["`repo` without `owner`", { query: "needle", repo: "website" }],
		["an owner with a space", { query: "needle", owner: "a is:closed" }],
		["an empty owner", { query: "needle", owner: "" }],
		["a repo with a space", { query: "needle", owner: "a", repo: "b is:closed" }],
		["an empty repo", { query: "needle", owner: "a", repo: "" }],
		["a repo with a slash", { query: "needle", owner: "a", repo: "b/c" }],
		["a `repo:` qualifier in query", { query: "repo:x/y needle", owner: "a", repo: "b" }],
		["a `repo:` qualifier in query with owner only", { query: "repo:x/y needle", owner: "a" }],
		["an upper-case `REPO:` qualifier", { query: "needle REPO:x/y", owner: "a", repo: "b" }],
		["a quoted `repo:` token", { query: '"repo:x"', owner: "a", repo: "b" }],
		["a `user:` qualifier in query", { query: "needle user:x", owner: "a", repo: "b" }],
		["an `org:` qualifier in query with owner only", { query: "org:x needle", owner: "a" }],
		["an upper-case `ORG:` qualifier", { query: "needle ORG:x", owner: "a", repo: "b" }],
	])("returns an error and makes no request for %s", async (_label, params) => {
		const { calls, result } = await run(params);
		expect(result.isError).toBe(true);
		expect(calls).toHaveLength(0);
	});

	it.each([
		["a `-repo:` exclusion", "needle -repo:x/y"],
		["a `-user:` exclusion", "needle -user:x"],
		["a token merely ending in `repo:`", "myrepo:x needle"],
		["the bare word repo", "needle repo"],
	])("allows %s alongside owner / repo", async (_label, query) => {
		const { calls, result } = await run({ query, owner: "a", repo: "b" });
		expect(result.isError).toBeUndefined();
		expect(calls[0].q).toBe(`${prefix}${query} repo:a/b`);
	});
});
