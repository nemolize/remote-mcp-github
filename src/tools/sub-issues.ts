import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	errorResult,
	logRateLimit,
	logWrite,
	restListHeader,
	text,
	type ToolResult,
	truncate,
	wrapTool,
} from "../mcp/response.js";
import { isHttpStatus } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";

const IssueNumber = z.number().int().positive();

const repoSlug = (repositoryUrl: string | undefined): string | null =>
	repositoryUrl?.match(/\/repos\/([^/]+\/[^/]+)$/)?.[1] ?? null;

type FetchedIssue = { id: number; slug: string | null } | { error: ToolResult };

const sameRepo = (a: string | null, b: string | null): boolean =>
	a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

const fetchIssue = async (
	octo: ReturnType<OctokitFactory>,
	owner: string,
	repo: string,
	issue_number: number,
): Promise<FetchedIssue> => {
	const where = `${owner}/${repo}#${issue_number}`;
	let data;
	try {
		({ data } = await octo.rest.issues.get({ owner, repo, issue_number }));
	} catch (e) {
		if (isHttpStatus(e, 404)) {
			return {
				error: errorResult(
					`Issue ${where} not found or not accessible (check the repo name, the issue number, and your token's permissions).`,
				),
			};
		}
		throw e;
	}
	if (data.pull_request != null) {
		return { error: errorResult(`${where} is a pull request; sub-issues apply to issues only.`) };
	}
	return { id: data.id, slug: repoSlug(data.repository_url) };
};

// The endpoints take database ids, not numbers. Comparing the canonical repositories of
// parent and child (not the caller's spelling) keeps renamed or transferred repos correct.
const resolveSubIssueId = async (
	octo: ReturnType<OctokitFactory>,
	owner: string,
	repo: string,
	parent: number,
	child: number,
): Promise<{ id: number } | { error: ToolResult }> => {
	const p = await fetchIssue(octo, owner, repo, parent);
	if ("error" in p) return p;
	const c = await fetchIssue(octo, owner, repo, child);
	if ("error" in c) return c;
	if (!sameRepo(c.slug, p.slug)) {
		return {
			error: errorResult(
				`${owner}/${repo}#${child} is not in the same repository as #${parent}; sub-issue changes are limited to issues in the parent's repository.`,
			),
		};
	}
	return { id: c.id };
};

