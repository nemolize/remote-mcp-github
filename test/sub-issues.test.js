import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerSubIssueTools } from "../src/tools/sub-issues.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const REPO_URL = "https://api.github.com/repos/o/r";

const issueGet = vi.fn(async ({ issue_number, repo = "r" }) => ({
	data: { id: 9000 + issue_number, repository_url: `https://api.github.com/repos/o/${repo}` },
	headers: {},
}));

const makeOctokit = (overrides = {}) => ({
	rest: {
		issues: {
			get: issueGet,
			addSubIssue: vi.fn(async () => ({ data: {}, headers: {} })),
			removeSubIssue: vi.fn(async () => ({ data: {}, headers: {} })),
			reprioritizeSubIssue: vi.fn(async () => ({ data: {}, headers: {} })),
			listSubIssues: vi.fn(async () => ({ data: [], headers: {} })),
			...overrides,
		},
	},
});

const run = async (octokit, tool, params) => {
	const { handlers, server } = captureHandlers();
	registerSubIssueTools(server, () => octokit);
	return invoke(handlers, tool, params);
};

const textOf = (result) => result.content[0].text;
const auditLines = (spy) =>
	spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[github-audit]"));

afterEach(() => {
	vi.restoreAllMocks();
	issueGet.mockClear();
});

describe("list_sub_issues", () => {
	const sub = (number, repoUrl = REPO_URL, state = "open") => ({
		number,
		title: `Child ${number}`,
		state,
		html_url: `https://github.com/x/${number}`,
		repository_url: repoUrl,
	});

	it("renders owner/repo#N lines, marks other-repo rows read-only, and emits no audit line", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const listSubIssues = vi.fn(async () => ({
			data: [sub(2), sub(40, "https://api.github.com/repos/o/other", "closed")],
			headers: {},
		}));
		const result = await run(makeOctokit({ listSubIssues }), "list_sub_issues", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			per_page: 30,
		});
		expect(listSubIssues).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			issue_number: 1,
			per_page: 30,
		});
		const out = textOf(result);
		expect(out).toContain("- [o/r#2](https://github.com/x/2) **Child 2** (open)\n");
		expect(out).toContain(
			"[o/other#40](https://github.com/x/40) **Child 40** (closed) — other repository",
		);
		expect(out.split("\n").find((l) => l.includes("o/r#2"))).not.toContain("read-only");
		expect(auditLines(logSpy)).toHaveLength(0);
	});

	it("keeps GitHub's order, flags more pages, and forwards page", async () => {
		const listSubIssues = vi.fn(async () => ({
			data: [sub(5), sub(3)],
			headers: { link: '<https://api.github.com/x?page=3>; rel="next"' },
		}));
		const result = await run(makeOctokit({ listSubIssues }), "list_sub_issues", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			per_page: 2,
			page: 2,
		});
		expect(listSubIssues.mock.calls[0][0].page).toBe(2);
		const out = textOf(result);
		expect(out).toContain("page 2");
		expect(out.indexOf("o/r#5")).toBeLessThan(out.indexOf("o/r#3"));
	});

	it("says an empty first page has no sub-issues and an empty later page has no results", async () => {
		const first = await run(makeOctokit(), "list_sub_issues", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			per_page: 30,
		});
		expect(textOf(first)).toContain("(no sub-issues on this issue)");
		const later = await run(makeOctokit(), "list_sub_issues", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			per_page: 30,
			page: 4,
		});
		expect(textOf(later)).toContain("(no sub-issues on this page)");
	});
});

describe("add_sub_issue", () => {
	it("sends the parent number in the path and the resolved child id in the body, plus one audit line", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const octokit = makeOctokit();
		const result = await run(octokit, "add_sub_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_number: 2,
		});
		expect(result.isError).toBeUndefined();
		expect(octokit.rest.issues.addSubIssue).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_id: 9002,
		});
		const lines = auditLines(logSpy);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0].replace("[github-audit] ", ""))).toEqual({
			tool: "add_sub_issue",
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_number: 2,
		});
	});

	it("sends replace_parent only when given", async () => {
		const octokit = makeOctokit();
		await run(octokit, "add_sub_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_number: 2,
			replace_parent: true,
		});
		expect(octokit.rest.issues.addSubIssue.mock.calls[0][0].replace_parent).toBe(true);
	});

	it("rejects a pull request child without writing or auditing", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const octokit = makeOctokit({
			get: vi.fn(async () => ({
				data: { id: 1, pull_request: { url: "x" }, repository_url: REPO_URL },
				headers: {},
			})),
		});
		const result = await run(octokit, "add_sub_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_number: 2,
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("pull request");
		expect(octokit.rest.issues.addSubIssue).not.toHaveBeenCalled();
		expect(auditLines(logSpy)).toHaveLength(0);
	});

	it("maps a missing child (404) to a not-found error without writing", async () => {
		const octokit = makeOctokit({
			get: vi.fn(async () => {
				throw Object.assign(new Error("Not Found"), { status: 404 });
			}),
		});
		const result = await run(octokit, "add_sub_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_number: 2,
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("o/r#2 not found or not accessible");
		expect(octokit.rest.issues.addSubIssue).not.toHaveBeenCalled();
	});

	it("passes a non-404 lookup failure through with its HTTP status", async () => {
		const octokit = makeOctokit({
			get: vi.fn(async () => {
				throw Object.assign(new Error("Server Error"), { status: 502 });
			}),
		});
		const result = await run(octokit, "add_sub_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_number: 2,
		});
		expect(textOf(result)).toContain("(HTTP 502)");
	});

	it("rejects a child that resolves to another repository (transferred issue)", async () => {
		const octokit = makeOctokit({
			get: vi.fn(async () => ({
				data: { id: 1, repository_url: "https://api.github.com/repos/o/elsewhere" },
				headers: {},
			})),
		});
		const result = await run(octokit, "add_sub_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_number: 2,
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("another repository");
		expect(octokit.rest.issues.addSubIssue).not.toHaveBeenCalled();
	});

	it("surfaces a GitHub write failure with its status and no audit line", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const octokit = makeOctokit({
			addSubIssue: vi.fn(async () => {
				throw Object.assign(new Error("Validation Failed"), { status: 422 });
			}),
		});
		const result = await run(octokit, "add_sub_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_number: 2,
		});
		expect(textOf(result)).toContain("Validation Failed (HTTP 422)");
		expect(auditLines(logSpy)).toHaveLength(0);
	});
});

