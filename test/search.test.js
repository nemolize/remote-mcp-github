import { describe, expect, it } from "vitest";

import { registerSearchTools } from "../src/tools/search.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const stubOctokit = (code) => ({
	rest: {
		search: { code: code ?? (async () => ({ data: { total_count: 0, items: [] }, headers: {} })) },
	},
});

const register = (octokit) => {
	const { handlers, server } = captureHandlers();
	registerSearchTools(server, () => octokit);
	return handlers;
};

const codeItem = (i) => ({
	path: `src/file-${i}.ts`,
	html_url: `https://example.test/o/r/blob/main/src/file-${i}.ts`,
	repository: { full_name: "o/r" },
});

describe("registerSearchTools — search_code", () => {
	it("reports no matches for an empty result set", async () => {
		const handlers = register(
			stubOctokit(async () => ({ data: { total_count: 0, items: [] }, headers: {} })),
		);
		const result = await invoke(handlers, "search_code", { query: "needle" });
		const body = result.content[0].text;
		expect(result.isError).toBeUndefined();
		expect(body).toContain("No matches for `needle`.");
	});

	it("renders a final-page header and per-match bullets", async () => {
		const items = [codeItem(0)];
		const handlers = register(
			stubOctokit(async () => ({ data: { total_count: 1, items }, headers: {} })),
		);
		const result = await invoke(handlers, "search_code", {
			query: "repo:o/r foo",
			per_page: 20,
			page: 1,
		});
		const body = result.content[0].text;
		expect(body).toContain("# Code search results for `repo:o/r foo` (showing 1 of 1)");
		expect(body).toContain("- **o/r** — `src/file-0.ts`");
		expect(body).toContain("https://example.test/o/r/blob/main/src/file-0.ts");
	});

	// NOTE: per_page/page defaults come from the MCP SDK schema layer, which
	// handler-direct invocation bypasses — pass them explicitly here.
	it("emits a paging hint when more results remain", async () => {
		const items = Array.from({ length: 20 }, (_, i) => codeItem(i));
		const handlers = register(
			stubOctokit(async () => ({ data: { total_count: 250, items }, headers: {} })),
		);
		const result = await invoke(handlers, "search_code", {
			query: "language:ts",
			per_page: 20,
			page: 1,
		});
		const body = result.content[0].text;
		expect(body).toContain("(page 1, showing 20 of 250; pass next `page` for more)");
	});

	it("surfaces Octokit errors via wrapTool (isError = true)", async () => {
		const handlers = register(
			stubOctokit(async () => {
				const err = new Error("Validation Failed");
				err.status = 422;
				throw err;
			}),
		);
		const result = await invoke(handlers, "search_code", { query: "bad:qualifier" });
		expect(result.isError).toBe(true);
		const body = result.content[0].text;
		expect(body).toContain("Validation Failed");
		expect(body).toContain("HTTP 422");
	});
});
