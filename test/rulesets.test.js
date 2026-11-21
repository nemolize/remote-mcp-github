import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_RESPONSE_CHARS } from "../src/mcp/response.js";
import { registerRulesetTools } from "../src/tools/rulesets.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const stubOctokit = (overrides) => ({
	rest: {
		repos: {
			get: async () => ({ data: { default_branch: "main" }, headers: {} }),
			getRepoRulesets: async () => ({ data: [], headers: {} }),
			getRepoRuleset: async () => ({ data: sampleRuleset(), headers: {} }),
			getBranchRules: async () => ({ data: [], headers: {} }),
			...overrides,
		},
	},
});

const sampleRuleset = (overrides = {}) => ({
	id: 77,
	name: "Protect main",
	target: "branch",
	source_type: "Repository",
	source: "o/r",
	enforcement: "active",
	conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: ["refs/heads/wip"] } },
	bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
	rules: [
		{ type: "deletion" },
		{ type: "pull_request", parameters: { required_approving_review_count: 1 } },
	],
	_links: { html: { href: "https://github.com/o/r/rules/77" } },
	...overrides,
});

const setup = (overrides) => {
	const { handlers, server } = captureHandlers();
	const octokit = stubOctokit(overrides);
	registerRulesetTools(server, () => octokit);
	return { handlers, octokit };
};

