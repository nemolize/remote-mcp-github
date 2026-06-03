import { describe, expect, it, vi } from "vitest";

import { MAX_FILE_CONTENT_LENGTH } from "../src/tools/common.js";
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
// non-file endpoints exist only so the other file tools register cleanly.
const stubOctokit = (overrides = {}) => ({
	rest: {
		repos: {
			getContent: async () => ({ data: {}, headers: {} }),
			createOrUpdateFileContents: async () => ({ data: { commit: {}, content: {} }, headers: {} }),
			deleteFile: async () => ({ data: { commit: {} }, headers: {} }),
			...overrides.repos,
		},
		git: {
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

const fileContent = (params) => {
	const { handlers, server } = captureHandlers();
	registerFileTools(server, () => params.octokit);
	return invoke(handlers, "get_file_content", { owner: "o", repo: "r", path: params.path });
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
						html_url: "https://example.test/a.txt",
					},
					headers: {},
				}),
			},
			git: { getBlob },
		});

		const result = await fileContent({ octokit, path: "a.txt" });

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
					data: {
						type: "file",
						encoding: "none",
						content: "",
						size: 2_000_000,
						sha: "bigsha",
						html_url: "https://example.test/big.txt",
					},
					headers: {},
				}),
			},
			git: { getBlob },
		});

		const result = await fileContent({ octokit, path: "big.txt" });

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
					data: {
						type: "file",
						encoding: "none",
						content: "",
						size: 2_000_000,
						sha: "u8",
						html_url: "https://example.test/u.txt",
					},
					headers: {},
				}),
			},
			git: {
				getBlob: async () => ({ data: { content: "plain text", encoding: "utf-8" }, headers: {} }),
			},
		});

		const result = await fileContent({ octokit, path: "u.txt" });

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("plain text");
	});

	it("rejects files over the read size limit without fetching the blob", async () => {
		const getBlob = vi.fn();
		const octokit = stubOctokit({
			repos: {
				getContent: async () => ({
					data: {
						type: "file",
						encoding: "none",
						content: "",
						size: MAX_FILE_CONTENT_LENGTH + 1,
						sha: "huge",
						html_url: "https://example.test/huge.bin",
					},
					headers: {},
				}),
			},
			git: { getBlob },
		});

		const result = await fileContent({ octokit, path: "huge.bin" });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("read limit");
		expect(result.content[0].text).toContain("https://example.test/huge.bin");
		expect(getBlob).not.toHaveBeenCalled();
	});

	it("errors on a binary (non-UTF-8) body instead of emitting mojibake", async () => {
		// 0xFF 0xFE is not a valid UTF-8 sequence.
		const binaryB64 = b64(String.fromCharCode(0xff, 0xfe, 0x00));
		const octokit = stubOctokit({
			repos: {
				getContent: async () => ({
					data: {
						type: "file",
						encoding: "none",
						content: "",
						size: 1_500_000,
						sha: "binsha",
						html_url: "https://example.test/blob.bin",
					},
					headers: {},
				}),
			},
			git: {
				getBlob: async () => ({ data: { content: binaryB64, encoding: "base64" }, headers: {} }),
			},
		});

		const result = await fileContent({ octokit, path: "blob.bin" });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("binary");
		expect(result.content[0].text).toContain("https://example.test/blob.bin");
	});

	it("handles an empty (0-byte) file without a Blob API round-trip", async () => {
		const getBlob = vi.fn();
		const octokit = stubOctokit({
			repos: {
				getContent: async () => ({
					data: {
						type: "file",
						encoding: "base64",
						content: "",
						size: 0,
						sha: "empty",
						html_url: "https://example.test/empty.txt",
					},
					headers: {},
				}),
			},
			git: { getBlob },
		});

		const result = await fileContent({ octokit, path: "empty.txt" });

		expect(result.isError).toBeFalsy();
		expect(getBlob).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("(0 bytes)");
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

		const result = await fileContent({ octokit, path: "src" });

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

		const result = await fileContent({ octokit, path: "mod" });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not a regular file");
	});
});
