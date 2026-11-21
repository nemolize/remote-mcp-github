import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_RESPONSE_CHARS } from "../src/mcp/response.js";
import { registerRepoAutolinkTools } from "../src/tools/repo-autolinks.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const autolink = (overrides = {}) => ({
	id: 1,
	key_prefix: "TICKET-",
	url_template: "https://example.test/t/<num>",
	is_alphanumeric: true,
	...overrides,
});

const httpError = (message, status) => {
	const err = new Error(message);
	err.status = status;
	return err;
};

const setup = (repos = {}) => {
	const { handlers, server } = captureHandlers();
	registerRepoAutolinkTools(server, () => ({ rest: { repos } }));
	return handlers;
};

const auditLines = (spy) =>
	spy.mock.calls
		.map(([l]) => l)
		.filter((l) => String(l).startsWith("[github-audit] "))
		.map((l) => JSON.parse(l.slice("[github-audit] ".length)));

afterEach(() => {
	vi.restoreAllMocks();
});

describe("list_autolinks", () => {
	it("renders id, prefix, template and reference type", async () => {
		const handlers = setup({
			listAutolinks: async () => ({
				data: [autolink(), autolink({ id: 2, key_prefix: "N-", is_alphanumeric: false })],
				headers: {},
			}),
		});
		const body = (await invoke(handlers, "list_autolinks", { owner: "o", repo: "r" })).content[0]
			.text;
		expect(body).toContain("# Autolinks of o/r (2)");
		expect(body).toContain("`1` `TICKET-` → https://example.test/t/<num> (alphanumeric)");
		expect(body).toContain("`2` `N-` → https://example.test/t/<num> (numeric)");
	});

	it("says so when there are none", async () => {
		const handlers = setup({ listAutolinks: async () => ({ data: [], headers: {} }) });
		const result = await invoke(handlers, "list_autolinks", { owner: "o", repo: "r" });
		expect(result.content[0].text).toBe("(no autolinks found)");
	});

	it("keeps the count line first when the list exceeds the response cap", async () => {
		const many = Array.from({ length: 300 }, (_, i) =>
			autolink({
				id: i + 1,
				key_prefix: `P${i}-`,
				url_template: `https://example.test/${i}/<num>`,
			}),
		);
		const handlers = setup({ listAutolinks: async () => ({ data: many, headers: {} }) });
		const body = (await invoke(handlers, "list_autolinks", { owner: "o", repo: "r" })).content[0]
			.text;
		expect(body.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
		expect(body.startsWith("# Autolinks of o/r (300)")).toBe(true);
		expect(body).toContain("truncated");
	});

	it("surfaces a GitHub error", async () => {
		const handlers = setup({
			listAutolinks: async () => {
				throw httpError("Forbidden", 403);
			},
		});
		const result = await invoke(handlers, "list_autolinks", { owner: "o", repo: "r" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("HTTP 403");
	});
});

describe("get_autolink", () => {
	it("fetches one autolink by id", async () => {
		let captured;
		const handlers = setup({
			getAutolink: async (params) => {
				captured = params;
				return { data: autolink({ id: 4 }), headers: {} };
			},
		});
		const result = await invoke(handlers, "get_autolink", {
			owner: "o",
			repo: "r",
			autolink_id: 4,
		});
		expect(captured).toEqual({ owner: "o", repo: "r", autolink_id: 4 });
		expect(result.content[0].text).toContain("# Autolink");
		expect(result.content[0].text).toContain("`4` `TICKET-`");
	});

	it("surfaces a missing autolink", async () => {
		const handlers = setup({
			getAutolink: async () => {
				throw httpError("Not Found", 404);
			},
		});
		const result = await invoke(handlers, "get_autolink", {
			owner: "o",
			repo: "r",
			autolink_id: 4,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("HTTP 404");
	});
});

describe("create_autolink", () => {
	it("sends the fields as given and audits the created id", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		let captured;
		const handlers = setup({
			createAutolink: async (params) => {
				captured = params;
				return { data: autolink({ id: 9, is_alphanumeric: false }), headers: {} };
			},
		});
		const result = await invoke(handlers, "create_autolink", {
			owner: "o",
			repo: "r",
			key_prefix: "TICKET-",
			url_template: "https://example.test/t/<num>",
			is_alphanumeric: false,
		});
		expect(captured).toEqual({
			owner: "o",
			repo: "r",
			key_prefix: "TICKET-",
			url_template: "https://example.test/t/<num>",
			is_alphanumeric: false,
		});
		expect(result.content[0].text).toContain("# Autolink created");
		expect(result.content[0].text).toContain("(numeric)");
		expect(auditLines(spy)).toEqual([
			{ tool: "create_autolink", owner: "o", repo: "r", autolink_id: 9 },
		]);
	});

	it("surfaces a validation error with no audit line", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const handlers = setup({
			createAutolink: async () => {
				throw httpError("url_template must contain <num>", 422);
			},
		});
		const result = await invoke(handlers, "create_autolink", {
			owner: "o",
			repo: "r",
			key_prefix: "T-",
			url_template: "https://example.test/",
			is_alphanumeric: true,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("HTTP 422");
		expect(auditLines(spy)).toEqual([]);
	});

	it("marks deletion destructive in the description", () => {
		const descriptions = new Map();
		registerRepoAutolinkTools(
			{ registerTool: (name, config) => descriptions.set(name, config.description) },
			() => ({}),
		);
		expect(descriptions.get("delete_autolink")).toContain("Destructive");
	});
});

describe("delete_autolink", () => {
	it("deletes by id and audits it", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		let captured;
		const handlers = setup({
			deleteAutolink: async (params) => {
				captured = params;
				return { data: undefined, headers: {} };
			},
		});
		const result = await invoke(handlers, "delete_autolink", {
			owner: "o",
			repo: "r",
			autolink_id: 6,
		});
		expect(captured).toEqual({ owner: "o", repo: "r", autolink_id: 6 });
		expect(result.content[0].text).toContain("# Autolink deleted");
		expect(auditLines(spy)).toEqual([
			{ tool: "delete_autolink", owner: "o", repo: "r", autolink_id: 6 },
		]);
	});

	it("surfaces a missing autolink with no audit line", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const handlers = setup({
			deleteAutolink: async () => {
				throw httpError("Not Found", 404);
			},
		});
		const result = await invoke(handlers, "delete_autolink", {
			owner: "o",
			repo: "r",
			autolink_id: 6,
		});
		expect(result.isError).toBe(true);
		expect(auditLines(spy)).toEqual([]);
	});
});