describe("registerRulesetTools", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("list_repo_rulesets renders id, name, target, enforcement and source", async () => {
		const { handlers } = setup({
			getRepoRulesets: async () => ({
				data: [
					sampleRuleset(),
					sampleRuleset({
						id: 78,
						name: "Org tags",
						target: "tag",
						enforcement: "evaluate",
						source_type: "Organization",
						source: "o",
					}),
				],
				headers: {},
			}),
		});

		const result = await invoke(handlers, "list_repo_rulesets", { owner: "o", repo: "r" });
		const body = result.content[0].text;
		expect(body).toContain("# Rulesets in o/r (2)");
		expect(body).toContain("- `77` **Protect main** — branch, active, source: o/r (Repository)");
		expect(body).toContain("- `78` **Org tags** — tag, evaluate, source: o (Organization)");
		expect(result.isError).toBeUndefined();
	});

	it("list_repo_rulesets reports an empty list and marks a further page", async () => {
		const empty = setup();
		const none = await invoke(empty.handlers, "list_repo_rulesets", { owner: "o", repo: "r" });
		expect(none.content[0].text).toBe("(no rulesets found)");

		const paged = setup({
			getRepoRulesets: async () => ({
				data: [sampleRuleset()],
				headers: { link: '<https://api.github.com/x?page=2>; rel="next"' },
			}),
		});
		const result = await invoke(paged.handlers, "list_repo_rulesets", {
			owner: "o",
			repo: "r",
			page: 1,
		});
		expect(result.content[0].text).toContain("more available");
	});

	it("an empty later page reads as a page end, not as nothing existing", async () => {
		const { handlers } = setup();
		const rulesets = await invoke(handlers, "list_repo_rulesets", {
			owner: "o",
			repo: "r",
			page: 2,
		});
		expect(rulesets.content[0].text).toBe("(no rulesets on this page)");
		const rules = await invoke(handlers, "check_branch_rules", {
			owner: "o",
			repo: "r",
			branch: "main",
			per_page: 100,
			page: 2,
		});
		expect(rules.content[0].text).toContain("(no rules on this page for `main`");
	});

	it("get_repo_ruleset shows 0 bypass actors for an explicit empty list", async () => {
		const { handlers } = setup({
			getRepoRuleset: async () => ({
				data: sampleRuleset({ bypass_actors: [] }),
				headers: {},
			}),
		});
		const result = await invoke(handlers, "get_repo_ruleset", {
			owner: "o",
			repo: "r",
			ruleset_id: 77,
		});
		expect(result.content[0].text).toContain("- bypass actors: 0");
	});

	it("list_repo_rulesets surfaces an API error via wrapTool", async () => {
		const { handlers } = setup({
			getRepoRulesets: async () => {
				throw new Error("403 Forbidden");
			},
		});
		const result = await invoke(handlers, "list_repo_rulesets", { owner: "o", repo: "r" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("403");
	});

	it("get_repo_ruleset renders the summary, bypass actors and each rule's parameters", async () => {
		const { handlers } = setup();
		const result = await invoke(handlers, "get_repo_ruleset", {
			owner: "o",
			repo: "r",
			ruleset_id: 77,
		});
		const body = result.content[0].text;
		expect(body).toContain("# Ruleset `77` in o/r");
		expect(body).toContain("> Protect main");
		expect(body).toContain("- target: branch");
		expect(body).toContain("- enforcement: active");
		expect(body).toContain("- source: o/r (Repository)");
		expect(body).toContain("- ref include: `~DEFAULT_BRANCH`");
		expect(body).toContain("- ref exclude: `refs/heads/wip`");
		expect(body).toContain("- bypass actors: 1");
		expect(body).toContain("- rules: 2");
		expect(body).toContain("- RepositoryRole `5` — always");
		expect(body).toContain("- `deletion`");
		expect(body).toContain('- `pull_request` {"required_approving_review_count":1}');
		expect(body).toContain("https://github.com/o/r/rules/77");
	});

	it("get_repo_ruleset tolerates a ruleset with no conditions, bypass actors or rules", async () => {
		const { handlers } = setup({
			getRepoRuleset: async () => ({
				data: sampleRuleset({ conditions: null, bypass_actors: undefined, rules: undefined }),
				headers: {},
			}),
		});
		const result = await invoke(handlers, "get_repo_ruleset", {
			owner: "o",
			repo: "r",
			ruleset_id: 77,
		});
		const body = result.content[0].text;
		expect(body).toContain("- ref include: (none)");
		expect(body).toContain("- bypass actors: (not returned");
		expect(body).toContain("- rules: 0");
		expect(body).not.toContain("## Rules");
	});

	it("get_repo_ruleset keeps the summary lines when the rule list exceeds the response cap", async () => {
		const rules = Array.from({ length: 400 }, (_, i) => ({
			type: "required_status_checks",
			parameters: { required_status_checks: [{ context: `check-${i}` }] },
		}));
		const { handlers } = setup({
			getRepoRuleset: async () => ({ data: sampleRuleset({ rules }), headers: {} }),
		});
		const result = await invoke(handlers, "get_repo_ruleset", {
			owner: "o",
			repo: "r",
			ruleset_id: 77,
		});
		const body = result.content[0].text;
		expect(body).toContain("- enforcement: active");
		expect(body).toContain("- bypass actors: 1");
		expect(body).toContain("- rules: 400");
		expect(Array.from(body).length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
	});

	it("get_repo_ruleset surfaces an API error via wrapTool", async () => {
		const { handlers } = setup({
			getRepoRuleset: async () => {
				throw new Error("404 Not Found");
			},
		});
		const result = await invoke(handlers, "get_repo_ruleset", {
			owner: "o",
			repo: "r",
			ruleset_id: 1,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("404");
	});

	it("check_branch_rules defaults to the default branch and names each rule's ruleset", async () => {
		const calls = [];
		const { handlers } = setup({
			get: async () => ({ data: { default_branch: "trunk" }, headers: {} }),
			getBranchRules: async (params) => {
				calls.push(params);
				return {
					data: [
						{
							type: "deletion",
							ruleset_source_type: "Repository",
							ruleset_source: "o/r",
							ruleset_id: 77,
						},
						{
							type: "pull_request",
							parameters: { required_approving_review_count: 2 },
							ruleset_source_type: "Organization",
							ruleset_source: "o",
							ruleset_id: 9,
						},
					],
					headers: {},
				};
			},
		});

		const result = await invoke(handlers, "check_branch_rules", {
			owner: "o",
			repo: "r",
			per_page: 100,
		});
		const body = result.content[0].text;
		expect(calls[0]).toMatchObject({ owner: "o", repo: "r", branch: "trunk" });
		expect(body).toContain("# Rules for `trunk` in o/r (2)");
		expect(body).toContain("- `deletion` — ruleset `77` (o/r)");
		expect(body).toContain(
			'- `pull_request` {"required_approving_review_count":2} — ruleset `9` (o)',
		);
	});

	it("check_branch_rules uses an explicit branch without resolving the default", async () => {
		const calls = [];
		const { handlers } = setup({
			get: async () => {
				throw new Error("default branch must not be looked up");
			},
			getBranchRules: async (params) => {
				calls.push(params);
				return { data: [], headers: {} };
			},
		});

		const result = await invoke(handlers, "check_branch_rules", {
			owner: "o",
			repo: "r",
			branch: "feat/x",
			per_page: 100,
		});
		expect(calls[0].branch).toBe("feat/x");
		expect(result.content[0].text).toContain("(no active ruleset rules apply to `feat/x` in o/r;");
		expect(result.content[0].text).toContain("classic branch protection is not checked");
		expect(result.isError).toBeUndefined();
	});

	it("check_branch_rules surfaces an API error via wrapTool", async () => {
		const { handlers } = setup({
			getBranchRules: async () => {
				throw new Error("404 Not Found");
			},
		});
		const result = await invoke(handlers, "check_branch_rules", {
			owner: "o",
			repo: "r",
			branch: "x",
			per_page: 100,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("404");
	});

	it("registers only read tools, so none emits an audit line", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { handlers } = setup();
		await invoke(handlers, "list_repo_rulesets", { owner: "o", repo: "r" });
		await invoke(handlers, "get_repo_ruleset", { owner: "o", repo: "r", ruleset_id: 77 });
		await invoke(handlers, "check_branch_rules", { owner: "o", repo: "r", per_page: 100 });
		const audit = logSpy.mock.calls.filter(
			([line]) => typeof line === "string" && line.startsWith("[github-audit] "),
		);
		expect(audit).toEqual([]);
	});
});
