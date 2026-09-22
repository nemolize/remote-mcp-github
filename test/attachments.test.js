import { describe, expect, it } from "vitest";
import { z } from "zod";

import { registerAttachmentTools } from "../src/tools/attachments.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const ONE_PIXEL_PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const ASSET_URL = "https://github.com/user-attachments/assets/0000-1111";

const setup = ({ requestImpl } = {}) => {
	const calls = [];
	const octokit = {
		// `return await`, not a bare return: the Workers pool's rejection tracker
		// reports an adopted rejected promise as unhandled, failing the run.
		request: async (options) => {
			calls.push(options);
			if (requestImpl != null) return await requestImpl(options);
			return { data: { url: ASSET_URL }, headers: {} };
		},
		rest: {
			repos: {
				get: async () => ({ data: { id: 4242, default_branch: "main" }, headers: {} }),
			},
		},
	};
	const { handlers, server } = captureHandlers();
	const schemas = new Map();
	registerAttachmentTools(
		{
			registerTool: (name, config, handler) => {
				schemas.set(name, z.object(config.inputSchema));
				server.registerTool(name, config, handler);
			},
		},
		() => octokit,
	);
	return { handlers, calls, schemas };
};

const body = (result) => result.content.map((c) => c.text).join("\n");

describe("upload_attachment", () => {
	it("uploads a png and returns an embeddable asset URL", async () => {
		const { handlers, calls } = setup();
		const result = await invoke(handlers, "upload_attachment", {
			owner: "o",
			repo: "r",
			filename: "shot.png",
			content_base64: ONE_PIXEL_PNG_B64,
		});

		expect(result.isError).toBeUndefined();
		expect(body(result)).toContain(ASSET_URL);
		expect(body(result)).toContain(`![shot.png](${ASSET_URL})`);

		expect(calls).toHaveLength(1);
		const url = new URL(calls[0].url);
		expect(url.origin).toBe("https://uploads.github.com");
		expect(url.pathname).toBe("/user-attachments/assets");
		expect(url.searchParams.get("name")).toBe("shot.png");
		expect(url.searchParams.get("content_type")).toBe("image/png");
		expect(url.searchParams.get("repository_id")).toBe("4242");
		expect(calls[0].method).toBe("POST");

		const expected = Buffer.from(ONE_PIXEL_PNG_B64, "base64");
		expect(calls[0].data).toBeInstanceOf(Uint8Array);
		expect(calls[0].data.byteLength).toBe(expected.length);
		expect([...calls[0].data.slice(0, 8)]).toEqual([...expected.subarray(0, 8)]);
		expect(calls[0].headers["content-type"]).toBe("application/octet-stream");
	});

	it("renders video as a bare URL, since an image embed would not play", async () => {
		const { handlers } = setup();
		const result = await invoke(handlers, "upload_attachment", {
			owner: "o",
			repo: "r",
			filename: "clip.mp4",
			content_base64: ONE_PIXEL_PNG_B64,
		});

		expect(result.isError).toBeUndefined();
		expect(body(result)).not.toContain("![clip.mp4]");
		expect(body(result)).toContain(ASSET_URL);
	});

	it.each([
		["repro.zip", "archive"],
		["bundle.tar.gz", "archive"],
		["notes.pdf", "document"],
		["log.txt", "document"],
		["audio.mp3", "unsupported media"],
		["screenshot", "no extension"],
	])("rejects %s (%s) without uploading", async (filename) => {
		const { handlers, calls } = setup();
		const result = await invoke(handlers, "upload_attachment", {
			owner: "o",
			repo: "r",
			filename,
			content_base64: ONE_PIXEL_PNG_B64,
		});

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("not a supported attachment type");
		expect(calls).toHaveLength(0);
	});

	it("matches the extension case-insensitively", async () => {
		const { handlers, calls } = setup();
		const result = await invoke(handlers, "upload_attachment", {
			owner: "o",
			repo: "r",
			filename: "SHOT.PNG",
			content_base64: ONE_PIXEL_PNG_B64,
		});

		expect(result.isError).toBeUndefined();
		expect(new URL(calls[0].url).searchParams.get("content_type")).toBe("image/png");
	});

	it("rejects malformed base64 without uploading", async () => {
		const { handlers, calls } = setup();
		const result = await invoke(handlers, "upload_attachment", {
			owner: "o",
			repo: "r",
			filename: "shot.png",
			content_base64: "!!!not base64!!!",
		});

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("not valid base64");
		expect(calls).toHaveLength(0);
	});

	it("rejects a payload over the transport limit without uploading", async () => {
		const { handlers, calls } = setup();
		const oversize = Buffer.alloc(4 * 1024 * 1024, 0).toString("base64");
		const result = await invoke(handlers, "upload_attachment", {
			owner: "o",
			repo: "r",
			filename: "big.png",
			content_base64: oversize,
		});

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("transport limit");
		expect(calls).toHaveLength(0);
	});

	it("caps content_base64 in the schema, so the handler is never reached", () => {
		const { schemas } = setup();
		const schema = schemas.get("upload_attachment");
		const oversize = "A".repeat(4 * 1024 * 1024 + 1);
		const parsed = schema.safeParse({
			owner: "o",
			repo: "r",
			filename: "big.png",
			content_base64: oversize,
		});

		expect(parsed.success).toBe(false);
		expect(JSON.stringify(parsed.error.issues)).toContain("character limit");
	});

	it("states exactly the cap it enforces, in both directions", () => {
		const { schemas } = setup();
		const schema = schemas.get("upload_attachment");
		const described = schema.shape.content_base64.description;
		const stated = Number(described.match(/up to (\d+) bytes/)[1]);
		const base = { owner: "o", repo: "r", filename: "a.png" };
		// base64 pads to a whole 4-char quantum, so this is what `stated` bytes costs.
		const encodedLength = (byteCount) => Math.ceil(byteCount / 3) * 4;

		expect(
			schema.safeParse({ ...base, content_base64: "A".repeat(encodedLength(stated)) }).success,
			"a file of exactly the stated size must be accepted",
		).toBe(true);
		expect(
			schema.safeParse({ ...base, content_base64: "A".repeat(encodedLength(stated + 1)) }).success,
			"a file one byte over the stated size must be rejected",
		).toBe(false);
	});

	it("rejects a zero-byte payload without uploading", async () => {
		const { handlers, calls } = setup();
		const result = await invoke(handlers, "upload_attachment", {
			owner: "o",
			repo: "r",
			filename: "empty.png",
			content_base64: "   ",
		});

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("0 bytes");
		expect(calls).toHaveLength(0);
	});

	it("rejects a filename resolving to a prototype key", async () => {
		const { handlers, calls } = setup();
		for (const filename of ["shot.constructor", "shot.__proto__"]) {
			const result = await invoke(handlers, "upload_attachment", {
				owner: "o",
				repo: "r",
				filename,
				content_base64: ONE_PIXEL_PNG_B64,
			});
			expect(result.isError, filename).toBe(true);
			expect(body(result), filename).toContain("not a supported attachment type");
		}
		expect(calls).toHaveLength(0);
	});

	it("escapes a backtick-bearing filename in the rejection message too", async () => {
		const { handlers } = setup();
		const result = await invoke(handlers, "upload_attachment", {
			owner: "o",
			repo: "r",
			filename: "a`b.zip",
			content_base64: ONE_PIXEL_PNG_B64,
		});

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("``a`b.zip``");
	});

	it("escapes a filename that would break the embed markdown", async () => {
		const { handlers } = setup();
		const result = await invoke(handlers, "upload_attachment", {
			owner: "o",
			repo: "r",
			filename: "a]b`c.png",
			content_base64: ONE_PIXEL_PNG_B64,
		});

		const out = body(result);
		expect(result.isError).toBeUndefined();
		expect(out).toContain(`![a\\]b\`c.png](${ASSET_URL})`);
		expect(out).toContain("``a]b`c.png``");
	});

	it("reports an upload that returns no asset URL", async () => {
		const { handlers } = setup({ requestImpl: async () => ({ data: {}, headers: {} }) });
		const result = await invoke(handlers, "upload_attachment", {
			owner: "o",
			repo: "r",
			filename: "shot.png",
			content_base64: ONE_PIXEL_PNG_B64,
		});

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("no asset URL");
	});

	it("maps the upload's 404 to the write-access failure it actually signals", async () => {
		const { handlers } = setup({
			requestImpl: async () => {
				const err = new Error("Not Found");
				err.status = 404;
				throw err;
			},
		});
		const result = await invoke(handlers, "upload_attachment", {
			owner: "o",
			repo: "r",
			filename: "shot.png",
			content_base64: ONE_PIXEL_PNG_B64,
		});

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("requires write access");
	});
});
