import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MAX_RESPONSE_CHARS } from "../src/mcp/response.js";
import { MAX_FILE_CONTENT_LENGTH } from "../src/tools/common.js";
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

const setup = ([name, register, target, group, method], body, overrides = {}) => {
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
		() => ({ rest: { [group]: { [method]: get } } }),
	);
	const args = { owner: "o", repo: "r", ...target };
	return { get, args, schema, call: (extra = {}) => handler(schema.parse({ ...args, ...extra })) };
};

describe.each(cases)("%s full response", (name, register, target, group, method) => {
	const tool = [name, register, target, group, method];
	it("makes the omitted remainder reachable using the advertised argument", async () => {
		const body = "日本語 😀\n".repeat(1800) + "END-OF-BODY";
		const { call, get, args } = setup(tool, body);
		const abbreviated = await call();
		const explicitDefault = await call({ full: false });
		expect(abbreviated.isError).toBeUndefined();
		expect(abbreviated.content[0].text.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
		expect(abbreviated.content[0].text).toContain("`full: true`");
		expect(abbreviated.content[0].text).not.toContain("paginate");
		expect(abbreviated.content[0].text).not.toContain("END-OF-BODY");
		expect(explicitDefault).toEqual(abbreviated);

		const complete = await call({ full: true });
		expect(complete.isError).toBeUndefined();
		expect(complete.content[0].text).toContain(body);
		expect(complete.content[0].text).not.toContain("truncated;");
		expect(complete.content[0].text.length).toBeGreaterThan(MAX_RESPONSE_CHARS);
		if (name === "get_file_content") expect(complete.content[0].text).toMatch(/END-OF-BODY\n```$/);
		for (const [request] of get.mock.calls) expect(request).toEqual(args);
	});

	it.each(["short body", "", null])("preserves short and empty content: %s", async (body) => {
		const { call } = setup(tool, body);
		expect(await call({ full: true })).toEqual(await call());
	});

	it("rejects a non-boolean full argument", () => {
		const { schema, args } = setup(tool, "body");
		expect(schema.safeParse({ ...args, full: "true" }).success).toBe(false);
	});

	it("preserves API error handling in full mode", async () => {
		const { call, get } = setup(tool, "body");
		get.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
		const result = await call({ full: true });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Not Found (HTTP 404)");
	});
});

describe("get_file_content full mode limits", () => {
	it("still rejects oversized files", async () => {
		const { call } = setup(cases[2], "", { size: MAX_FILE_CONTENT_LENGTH + 1, encoding: "none" });
		const result = await call({ full: true });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("read limit");
	});

	it("still rejects binary files", async () => {
		const { call } = setup(cases[2], "", { content: btoa("\xff\xfe"), size: 2 });
		const result = await call({ full: true });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not valid UTF-8");
	});
});
