import { afterEach, describe, expect, it, vi } from "vitest";

import { registerRepoConfigTools } from "../src/tools/repo-config.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const repoData = (overrides = {}) => ({
	full_name: "o/r",
	private: false,
	visibility: "public",
	html_url: "https://example.test/o/r",
	default_branch: "main",
	archived: false,
	...overrides,
});

const httpError = (message, status) => {
	const err = new Error(message);
	err.status = status;
	return err;
};

const setup = (repos = {}) => {
	const { handlers, server } = captureHandlers();
	const octokit = {
		rest: {
			repos: {
				get: async () => ({ data: { default_branch: "main" }, headers: {} }),
				update: async () => ({ data: repoData(), headers: {} }),
				mergeUpstream: async () => ({ data: {}, headers: {} }),
				...repos,
			},
		},
	};
	registerRepoConfigTools(server, () => octokit);
	return handlers;
};

const auditLines = (spy) =>
	spy.mock.calls.map(([l]) => l).filter((l) => String(l).startsWith("[github-audit] "));

afterEach(() => {
	vi.restoreAllMocks();
});

describe("update_repository", () => {
	it("sends only the given fields and renders the updated repo", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		let captured;
		const handlers = setup({
			update: async (params) => {
				captured = params;
				return { data: repoData({ description: "new" }), headers: {} };
			},
		});
		const result = await invoke(handlers, "update_repository", {
			owner: "o",
			repo: "r",
			description: "new",
			has_wiki: false,
		});
		expect(result.isError).toBeUndefined();
		expect(captured).toEqual({ owner: "o", repo: "r", description: "new", has_wiki: false });
		const body = result.content[0].text;
		expect(body).toContain("# Repository updated");
		expect(body).toContain("- Updated: description, has_wiki");
		const lines = auditLines(spy);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0].slice("[github-audit] ".length))).toEqual({
			tool: "update_repository",
			owner: "o",
			repo: "r",
			updated_fields: "description,has_wiki",
		});
	});

	it("forwards a false flag instead of dropping it", async () => {
		let captured;
		const handlers = setup({
			update: async (params) => {
				captured = params;
				return { data: repoData(), headers: {} };
			},
		});
		await invoke(handlers, "update_repository", {
			owner: "o",
			repo: "r",
			delete_branch_on_merge: false,
		});
		expect(captured.delete_branch_on_merge).toBe(false);
	});

	it("errors without a request or audit line when no field is given", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const update = vi.fn();
		const handlers = setup({ update });
		const result = await invoke(handlers, "update_repository", {
			owner: "o",
			repo: "r",
			description: undefined,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("at least one field");
		expect(update).not.toHaveBeenCalled();
		expect(auditLines(spy)).toHaveLength(0);
	});

	it("surfaces a GitHub error and emits no audit line", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const handlers = setup({
			update: async () => {
				throw httpError("Must have admin rights to Repository.", 403);
			},
		});
		const result = await invoke(handlers, "update_repository", {
			owner: "o",
			repo: "r",
			has_issues: true,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("HTTP 403");
		expect(auditLines(spy)).toHaveLength(0);
	});
});

