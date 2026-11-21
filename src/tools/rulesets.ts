import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveDefaultBranch } from "../github/helpers.js";
import { logRateLimit, restListHeader, text, truncate, wrapTool } from "../mcp/response.js";
import { stripUndefined } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";

type RulesetDetail = Awaited<
	ReturnType<ReturnType<OctokitFactory>["rest"]["repos"]["getRepoRuleset"]>
>["data"];

// Rule parameters are a per-rule-type object (status-check contexts, patterns,
// merge methods, ...). Render them verbatim as one JSON line rather than
// modelling each type, so a rule type GitHub adds later still shows up.
const ruleLine = (rule: { type: string; parameters?: unknown }): string =>
	rule.parameters == null
		? `\`${rule.type}\``
		: `\`${rule.type}\` ${JSON.stringify(rule.parameters)}`;

const patterns = (label: string, values: string[] | undefined): string =>
	`- ${label}: ${values != null && values.length > 0 ? values.map((v) => `\`${v}\``).join(", ") : "(none)"}`;

const renderRulesetDetail = (owner: string, repo: string, data: RulesetDetail): string => {
	const conditions = data.conditions;
	const refName = conditions != null && "ref_name" in conditions ? conditions.ref_name : undefined;
	const bypass = data.bypass_actors ?? [];
	const bypassCount =
		data.bypass_actors == null
			? "(not returned — GitHub omits it without admin access)"
			: bypass.length;
	const rules = data.rules ?? [];
	const summary = [
		`# Ruleset \`${data.id}\` in ${owner}/${repo}`,
		"",
		`> ${data.name}`,
		"",
		`- target: ${data.target ?? "(unknown)"}`,
		`- enforcement: ${data.enforcement}`,
		`- source: ${data.source}${data.source_type != null ? ` (${data.source_type})` : ""}`,
		patterns("ref include", refName?.include),
		patterns("ref exclude", refName?.exclude),
		`- bypass actors: ${bypassCount}`,
		`- rules: ${rules.length}`,
		...(data._links?.html?.href != null ? [`- ${data._links.html.href}`] : []),
	];
	const bypassSection =
		bypass.length > 0
			? [
					"",
					"## Bypass actors",
					"",
					...bypass.map(
						(a) =>
							`- ${a.actor_type}${a.actor_id != null ? ` \`${a.actor_id}\`` : ""}${a.bypass_mode != null ? ` — ${a.bypass_mode}` : ""}`,
					),
				]
			: [];
	const ruleSection =
		rules.length > 0 ? ["", "## Rules", "", ...rules.map((r) => `- ${ruleLine(r)}`)] : [];
	return truncate([...summary, ...bypassSection, ...ruleSection].join("\n"));
};

export const registerRulesetTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"list_repo_rulesets",
		{
			description:
				"List the rulesets that apply to a repository (one line per ruleset: ID, name, target, enforcement, source). Includes org-level rulesets inherited by the repo, marked by their source. Use when the user asks what rulesets exist or to find a `ruleset_id` for `get_repo_ruleset`. To see which rules apply to one branch, use `check_branch_rules`.",
			inputSchema: {
				...RepoTarget,
				per_page: z.number().int().min(1).max(100).optional().default(30),
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number (1-indexed). Defaults to 1."),
			},
		},
		async ({ owner, repo, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.getRepoRulesets(
					stripUndefined({ owner, repo, per_page, page }),
				);
				logRateLimit(headers);
				if (data.length === 0) {
					return text(
						page != null && page > 1 ? "(no rulesets on this page)" : "(no rulesets found)",
					);
				}
				const lines = data.map(
					(r) =>
						`- \`${r.id}\` **${r.name}** — ${r.target ?? "unknown target"}, ${r.enforcement}, source: ${r.source}${r.source_type != null ? ` (${r.source_type})` : ""}`,
				);
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: `Rulesets in ${owner}/${repo}`,
					count: data.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"get_repo_ruleset",
		{
			description:
				"Fetch one repository ruleset's detail — name, target, enforcement, source, ref include / exclude conditions, bypass actors, and every rule with its parameters. Use when the user asks what a specific ruleset enforces. Get `ruleset_id` from `list_repo_rulesets`.",
			inputSchema: {
				...RepoTarget,
				ruleset_id: z.number().int().positive().describe("Ruleset ID (from `list_repo_rulesets`)."),
			},
		},
		async ({ owner, repo, ruleset_id }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.getRepoRuleset({
					owner,
					repo,
					ruleset_id,
				});
				logRateLimit(headers);
				return text(renderRulesetDetail(owner, repo, data));
			}),
	);

	server.registerTool(
		"check_branch_rules",
		{
			description:
				"List the rules from active rulesets that apply to a branch (one line per rule: type, parameters, and the ID and source of the ruleset it comes from). Use when the user asks which ruleset rules a branch is under. Classic branch protection is not checked (see the `protected` flag in `list_branches`), and rulesets in evaluate or disabled mode are not listed. Defaults to the repo's default branch. The response carries no ruleset name; look it up with `get_repo_ruleset` using the ruleset ID.",
			inputSchema: {
				...RepoTarget,
				branch: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Short branch name such as `main`, not `refs/heads/main`. Defaults to the repository's default branch.",
					),
				per_page: z.number().int().min(1).max(100).optional().default(100),
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number (1-indexed). Defaults to 1."),
			},
		},
		async ({ owner, repo, branch, per_page, page }) =>
			wrapTool(async () => {
				const target = branch ?? (await resolveDefaultBranch(client(), owner, repo));
				const { data, headers } = await client().rest.repos.getBranchRules(
					stripUndefined({ owner, repo, branch: target, per_page, page }),
				);
				logRateLimit(headers);
				if (data.length === 0) {
					return text(
						page != null && page > 1
							? `(no rules on this page for \`${target}\` in ${owner}/${repo})`
							: `(no active ruleset rules apply to \`${target}\` in ${owner}/${repo}; classic branch protection is not checked and the branch's existence is not verified)`,
					);
				}
				const lines = data.map((r) => {
					const from =
						r.ruleset_id != null
							? ` — ruleset \`${r.ruleset_id}\`${r.ruleset_source != null ? ` (${r.ruleset_source})` : ""}`
							: "";
					return `- ${ruleLine(r)}${from}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: `Rules for \`${target}\` in ${owner}/${repo}`,
					count: data.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);
};
