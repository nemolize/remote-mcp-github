import { describe, expect, it } from "vitest";

import { registerRepoTools } from "../src/tools/repos.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const stubOctokit = (overrides = {}) => ({
	rest: {
		repos: {
			listForAuthenticatedUser: async () => ({ data: [], headers: {} }),
			get: async () => ({ data: {}, headers: {} }),
			createForAuthenticatedUser: async () => ({ data: {}, headers: {} }),
			createInOrg: async () => ({ data: {}, headers: {} }),
			createFork: async () => ({ data: {}, headers: {} }),
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

describe("registerRepoTools — create_repository", () => {
	const created = {
		full_name: "nemolize/new-repo",
		name: "new-repo",
		owner: { login: "nemolize" },
		private: false,
		visibility: "public",
		html_url: "https://example.test/nemolize/new-repo",
		default_branch: "main",
		description: "A fresh repo",
	};

	it("creates a user-owned repo and renders its summary", async () => {
		let captured;
		const handlers = register(
			stubOctokit({
				repos: {
					createForAuthenticatedUser: async (params) => {
						captured = params;
						return { data: created, headers: {} };
					},
				},
			}),
		);
		const result = await invoke(handlers, "create_repository", {
			name: "new-repo",
			description: "A fresh repo",
		});
		const body = result.content[0].text;
		expect(result.isError).toBeUndefined();
		expect(captured.name).toBe("new-repo");
		expect(captured.org).toBeUndefined();
		expect(body).toContain("# Repository created");
		expect(body).toContain("**nemolize/new-repo** (public)");
		expect(body).toContain("A fresh repo");
		expect(body).toContain("- Default branch: `main`");
	});

	it("routes to createInOrg when `org` is given", async () => {
		let usedOrg = false;
		const handlers = register(
			stubOctokit({
				repos: {
					createInOrg: async (params) => {
						usedOrg = params.org;
						return {
							data: { ...created, full_name: "acme/new-repo", owner: { login: "acme" } },
							headers: {},
						};
					},
					createForAuthenticatedUser: async () => {
						throw new Error("should not call user-create path when org is set");
					},
				},
			}),
		);
		const result = await invoke(handlers, "create_repository", { name: "new-repo", org: "acme" });
		expect(result.isError).toBeUndefined();
		expect(usedOrg).toBe("acme");
		expect(result.content[0].text).toContain("**acme/new-repo** (public)");
	});

	it("surfaces API errors via wrapTool", async () => {
		const handlers = register(
			stubOctokit({
				repos: {
					createForAuthenticatedUser: async () => {
						const err = new Error("name already exists on this account");
						err.status = 422;
						throw err;
					},
				},
			}),
		);
		const result = await invoke(handlers, "create_repository", { name: "dup" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("name already exists");
	});
});

describe("registerRepoTools — fork_repository", () => {
	const fork = {
		full_name: "nemolize/forked",
		name: "forked",
		owner: { login: "nemolize" },
		private: false,
		visibility: "public",
		html_url: "https://example.test/nemolize/forked",
		default_branch: "main",
		description: null,
		parent: {
			full_name: "upstream/forked",
			html_url: "https://example.test/upstream/forked",
		},
	};

	it("forks to the authenticated user and shows the parent", async () => {
		let captured;
		const handlers = register(
			stubOctokit({
				repos: {
					createFork: async (params) => {
						captured = params;
						return { data: fork, headers: {} };
					},
				},
			}),
		);
		const result = await invoke(handlers, "fork_repository", {
			owner: "upstream",
			repo: "forked",
		});
		const body = result.content[0].text;
		expect(result.isError).toBeUndefined();
		expect(captured.owner).toBe("upstream");
		expect(captured.repo).toBe("forked");
		expect(captured.organization).toBeUndefined();
		expect(body).toContain("# Repository forked");
		expect(body).toContain("**nemolize/forked** (public)");
		expect(body).toContain("- Forked from: upstream/forked (https://example.test/upstream/forked)");
	});

	it("passes the organization and default_branch_only through", async () => {
		let captured;
		const handlers = register(
			stubOctokit({
				repos: {
					createFork: async (params) => {
						captured = params;
						return { data: { ...fork, parent: null }, headers: {} };
					},
				},
			}),
		);
		await invoke(handlers, "fork_repository", {
			owner: "upstream",
			repo: "forked",
			organization: "acme",
			default_branch_only: true,
		});
		expect(captured.organization).toBe("acme");
		expect(captured.default_branch_only).toBe(true);
	});

	it("surfaces API errors via wrapTool", async () => {
		const handlers = register(
			stubOctokit({
				repos: {
					createFork: async () => {
						const err = new Error("Not Found");
						err.status = 404;
						throw err;
					},
				},
			}),
		);
		const result = await invoke(handlers, "fork_repository", { owner: "ghost", repo: "nope" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Not Found");
	});
});
