import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MAX_RESPONSE_CHARS } from "../src/mcp/response.js";
import { MAX_FILE_READ_BYTES } from "../src/tools/file-content-page.js";
import { registerFileTools } from "../src/tools/files.js";
import { registerIssueTools } from "../src/tools/issues.js";
import { registerPullTools } from "../src/tools/pulls.js";

const cases = [
	["get_issue", registerIssueTools, { issue_number: 42 }, "issues", "get"],
	["get_pull_request", registerPullTools, { pull_number: 42 }, "pulls", "get"],
	[
		"get_file_content",
		registerFileTools,
		{ path: "file.txt", ref: "abc123" },
		"repos",
		"getContent",
	],
];

const setup = ([name, register, target, group, method], body, overrides = {}, blobContent) => {
	const data = {
		number: 42,
		title: "Detail",
		state: "open",
		user: { login: "alice" },
		labels: [],
		head: { ref: "feature", sha: "abcdef123" },
		base: { ref: "main", sha: "123456789" },
		body,
		type: "file",
		encoding: "base64",
		content: btoa(String.fromCharCode(...new TextEncoder().encode(body ?? ""))),
		size: new TextEncoder().encode(body ?? "").length,
		...overrides,
	};
	const get = vi.fn(async () => ({ data, headers: {} }));
	let schema;
	let handler;
	register(
		{
			registerTool: (tool, config, fn) => {
				if (tool !== name) return;
				schema = z.object(config.inputSchema);
				handler = fn;
			},
		},
		() => ({
			rest: {
				[group]: { [method]: get },
				git: {
					getBlob: async () => ({
						data: { content: blobContent, encoding: "base64" },
						headers: {},
					}),
				},
			},
		}),
	);
	const args = { owner: "o", repo: "r", ...target };
	return { get, args, schema, call: (extra = {}) => handler(schema.parse({ ...args, ...extra })) };
};

describe.each(cases.slice(0, 2))("%s complete body", (name, register, target, group, method) => {
	const tool = [name, register, target, group, method];
	it("returns the entire long body without an expansion argument", async () => {
		const body = "日本語 😀\n".repeat(1800) + "END-OF-BODY";
		const { call, get, args, schema } = setup(tool, body);
		const result = await call();
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain(body);
		expect(result.content[0].text).not.toContain("truncated;");
		expect(result.content[0].text.length).toBeGreaterThan(MAX_RESPONSE_CHARS);
		expect(schema.shape).not.toHaveProperty("full");
		expect(get).toHaveBeenCalledWith(args);
	});
	it.each(["short body", "", null])("renders short and empty content: %s", async (body) => {
		const { call } = setup(tool, body);
		const result = await call();
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain(body || "(no body)");
	});
	it("preserves API errors", async () => {
		const { call, get } = setup(tool, "body");
		get.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
		const result = await call();
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Not Found (HTTP 404)");
	});
});

const fileText = (result) => {
	expect(result.isError).toBeUndefined();
	return result.content[0].text.split("\n```\n")[1].split("\n```\n")[0];
};

describe("get_file_content ranges", () => {
	it("reconstructs a long single-line Unicode file using only the advertised offsets", async () => {
		const body = "a".repeat(12287) + "😀日本語".repeat(3000) + "END";
		const { call, get, args, schema } = setup(cases[2], body);
		let output = "",
			offset;
		do {
			const result = await call(offset === undefined ? {} : { offset });
			const chunk = fileText(result);
			expect(Array.from(chunk).length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
			output += chunk;
			const next = result.content[0].text.match(/`offset: (\d+)`/);
			offset = next ? Number(next[1]) : undefined;
		} while (offset !== undefined);
		expect(output).toBe(body);
		expect(schema.shape).not.toHaveProperty("full");
		for (const [request] of get.mock.calls) expect(request).toEqual(args);
	});
	it("selects code points without splitting emoji and preserves CRLF", async () => {
		const { call } = setup(cases[2], "a😀\r\nb");
		expect(fileText(await call({ offset: 1, limit: 1 }))).toBe("😀");
		expect(fileText(await call({ offset: 2, limit: 2 }))).toBe("\r\n");
	});
	it.each(["", "x".repeat(8000), "x".repeat(8001)])(
		"reports EOF and continuation at the exact chunk boundary (%#. case)",
		async (body) => {
			const { call } = setup(cases[2], body);
			const result = await call();
			expect(fileText(result)).toBe(body.slice(0, 8000));
			expect(result.content[0].text.includes("More content:")).toBe(body.length > 8000);
		},
	);
	it("allows EOF but rejects offsets past it", async () => {
		const { call } = setup(cases[2], "abc");
		expect(fileText(await call({ offset: 3 }))).toBe("");
		expect((await call({ offset: 4 })).isError).toBe(true);
	});
	it.each([{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 8001 }, { limit: "1" }])(
		"rejects invalid range %j",
		(extra) => {
			const { schema, args } = setup(cases[2], "abc");
			expect(schema.safeParse({ ...args, ...extra }).success).toBe(false);
		},
	);
	it("rejects ranges on directories", async () => {
		const { call, get } = setup(cases[2], "");
		get.mockResolvedValue({ data: [], headers: {} });
		expect((await call({ offset: 0 })).isError).toBe(true);
		expect((await call()).isError).toBeUndefined();
	});
	it("rejects oversized file metadata before fetching a blob", async () => {
		const { call } = setup(cases[2], "", { size: MAX_FILE_READ_BYTES + 1, encoding: "none" });
		const result = await call();
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("read limit");
	});
	it("validates UTF-8 beyond the selected range, including incomplete final sequences", async () => {
		for (const suffix of ["\xff", "\xf0\x9f"]) {
			const { call } = setup(cases[2], "", { content: btoa("a".repeat(20000) + suffix) });
			const result = await call({ limit: 1 });
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("not valid UTF-8");
		}
	});
	it("handles GitHub base64 line breaks and a BOM across ranges", async () => {
		const { call } = setup(cases[2], "", { content: "77u/YfCf\n mIBi\r\n" });
		expect(fileText(await call())).toBe("a😀b");
		expect(fileText(await call({ offset: 1, limit: 1 }))).toBe("😀");
	});
	it.each([
		["ASCII", () => ("YWJj".repeat(6666666) + "eno=").replace(/.{60}/g, "$&\n"), 19999998, "zz"],
		["emoji", () => "8J+YgPCfmIDwn5iA".repeat(1666666) + "8J+YgPCfmIA=", 4999998, "😀😀"],
	])(
		"reads the end of a 20 MB %s blob with bounded output",
		async (_name, makeContent, offset, tail) => {
			const { call } = setup(
				cases[2],
				"",
				{ size: MAX_FILE_READ_BYTES, encoding: "none" },
				makeContent(),
			);
			const result = await call({ offset, limit: 2 });
			expect(fileText(result)).toBe(tail);
			expect(result.content[0].text).toContain("End of file.");
			expect(result.content[0].text.length).toBeLessThan(500);
		},
	);
});