export const registerSubIssueTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"list_sub_issues",
		{
			description:
				"List the sub-issues of a parent issue, in their priority order. Use when the user asks for an issue's sub-issues, children, or task breakdown. Returns one bullet per sub-issue as `owner/repo#number` with title and state; sub-issues from another repository are marked read-only because the add / remove / reprioritize tools only change same-repository sub-issues.",
			inputSchema: {
				...RepoTarget,
				issue_number: IssueNumber.describe("Parent issue number."),
				per_page: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.default(30)
					.describe("Results per page (1-100)."),
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number (1-indexed). Defaults to 1."),
			},
		},
		async ({ owner, repo, issue_number, per_page, page }) =>
			wrapTool(async () => {
				const octo = client();
				const parent = await fetchIssue(octo, owner, repo, issue_number);
				if ("error" in parent) return parent.error;
				const { data, headers } = await octo.rest.issues.listSubIssues({
					owner,
					repo,
					issue_number,
					per_page,
					...(page === undefined ? {} : { page }),
				});
				logRateLimit(headers);
				const title = `Sub-issues of #${issue_number}`;
				if (data.length === 0) {
					return text(
						`# ${title}\n\n(no sub-issues on ${page === undefined || page === 1 ? "this issue" : "this page"})`,
					);
				}
				const lines = data.map((s) => {
					const slug = repoSlug(s.repository_url);
					const foreign = sameRepo(slug, parent.slug) ? "" : " — other repository, read-only here";
					return `- [${slug ?? "?"}#${s.number}](${s.html_url}) **${s.title}** (${s.state})${foreign}`;
				});
				const header = restListHeader({
					title,
					count: data.length,
					page,
					hasMore: (headers.link ?? "").includes('rel="next"'),
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"add_sub_issue",
		{
			description:
				"Attach an existing issue as a sub-issue of a parent issue in the same repository. Use when the user asks to make an issue a child of another, or to break an issue down. The child is identified by issue number; pull requests cannot be sub-issues. An issue that already has another parent is rejected by GitHub unless `replace_parent` is true. Returns a confirmation.",
			inputSchema: {
				...RepoTarget,
				issue_number: IssueNumber.describe("Parent issue number."),
				sub_issue_number: IssueNumber.describe(
					"Number of the existing issue (same repository) to attach as a sub-issue.",
				),
				replace_parent: z
					.boolean()
					.optional()
					.describe(
						"Move the issue under this parent when it already has a different parent. Omit to let GitHub reject that case.",
					),
			},
		},
		async ({ owner, repo, issue_number, sub_issue_number, replace_parent }) =>
			wrapTool(async () => {
				const octo = client();
				const child = await resolveSubIssueId(octo, owner, repo, issue_number, sub_issue_number);
				if ("error" in child) return child.error;
				const { headers } = await octo.rest.issues.addSubIssue({
					owner,
					repo,
					issue_number,
					sub_issue_id: child.id,
					...(replace_parent === undefined ? {} : { replace_parent }),
				});
				logRateLimit(headers);
				logWrite({ tool: "add_sub_issue", owner, repo, issue_number, sub_issue_number });
				return text(
					`# Sub-issue added\n\n- #${sub_issue_number} is now a sub-issue of #${issue_number} in ${owner}/${repo}`,
				);
			}),
	);

	server.registerTool(
		"remove_sub_issue",
		{
			description:
				"Detach a sub-issue from its parent issue; the issue itself is kept. Use when the user asks to remove, unlink, or detach a child issue. The child is identified by issue number in the same repository. Returns a confirmation.",
			inputSchema: {
				...RepoTarget,
				issue_number: IssueNumber.describe("Parent issue number."),
				sub_issue_number: IssueNumber.describe(
					"Number of the sub-issue (same repository) to detach.",
				),
			},
		},
		async ({ owner, repo, issue_number, sub_issue_number }) =>
			wrapTool(async () => {
				const octo = client();
				const child = await resolveSubIssueId(octo, owner, repo, issue_number, sub_issue_number);
				if ("error" in child) return child.error;
				const { headers } = await octo.rest.issues.removeSubIssue({
					owner,
					repo,
					issue_number,
					sub_issue_id: child.id,
				});
				logRateLimit(headers);
				logWrite({ tool: "remove_sub_issue", owner, repo, issue_number, sub_issue_number });
				return text(
					`# Sub-issue removed\n\n- #${sub_issue_number} is no longer a sub-issue of #${issue_number} in ${owner}/${repo}`,
				);
			}),
	);

	server.registerTool(
		"reprioritize_sub_issue",
		{
			description:
				"Move a sub-issue within its parent's ordered list. Use when the user asks to reorder, prioritize, or move a child issue up or down. Give exactly one of `after_sub_issue_number` or `before_sub_issue_number` (another sub-issue of the same parent); passing both or neither is rejected. Issues are identified by number in the same repository. Returns a confirmation.",
			inputSchema: z
				.object({
					...RepoTarget,
					issue_number: IssueNumber.describe("Parent issue number."),
					sub_issue_number: IssueNumber.describe("Number of the sub-issue to move."),
					after_sub_issue_number: IssueNumber.optional().describe(
						"Place the moved sub-issue right after this sub-issue. Exactly one of after / before.",
					),
					before_sub_issue_number: IssueNumber.optional().describe(
						"Place the moved sub-issue right before this sub-issue. Exactly one of after / before.",
					),
				})
				.refine(
					(v) =>
						(v.after_sub_issue_number === undefined) !== (v.before_sub_issue_number === undefined),
					{
						message: "Provide exactly one of after_sub_issue_number or before_sub_issue_number.",
					},
				),
		},
		async ({
			owner,
			repo,
			issue_number,
			sub_issue_number,
			after_sub_issue_number,
			before_sub_issue_number,
		}) =>
			wrapTool(async () => {
				const anchorNumber = after_sub_issue_number ?? before_sub_issue_number;
				if (
					anchorNumber === undefined ||
					(after_sub_issue_number !== undefined) === (before_sub_issue_number !== undefined)
				) {
					return errorResult(
						"Provide exactly one of after_sub_issue_number or before_sub_issue_number.",
					);
				}
				if (anchorNumber === sub_issue_number) {
					return errorResult("A sub-issue cannot be positioned relative to itself.");
				}
				const octo = client();
				const child = await resolveSubIssueId(octo, owner, repo, issue_number, sub_issue_number);
				if ("error" in child) return child.error;
				const anchor = await resolveSubIssueId(octo, owner, repo, issue_number, anchorNumber);
				if ("error" in anchor) return anchor.error;
				const { headers } = await octo.rest.issues.reprioritizeSubIssue({
					owner,
					repo,
					issue_number,
					sub_issue_id: child.id,
					...(after_sub_issue_number === undefined
						? { before_id: anchor.id }
						: { after_id: anchor.id }),
				});
				logRateLimit(headers);
				logWrite({ tool: "reprioritize_sub_issue", owner, repo, issue_number, sub_issue_number });
				const place = after_sub_issue_number === undefined ? "before" : "after";
				return text(
					`# Sub-issue reprioritized\n\n- #${sub_issue_number} moved ${place} #${anchorNumber} in the sub-issues of #${issue_number} (${owner}/${repo})`,
				);
			}),
	);
};
