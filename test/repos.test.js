import { describe, expect, it } from "vitest";

import { registerRepoTools } from "../src/tools/repos.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const stubOctokit = (overrides = {}) => ({
	rest: {
		repos: {
			listForAuthenticatedUser: async () => ({ data: [], headers: {} }),
			get: async () => ({ data: {}, headers: {} }),
			...overrides.repos,
		},
		users: {
			getAuthenticated: async () => ({ data: {}, headers: {} }),
			...overrides.users,
		},
		search: {
			repos: async () => ({ data: { total_count: 0, items: [] }, headers: {} }),
			...overrides.search,
		},
	},
});

const register = (octokit) => {
	const { handlers, server } = captureHandlers();
	registerRepoTools(server, () => octokit);
	return handlers;
};

describe("registerRepoTools — get_repo", () => {
	const baseRepo = {
		full_name: "o/r",
		visibility: "public",
		private: false,
		description: "A sample repo",
		html_url: "https://example.test/o/r",
		default_branch: "main",
		language: "TypeScript",
		stargazers_count: 12,
		forks_count: 3,
		open_issues_count: 5,
		has_issues: true,
		has_wiki: false,
		has_projects: true,
		has_discussions: true,
		pushed_at: "2026-01-03T00:00:00Z",
		updated_at: "2026-01-02T00:00:00Z",
		created_at: "2026-01-01T00:00:00Z",
		archived: false,
		fork: false,
		disabled: false,
		is_template: false,
		parent: null,
		homepage: null,
		license: null,
	};

	it("renders core metadata and omits optional lines when absent", async () => {
		const handlers = register(
			stubOctokit({ repos: { get: async () => ({ data: baseRepo, headers: {} }) } }),
		);
		const result = await invoke(handlers, "get_repo", { owner: "o", repo: "r" });
		const body = result.content[0].text;
		expect(result.isError).toBeUndefined();
		expect(body).toContain("# o/r (public)");
		expect(body).toContain("> A sample repo");
		expect(body).toContain("- Default branch: `main`");
		expect(body).toContain("- Language: TypeScript");
		expect(body).toContain("has_discussions: true");
		// No flags / fork / homepage / license lines for the base repo.
		expect(body).not.toContain("- Flags:");
		expect(body).not.toContain("- Forked from:");
		expect(body).not.toContain("- Homepage:");
		expect(body).not.toContain("- License:");
		// No literal "undefined" / "null" leaks.
		expect(body).not.toContain("undefined");
	});

	it("renders flags, parent, homepage, and license when present", async () => {
		const data = {
			...baseRepo,
			archived: true,
			fork: true,
			is_template: true,
			parent: { full_name: "up/stream", html_url: "https://example.test/up/stream" },
			homepage: "https://home.test",
			license: { name: "MIT License" },
		};
		const handlers = register(stubOctokit({ repos: { get: async () => ({ data, headers: {} }) } }));
		const result = await invoke(handlers, "get_repo", { owner: "o", repo: "r" });
		const body = result.content[0].text;
		expect(body).toContain("- Flags: archived, fork, template");
		expect(body).toContain("- Forked from: up/stream (https://example.test/up/stream)");
		expect(body).toContain("- Homepage: https://home.test");
		expect(body).toContain("- License: MIT License");
	});

	it("falls back to (no description) and (unknown) language for empty fields", async () => {
		const data = { ...baseRepo, description: null, language: null, has_discussions: null };
		const handlers = register(stubOctokit({ repos: { get: async () => ({ data, headers: {} }) } }));
		const result = await invoke(handlers, "get_repo", { owner: "o", repo: "r" });
		const body = result.content[0].text;
		expect(body).toContain("> (no description)");
		expect(body).toContain("- Language: (unknown)");
		// has_discussions null falls back to false in the rendered line.
		expect(body).toContain("has_discussions: false");
	});

	it("derives visibility from the private flag when visibility is absent", async () => {
		const data = { ...baseRepo, visibility: null, private: true };
		const handlers = register(stubOctokit({ repos: { get: async () => ({ data, headers: {} }) } }));
		const result = await invoke(handlers, "get_repo", { owner: "o", repo: "r" });
		expect(result.content[0].text).toContain("# o/r (private)");
	});

	it("surfaces Octokit errors via wrapTool (isError = true)", async () => {
		const handlers = register(
			stubOctokit({
				repos: {
					get: async () => {
						const err = new Error("Not Found");
						err.status = 404;
						throw err;
					},
				},
			}),
		);
		const result = await invoke(handlers, "get_repo", { owner: "o", repo: "missing" });
		expect(result.isError).toBe(true);
		const body = result.content[0].text;
		expect(body).toContain("Not Found");
		expect(body).toContain("HTTP 404");
	});
});

