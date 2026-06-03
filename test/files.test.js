import { describe, expect, it, vi } from "vitest";

import { registerFileTools } from "../src/tools/files.js";

const captureHandlers = () => {
	const handlers = new Map();
	const server = {
		registerTool: (name, _config, handler) => {
			handlers.set(name, handler);
		},
	};
	return { handlers, server };
};

const b64 = (s) => btoa(s);

// Minimal Octokit stub. `getContent` and `getBlob` are overridable per test; the
// remaining endpoints are present so the other file tools register cleanly.
const stubOctokit = (overrides = {}) => ({
	rest: {
		repos: {
			getContent: async () => ({ data: {}, headers: {} }),
			createOrUpdateFileContents: async () => ({ data: { commit: {}, content: {} }, headers: {} }),
			deleteFile: async () => ({ data: { commit: {} }, headers: {} }),
			...overrides.repos,
		},
		git: {
			getBlob: async () => ({ data: { content: "", encoding: "base64" }, headers: {} }),
			getRef: async () => ({ data: { object: { sha: "p" } }, headers: {} }),
			getCommit: async () => ({ data: { tree: { sha: "t" } }, headers: {} }),
			createBlob: async () => ({ data: { sha: "b" }, headers: {} }),
			createTree: async () => ({ data: { sha: "tr" }, headers: {} }),
			createCommit: async () => ({ data: { sha: "c", html_url: "u" }, headers: {} }),
			updateRef: async () => ({ data: {}, headers: {} }),
			...overrides.git,
		},
	},
});

const invoke = async (handlers, name, params) => {
	const handler = handlers.get(name);
	expect(handler, `tool ${name} was not registered`).toBeDefined();
	return handler(params);
};

describe("get_file_content", () => {
	it("decodes inlined content for files <= 1 MB without calling the Blob API", async () => {
		const getBlob = vi.fn();
		const octokit = stubOctokit({
			repos: {
				getContent: async () => ({
					data: {
						type: "file",
						encoding: "base64",
						content: b64("hello world"),
						size: 11,
						sha: "s1",
					},
					headers: {},
				}),
			},
			git: { getBlob },
		});
		const { handlers, server } = captureHandlers();
		registerFileTools(server, () => octokit);

		const result = await invoke(handlers, "get_file_content", {
			owner: "o",
			repo: "r",
			path: "a.txt",
		});

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("hello world");
		expect(getBlob).not.toHaveBeenCalled();
	});

	it("falls back to the Blob API when the Contents API returns encoding=none (1-100 MB file)", async () => {
		const getBlob = vi.fn(async ({ file_sha }) => {
			expect(file_sha).toBe("bigsha");
			return { data: { content: b64("big file body"), encoding: "base64" }, headers: {} };
		});
		const octokit = stubOctokit({
			repos: {
				getContent: async () => ({
					data: { type: "file", encoding: "none", content: "", size: 5_000_000, sha: "bigsha" },
					headers: {},
				}),
			},
			git: { getBlob },
		});
		const { handlers, server } = captureHandlers();
		registerFileTools(server, () => octokit);

		const result = await invoke(handlers, "get_file_content", {
			owner: "o",
			repo: "r",
			path: "big.bin",
		});

		expect(result.isError).toBeFalsy();
		expect(getBlob).toHaveBeenCalledOnce();
		expect(result.content[0].text).toContain("big file body");
		// The original bug returned an empty body for this branch.
		expect(result.content[0].text).not.toMatch(/```\n\n```/);
	});

	it("re-encodes a utf-8 Blob response", async () => {
		const octokit = stubOctokit({
			repos: {
				getContent: async () => ({
					data: { type: "file", encoding: "none", content: "", size: 2_000_000, sha: "u8" },
					headers: {},
				}),
			},
			git: {
				getBlob: async () => ({ data: { content: "plain text", encoding: "utf-8" }, headers: {} }),
			},
		});
		const { handlers, server } = captureHandlers();
		registerFileTools(server, () => octokit);

		const result = await invoke(handlers, "get_file_content", {
			owner: "o",
			repo: "r",
			path: "u.txt",
		});

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("plain text");
	});

	it("renders a directory listing when the path is a directory", async () => {
		const octokit = stubOctokit({
			repos: {
				getContent: async () => ({
					data: [
						{ type: "dir", name: "sub" },
						{ type: "file", name: "x.ts" },
					],
					headers: {},
				}),
			},
		});
		const { handlers, server } = captureHandlers();
		registerFileTools(server, () => octokit);

		const result = await invoke(handlers, "get_file_content", {
			owner: "o",
			repo: "r",
			path: "src",
		});

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("Directory listing");
		expect(result.content[0].text).toContain("[dir] sub");
		expect(result.content[0].text).toContain("[file] x.ts");
	});

	it("errors when the path is a non-file blob (e.g. submodule)", async () => {
		const octokit = stubOctokit({
			repos: {
				getContent: async () => ({
					data: { type: "submodule", content: null, size: 0, sha: "sm" },
					headers: {},
				}),
			},
		});
		const { handlers, server } = captureHandlers();
		registerFileTools(server, () => octokit);

		const result = await invoke(handlers, "get_file_content", {
			owner: "o",
			repo: "r",
			path: "mod",
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not a regular file");
	});
});