describe("remove_sub_issue", () => {
	it("sends the parent number in the path and the resolved child id in the body", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const octokit = makeOctokit();
		await run(octokit, "remove_sub_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_number: 2,
		});
		expect(octokit.rest.issues.removeSubIssue).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_id: 9002,
		});
		expect(auditLines(logSpy)).toHaveLength(1);
	});

	it("sends DELETE with a JSON body on the singular /sub_issue path", async () => {
		const { Octokit } = await import("octokit");
		const requests = [];
		const octo = new Octokit({
			request: {
				fetch: async (url, init) => {
					requests.push({ url: String(url), method: init.method, body: init.body });
					return new Response("{}", {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				},
			},
		});
		await octo.rest.issues.removeSubIssue({
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_id: 9002,
		});
		expect(requests[0].method).toBe("DELETE");
		expect(requests[0].url).toMatch(/\/repos\/o\/r\/issues\/1\/sub_issue$/);
		expect(JSON.parse(requests[0].body)).toEqual({ sub_issue_id: 9002 });
	});
});

describe("reprioritize_sub_issue", () => {
	it("maps after_sub_issue_number to after_id with resolved ids", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const octokit = makeOctokit();
		const result = await run(octokit, "reprioritize_sub_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_number: 2,
			after_sub_issue_number: 3,
		});
		expect(octokit.rest.issues.reprioritizeSubIssue).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_id: 9002,
			after_id: 9003,
		});
		expect(textOf(result)).toContain("moved after #3");
		expect(auditLines(logSpy)).toHaveLength(1);
	});

	it("maps before_sub_issue_number to before_id", async () => {
		const octokit = makeOctokit();
		await run(octokit, "reprioritize_sub_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_number: 2,
			before_sub_issue_number: 3,
		});
		expect(octokit.rest.issues.reprioritizeSubIssue.mock.calls[0][0]).toEqual({
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_id: 9002,
			before_id: 9003,
		});
	});

	it("rejects an anchor equal to the moved sub-issue without any request", async () => {
		const octokit = makeOctokit();
		const result = await run(octokit, "reprioritize_sub_issue", {
			owner: "o",
			repo: "r",
			issue_number: 1,
			sub_issue_number: 2,
			after_sub_issue_number: 2,
		});
		expect(result.isError).toBe(true);
		expect(issueGet).not.toHaveBeenCalled();
		expect(octokit.rest.issues.reprioritizeSubIssue).not.toHaveBeenCalled();
	});

	it("rejects both or neither position when called directly", async () => {
		const octokit = makeOctokit();
		for (const position of [{}, { after_sub_issue_number: 3, before_sub_issue_number: 4 }]) {
			const result = await run(octokit, "reprioritize_sub_issue", {
				owner: "o",
				repo: "r",
				issue_number: 1,
				sub_issue_number: 2,
				...position,
			});
			expect(result.isError).toBe(true);
		}
		expect(octokit.rest.issues.reprioritizeSubIssue).not.toHaveBeenCalled();
	});

	it("rejects both or neither position over tools/call and accepts exactly one", async () => {
		const octokit = makeOctokit();
		const server = new McpServer({ name: "t", version: "0" });
		registerSubIssueTools(server, () => octokit);
		const [clientT, serverT] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "c", version: "0" });
		await Promise.all([server.connect(serverT), client.connect(clientT)]);
		const base = { owner: "o", repo: "r", issue_number: 1, sub_issue_number: 2 };
		const call = (args) =>
			client.callTool({ name: "reprioritize_sub_issue", arguments: { ...base, ...args } });

		for (const args of [{}, { after_sub_issue_number: 3, before_sub_issue_number: 4 }]) {
			const rejected = await call(args).then(
				(r) => r.isError === true,
				() => true,
			);
			expect(rejected).toBe(true);
		}
		expect(octokit.rest.issues.reprioritizeSubIssue).not.toHaveBeenCalled();

		const ok = await call({ before_sub_issue_number: 3 });
		expect(ok.isError).toBeFalsy();
		expect(octokit.rest.issues.reprioritizeSubIssue).toHaveBeenCalledTimes(1);
		await client.close();
	});
});