describe("rename_repository", () => {
	it("renames through the update endpoint and shows the new full name", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		let captured;
		const handlers = setup({
			update: async (params) => {
				captured = params;
				return { data: repoData({ full_name: "o/new" }), headers: {} };
			},
		});
		const result = await invoke(handlers, "rename_repository", {
			owner: "o",
			repo: "r",
			new_name: "new",
		});
		expect(captured).toEqual({ owner: "o", repo: "r", name: "new" });
		const body = result.content[0].text;
		expect(body).toContain("# Repository renamed");
		expect(body).toContain("**o/new**");
		expect(body).toContain("Previous name: o/r");
		expect(JSON.parse(auditLines(spy)[0].slice("[github-audit] ".length))).toEqual({
			tool: "rename_repository",
			owner: "o",
			repo: "r",
			new_name: "new",
		});
	});

	it("surfaces a name-taken validation error", async () => {
		const handlers = setup({
			update: async () => {
				throw httpError("Repository creation failed.", 422);
			},
		});
		const result = await invoke(handlers, "rename_repository", {
			owner: "o",
			repo: "r",
			new_name: "taken",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("HTTP 422");
	});
});

describe("archive_repository / unarchive_repository", () => {
	it("archive sets archived: true and renders the state from the response", async () => {
		let captured;
		const handlers = setup({
			update: async (params) => {
				captured = params;
				return { data: repoData({ archived: true }), headers: {} };
			},
		});
		const result = await invoke(handlers, "archive_repository", { owner: "o", repo: "r" });
		expect(captured).toEqual({ owner: "o", repo: "r", archived: true });
		expect(result.content[0].text).toContain("# Repository archived");
		expect(result.content[0].text).toContain("- Archived: true");
	});

	it("unarchive sets archived: false and reports what GitHub returned", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		let captured;
		const handlers = setup({
			update: async (params) => {
				captured = params;
				return { data: repoData({ archived: false }), headers: {} };
			},
		});
		const result = await invoke(handlers, "unarchive_repository", { owner: "o", repo: "r" });
		expect(captured).toEqual({ owner: "o", repo: "r", archived: false });
		expect(result.content[0].text).toContain("# Repository unarchived");
		expect(result.content[0].text).toContain("- Archived: false");
		expect(JSON.parse(auditLines(spy)[0].slice("[github-audit] ".length)).tool).toBe(
			"unarchive_repository",
		);
	});

	it("surfaces a GitHub error with no audit line", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const handlers = setup({
			update: async () => {
				throw httpError("Not Found", 404);
			},
		});
		const result = await invoke(handlers, "archive_repository", { owner: "o", repo: "r" });
		expect(result.isError).toBe(true);
		expect(auditLines(spy)).toHaveLength(0);
	});
});

describe("sync_fork", () => {
	it("syncs the given branch and renders the API's message", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		let captured;
		const handlers = setup({
			mergeUpstream: async (params) => {
				captured = params;
				return {
					data: {
						message: "Successfully fetched and fast-forwarded",
						merge_type: "fast-forward",
						base_branch: "dev",
					},
					headers: {},
				};
			},
		});
		const result = await invoke(handlers, "sync_fork", { owner: "o", repo: "r", branch: "dev" });
		expect(captured).toEqual({ owner: "o", repo: "r", branch: "dev" });
		const body = result.content[0].text;
		expect(body).toContain("# Fork synced");
		expect(body).toContain("branch `dev`");
		expect(body).toContain("Merge type: fast-forward");
		expect(body).toContain("Successfully fetched and fast-forwarded");
		expect(JSON.parse(auditLines(spy)[0].slice("[github-audit] ".length))).toEqual({
			tool: "sync_fork",
			owner: "o",
			repo: "r",
			branch: "dev",
		});
	});

	it("defaults to the fork's default branch", async () => {
		let captured;
		const handlers = setup({
			get: async () => ({ data: { default_branch: "trunk" }, headers: {} }),
			mergeUpstream: async (params) => {
				captured = params;
				return { data: { base_branch: "trunk" }, headers: {} };
			},
		});
		await invoke(handlers, "sync_fork", { owner: "o", repo: "r" });
		expect(captured.branch).toBe("trunk");
	});

	it("stops when the default-branch lookup fails", async () => {
		const mergeUpstream = vi.fn();
		const handlers = setup({
			get: async () => {
				throw httpError("Not Found", 404);
			},
			mergeUpstream,
		});
		const result = await invoke(handlers, "sync_fork", { owner: "o", repo: "r" });
		expect(result.isError).toBe(true);
		expect(mergeUpstream).not.toHaveBeenCalled();
	});

	it("surfaces a merge conflict and emits no audit line", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const handlers = setup({
			mergeUpstream: async () => {
				throw httpError("There are merge conflicts", 409);
			},
		});
		const result = await invoke(handlers, "sync_fork", { owner: "o", repo: "r", branch: "main" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("HTTP 409");
		expect(auditLines(spy)).toHaveLength(0);
	});
});