describe("registerRepoTools — get_authenticated_user", () => {
	const baseUser = {
		login: "alice",
		name: null,
		email: null,
		bio: null,
		company: null,
		location: null,
		html_url: "https://example.test/alice",
		public_repos: 7,
		public_gists: 2,
		total_private_repos: null,
		owned_private_repos: null,
		followers: 10,
		following: 4,
		created_at: "2026-01-01T00:00:00Z",
	};

	it("omits null optional lines (no empty bullets, no 'undefined')", async () => {
		const handlers = register(
			stubOctokit({ users: { getAuthenticated: async () => ({ data: baseUser, headers: {} }) } }),
		);
		const result = await invoke(handlers, "get_authenticated_user", {});
		const body = result.content[0].text;
		expect(result.isError).toBeUndefined();
		expect(body).toContain("# @alice");
		expect(body).toContain("- Public repos: 7 | Public gists: 2");
		expect(body).not.toContain("- Name:");
		expect(body).not.toContain("- Email:");
		expect(body).not.toContain("- Total private repos:");
		expect(body).not.toContain("- Owned private repos:");
		expect(body).not.toContain("undefined");
		expect(body).not.toContain("null");
	});

	it("renders private repo counts when present", async () => {
		const data = {
			...baseUser,
			name: "Alice Example",
			total_private_repos: 3,
			owned_private_repos: 2,
		};
		const handlers = register(
			stubOctokit({ users: { getAuthenticated: async () => ({ data, headers: {} }) } }),
		);
		const result = await invoke(handlers, "get_authenticated_user", {});
		const body = result.content[0].text;
		expect(body).toContain("- Name: Alice Example");
		expect(body).toContain("- Total private repos: 3");
		expect(body).toContain("- Owned private repos: 2");
	});
});

describe("registerRepoTools — search_repositories", () => {
	it("reports no matches without an items list", async () => {
		const handlers = register(
			stubOctokit({
				search: { repos: async () => ({ data: { total_count: 0, items: [] }, headers: {} }) },
			}),
		);
		const result = await invoke(handlers, "search_repositories", { query: "nope" });
		const body = result.content[0].text;
		expect(result.isError).toBeUndefined();
		expect(body).toContain("No repositories matched `nope`.");
	});

	it("renders a final-page header when all results fit", async () => {
		const items = [
			{
				full_name: "o/one",
				visibility: "public",
				private: false,
				description: "first",
				language: "TypeScript",
				html_url: "https://example.test/o/one",
				stargazers_count: 5,
				updated_at: "2026-01-02T00:00:00Z",
			},
		];
		const handlers = register(
			stubOctokit({
				search: {
					repos: async () => ({ data: { total_count: 1, items }, headers: {} }),
				},
			}),
		);
		const result = await invoke(handlers, "search_repositories", {
			query: "lang:ts",
			per_page: 20,
			page: 1,
		});
		const body = result.content[0].text;
		expect(body).toContain("# Repo search results for `lang:ts` (showing 1 of 1)");
		expect(body).toContain("- **o/one** (public) — first");
		expect(body).toContain("5 stars | TypeScript | updated 2026-01-02T00:00:00Z");
	});

	// NOTE: the zod `.default()` on per_page/page is applied by the MCP SDK's
	// schema validation, which handler-direct invocation bypasses — so this test
	// passes per_page explicitly rather than relying on the default.
	it("emits a paging hint when more results remain", async () => {
		const items = Array.from({ length: 20 }, (_, i) => ({
			full_name: `o/repo-${i}`,
			visibility: "public",
			private: false,
			description: null,
			language: null,
			html_url: `https://example.test/o/repo-${i}`,
			stargazers_count: 0,
			updated_at: "2026-01-02T00:00:00Z",
		}));
		const handlers = register(
			stubOctokit({
				search: {
					repos: async () => ({ data: { total_count: 100, items }, headers: {} }),
				},
			}),
		);
		const result = await invoke(handlers, "search_repositories", {
			query: "stars:>1",
			per_page: 20,
			page: 1,
		});
		const body = result.content[0].text;
		expect(body).toContain("(page 1, showing 20 of 100; pass next `page` for more)");
	});
});
