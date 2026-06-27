import { describe, expect, it } from "vitest";

import { registerGistTools } from "../src/tools/gists.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const sampleGist = (overrides = {}) => ({
	id: "abc123",
	description: "demo gist",
	public: false,
	owner: { login: "alice" },
	files: {
		"hello.py": {
			filename: "hello.py",
			language: "Python",
			size: 12,
			raw_url: "https://gist.githubusercontent.com/alice/abc123/raw/hello.py",
			content: "print('hi')",
		},
	},
	updated_at: "2026-06-27T00:00:00Z",
	created_at: "2026-06-27T00:00:00Z",
	html_url: "https://gist.github.com/alice/abc123",
	...overrides,
});

const stubOctokit = (overrides) => ({
	rest: {
		gists: {
			list: async () => ({ data: [], headers: {} }),
			get: async () => ({ data: sampleGist(), headers: {} }),
			listComments: async () => ({ data: [], headers: {} }),
			create: async () => ({ data: sampleGist(), headers: {} }),
			update: async () => ({ data: sampleGist(), headers: {} }),
			delete: async () => ({ data: {}, headers: {} }),
			...overrides,
		},
	},
});

describe("registerGistTools", () => {
	it("list_gists renders ID, description, visibility, file count, updated_at", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			list: async () => ({
				data: [
					{
						id: "g1",
						description: "first",
						public: true,
						files: { "a.txt": {}, "b.txt": {} },
						updated_at: "2026-06-27T01:00:00Z",
					},
					{
						id: "g2",
						description: "",
						public: false,
						files: { "c.txt": {} },
						updated_at: "2026-06-27T02:00:00Z",
					},
				],
				headers: {},
			}),
		});
		registerGistTools(server, () => octokit);

		const result = await invoke(handlers, "list_gists", {});
		const body = result.content[0].text;
		expect(body).toContain("# Gists (2)");
		expect(body).toContain("`g1` **first** — public, 2 file(s), 2026-06-27T01:00:00Z");
		expect(body).toContain("`g2` **(no description)** — secret, 1 file(s)");
		expect(result.isError).toBeUndefined();
	});

	it("list_gists reports the empty case", async () => {
		const { handlers, server } = captureHandlers();
		registerGistTools(server, () => stubOctokit());
		const result = await invoke(handlers, "list_gists", {});
		expect(result.content[0].text).toBe("(no gists found)");
	});

	it("list_gists shows a pagination hint when a next link is present", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			list: async () => ({
				data: [
					{
						id: "g1",
						description: "x",
						public: true,
						files: {},
						updated_at: "2026-06-27T00:00:00Z",
					},
				],
				headers: { link: '<https://api.github.com/gists?page=2>; rel="next"' },
			}),
		});
		registerGistTools(server, () => octokit);
		const result = await invoke(handlers, "list_gists", {});
		expect(result.content[0].text).toContain("more available");
	});

	it("get_gist renders description, metadata and per-file content excerpts", async () => {
		const { handlers, server } = captureHandlers();
		registerGistTools(server, () => stubOctokit());
		const result = await invoke(handlers, "get_gist", { gist_id: "abc123" });
		const body = result.content[0].text;
		expect(body).toContain("# Gist `abc123`");
		expect(body).toContain("> demo gist");
		expect(body).toContain("- public: no");
		expect(body).toContain("- owner: alice");
		expect(body).toContain("- files: 1");
		expect(body).toContain("### `hello.py`");
		expect(body).toContain("- language: Python");
		expect(body).toContain("print('hi')");
	});

	it("get_gist falls back to '(no description)' when description is absent", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			get: async () => ({ data: sampleGist({ description: null }), headers: {} }),
		});
		registerGistTools(server, () => octokit);
		const result = await invoke(handlers, "get_gist", { gist_id: "abc123" });
		expect(result.content[0].text).toContain("> (no description)");
	});

	it("list_gist_comments renders author, timestamp and preview", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			listComments: async () => ({
				data: [
					{
						id: 99,
						user: { login: "bob" },
						created_at: "2026-06-27T03:00:00Z",
						body: "looks good",
					},
				],
				headers: {},
			}),
		});
		registerGistTools(server, () => octokit);
		const result = await invoke(handlers, "list_gist_comments", { gist_id: "abc123" });
		const body = result.content[0].text;
		expect(body).toContain("# Gist comments (1)");
		expect(body).toContain("`99` **bob** (2026-06-27T03:00:00Z) — looks good");
	});

	it("create_gist passes through to gists.create and renders the new gist detail", async () => {
		const { handlers, server } = captureHandlers();
		const calls = [];
		const octokit = stubOctokit({
			create: async (params) => {
				calls.push(params);
				return { data: sampleGist({ id: "new1", description: "new gist" }), headers: {} };
			},
		});
		registerGistTools(server, () => octokit);
		const result = await invoke(handlers, "create_gist", {
			description: "new gist",
			files: { "x.txt": { content: "hello" } },
			public: true,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			description: "new gist",
			files: { "x.txt": { content: "hello" } },
			public: true,
		});
		expect(result.content[0].text).toContain("# Gist `new1`");
		expect(result.isError).toBeUndefined();
	});

	it("create_gist rejects an empty files map at validation", async () => {
		const { handlers, server } = captureHandlers();
		registerGistTools(server, () => stubOctokit());
		// zod requires `files` (no default), so passing an empty record bypasses
		// the schema's `min(1)` per-file rule and reaches our explicit check.
		const result = await invoke(handlers, "create_gist", { files: {} });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Pass at least one file.");
	});

	it("update_gist forwards the files payload to gists.update", async () => {
		const { handlers, server } = captureHandlers();
		const calls = [];
		const octokit = stubOctokit({
			update: async (params) => {
				calls.push(params);
				return { data: sampleGist(), headers: {} };
			},
		});
		registerGistTools(server, () => octokit);
		const result = await invoke(handlers, "update_gist", {
			gist_id: "abc123",
			description: "edited",
			files: {
				"keep.py": { content: "new content" },
				"drop.txt": { content: null },
				"rename.txt": { filename: "renamed.txt" },
			},
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			gist_id: "abc123",
			description: "edited",
			files: {
				"keep.py": { content: "new content" },
				"drop.txt": { content: null },
				"rename.txt": { filename: "renamed.txt" },
			},
		});
		expect(result.isError).toBeUndefined();
	});

	it("update_gist rejects a call that changes nothing", async () => {
		const { handlers, server } = captureHandlers();
		registerGistTools(server, () => stubOctokit());
		const result = await invoke(handlers, "update_gist", { gist_id: "abc123" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Pass at least one of");
	});

	it("delete_gist reports the deletion", async () => {
		const { handlers, server } = captureHandlers();
		registerGistTools(server, () => stubOctokit());
		const result = await invoke(handlers, "delete_gist", { gist_id: "abc123" });
		expect(result.content[0].text).toContain("Gist deleted");
		expect(result.content[0].text).toContain("`abc123`");
	});
});
