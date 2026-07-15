import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	errorResult,
	logRateLimit,
	logWrite,
	previewLine,
	restListHeader,
	text,
	truncate,
	wrapTool,
} from "../mcp/response.js";
import { stripUndefined } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { MAX_TEXT_FIELD_LENGTH, maxCharsMessage, RepoTarget } from "./common.js";
import { searchHeader } from "./search-helpers.js";

const formatNameList = (names: string[], wrap: "code" | "at"): string => {
	if (names.length === 0) return "(none)";
	return names.map((n) => (wrap === "code" ? `\`${n}\`` : `@${n}`)).join(", ");
};

// --- GraphQL plumbing for the lifecycle tools (pin / unpin / transfer /
// delete / develop). These mutations have no REST equivalent (the REST pin
// endpoint is preview-only and returns 410), so each first resolves the
// issue's node ID, then mutates.

const ISSUE_NODE_ID_QUERY = `
	query ($owner: String!, $repo: String!, $issue_number: Int!) {
		repository(owner: $owner, name: $repo) {
			issue(number: $issue_number) { id }
		}
	}
`;

type IssueNodeIdResult = {
	repository: { issue: { id: string } | null } | null;
};

const issueNotFoundError = (owner: string, repo: string, issue_number: number) =>
	errorResult(
		`Issue ${owner}/${repo}#${issue_number} not found or not accessible (check the repo name, the issue number, and your token's permissions).`,
	);

const resolveIssueNodeId = async (
	octo: ReturnType<OctokitFactory>,
	owner: string,
	repo: string,
	issue_number: number,
): Promise<string | null> => {
	const result = await octo.graphql<IssueNodeIdResult>(ISSUE_NODE_ID_QUERY, {
		owner,
		repo,
		issue_number,
	});
	return result.repository?.issue?.id ?? null;
};

const PIN_ISSUE_MUTATION = `
	mutation ($issue_id: ID!) {
		pinIssue(input: { issueId: $issue_id }) {
			issue { url }
		}
	}
`;

const UNPIN_ISSUE_MUTATION = `
	mutation ($issue_id: ID!) {
		unpinIssue(input: { issueId: $issue_id }) {
			issue { url }
		}
	}
`;

type PinIssueResult = { pinIssue: { issue: { url: string } | null } | null };
type UnpinIssueResult = { unpinIssue: { issue: { url: string } | null } | null };

const TRANSFER_ISSUE_TARGETS_QUERY = `
	query ($owner: String!, $repo: String!, $issue_number: Int!, $new_owner: String!, $new_repo: String!) {
		source: repository(owner: $owner, name: $repo) {
			issue(number: $issue_number) { id }
		}
		destination: repository(owner: $new_owner, name: $new_repo) { id }
	}
`;

type TransferIssueTargetsResult = {
	source: { issue: { id: string } | null } | null;
	destination: { id: string } | null;
};

const TRANSFER_ISSUE_MUTATION = `
	mutation ($issue_id: ID!, $repository_id: ID!, $create_labels_if_missing: Boolean!) {
		transferIssue(
			input: {
				issueId: $issue_id
				repositoryId: $repository_id
				createLabelsIfMissing: $create_labels_if_missing
			}
		) {
			issue { number url }
		}
	}
`;

type TransferIssueResult = {
	transferIssue: { issue: { number: number; url: string } | null } | null;
};

const DELETE_ISSUE_MUTATION = `
	mutation ($issue_id: ID!) {
		deleteIssue(input: { issueId: $issue_id }) {
			repository { nameWithOwner }
		}
	}
`;

type DeleteIssueResult = {
	deleteIssue: { repository: { nameWithOwner: string } | null } | null;
};

// `createLinkedBranch` requires the OID the new branch starts from, so the
// resolution query also fetches the base: the default branch's head by
// default, or the caller-named `base_ref` when provided (separate query so an
// omitted base never sends an empty `qualifiedName`).
const DEVELOP_ISSUE_TARGETS_QUERY = `
	query ($owner: String!, $repo: String!, $issue_number: Int!) {
		repository(owner: $owner, name: $repo) {
			issue(number: $issue_number) { id }
			defaultBranchRef { target { oid } }
		}
	}
`;

const DEVELOP_ISSUE_TARGETS_WITH_BASE_QUERY = `
	query ($owner: String!, $repo: String!, $issue_number: Int!, $base_ref: String!) {
		repository(owner: $owner, name: $repo) {
			issue(number: $issue_number) { id }
			baseRef: ref(qualifiedName: $base_ref) { target { oid } }
		}
	}
`;

type DevelopIssueTargetsResult = {
	repository: {
		issue: { id: string } | null;
		defaultBranchRef?: { target: { oid: string } | null } | null;
		baseRef?: { target: { oid: string } | null } | null;
	} | null;
};

const CREATE_LINKED_BRANCH_MUTATION = `
	mutation ($issue_id: ID!, $oid: GitObjectID!, $name: String) {
		createLinkedBranch(input: { issueId: $issue_id, oid: $oid, name: $name }) {
			linkedBranch {
				ref {
					name
					repository { url }
				}
			}
		}
	}
`;

type CreateLinkedBranchResult = {
	createLinkedBranch: {
		linkedBranch: {
			ref: { name: string; repository: { url: string } } | null;
		} | null;
	} | null;
};

const LIST_LINKED_BRANCHES_QUERY = `
	query ($owner: String!, $repo: String!, $issue_number: Int!) {
		repository(owner: $owner, name: $repo) {
			issue(number: $issue_number) {
				linkedBranches(first: 20) {
					pageInfo { hasNextPage }
					nodes {
						ref {
							name
							repository { nameWithOwner }
						}
					}
				}
			}
		}
	}
`;

type ListLinkedBranchesResult = {
	repository: {
		issue: {
			linkedBranches: {
				pageInfo: { hasNextPage: boolean };
				nodes: Array<{
					ref: { name: string; repository: { nameWithOwner: string } } | null;
				} | null>;
			};
		} | null;
	} | null;
};

export const registerIssueTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"search_issues",
		{
			description:
				"Search issues and pull requests inside a specific repository. Use when the user asks to find issues/PRs matching a query, filter by state, or look up bugs/features in a repo. Returns title, number, state, author, and URL for each match.",
			inputSchema: {
				...RepoTarget,
				query: z
					.string()
					.describe(
						"Search keywords (GitHub search syntax). Repo qualifier is added automatically.",
					),
				state: z
					.enum(["open", "closed", "all"])
					.optional()
					.default("open")
					.describe("Issue/PR state filter."),
				per_page: z.number().int().min(1).max(50).optional().default(20),
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe(
						"Page number (1-indexed). Defaults to 1. GitHub caps search at 1000 reachable results.",
					),
			},
		},
		async ({ owner, repo, query, state, per_page, page }) =>
			wrapTool(async () => {
				const qualifier =
					state === "all" ? `repo:${owner}/${repo}` : `repo:${owner}/${repo} state:${state}`;
				const q = `${query} ${qualifier}`;
				const { data, headers } = await client().rest.search.issuesAndPullRequests({
					q,
					per_page,
					page,
				});
				logRateLimit(headers);
				if (data.total_count === 0)
					return text(`# Search results\n\nNo issues or PRs matched \`${q}\`.`);
				const lines = data.items.map((i) => {
					const kind = i.pull_request ? "PR" : "Issue";
					const author = i.user ? `@${i.user.login}` : "(unknown)";
					return `- [${kind} #${i.number}] **${i.title}** (${i.state}) by ${author}\n  - ${i.html_url}`;
				});
				const header = searchHeader({
					label: "Search results",
					query: q,
					page,
					perPage: per_page,
					totalCount: data.total_count,
					shownCount: data.items.length,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"get_issue",
		{
			description:
				"Fetch a single issue's details. Use when the user asks to read, view, or inspect an issue by number. Works for pull requests too (they share the issue endpoint); the output marks the entry as a PR when applicable. Returns title, state, author, labels, assignees, milestone, timestamps, URL, GraphQL node ID (usable as add_project_item's `content_id`), and a (possibly truncated) body.",
			inputSchema: {
				...RepoTarget,
				issue_number: z.number().int().positive().describe("Issue or PR number to fetch."),
			},
		},
		async ({ owner, repo, issue_number }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.get({
					owner,
					repo,
					issue_number,
				});
				logRateLimit(headers);
				const kind = data.pull_request ? "PR" : "Issue";
				const labelNames = data.labels
					.map((l) => (typeof l === "string" ? l : (l.name ?? "")))
					.filter((n) => n.length > 0);
				const assigneeLogins = (data.assignees ?? []).map((a) => a.login);
				const milestone = data.milestone ? data.milestone.title : "(none)";
				const author = data.user ? `@${data.user.login}` : "(unknown)";
				const body = data.body != null && data.body.length > 0 ? data.body : "(no body)";
				const lines = [
					`# ${kind} #${data.number}: ${data.title}`,
					"",
					`- state: **${data.state}**${data.state_reason != null ? ` (${data.state_reason})` : ""}`,
					`- author: ${author}`,
					`- labels: ${formatNameList(labelNames, "code")}`,
					`- assignees: ${formatNameList(assigneeLogins, "at")}`,
					`- milestone: ${milestone}`,
					`- created: ${data.created_at}`,
					`- updated: ${data.updated_at}`,
					`- url: ${data.html_url}`,
					`- node_id: \`${data.node_id}\``,
					"",
					"## Body",
					"",
					body,
				];
				return text(truncate(lines.join("\n")));
			}),
	);

	server.registerTool(
		"list_issue_comments",
		{
			description:
				"List conversation comments on an issue or pull request. Use when the user asks to read the discussion, comments, or replies on an issue/PR. Returns one bullet per comment with author, timestamp, numeric comment ID (the `comment_id` for update_issue_comment / delete_issue_comment), URL, and a short body preview.",
			inputSchema: {
				...RepoTarget,
				issue_number: z
					.number()
					.int()
					.positive()
					.describe("Issue or PR number whose comments to list."),
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
				since: z.iso
					.datetime()
					.optional()
					.describe("Only comments updated at or after this ISO 8601 timestamp."),
			},
		},
		async ({ owner, repo, issue_number, per_page, page, since }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.listComments({
					owner,
					repo,
					issue_number,
					per_page,
					page,
					since,
				});
				logRateLimit(headers);
				if (data.length === 0) return text(`# Comments on #${issue_number}\n\n(no comments found)`);
				// Each comment is rendered as a one-line preview (whitespace collapsed, 200-char cap);
				// the full-body rendering used by get_issue would blow up the list output. Callers
				// who need the full text should fetch the issue or the individual comment.
				const lines = data.map((c) => {
					const author = c.user ? `@${c.user.login}` : "(unknown)";
					const preview = previewLine(c.body);
					// Show `updated_at` — that's what `since` filters by; the created timestamp
					// is appended only when the comment has been edited.
					const ts =
						c.updated_at !== c.created_at
							? `${c.updated_at} (created ${c.created_at})`
							: c.created_at;
					return `- ${author} — ${ts} — id: \`${c.id}\` — ${c.html_url}\n  - ${preview.length > 0 ? preview : "(empty)"}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: `Comments on #${issue_number}`,
					count: data.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"list_labels",
		{
			description:
				"List labels defined in a repository. Use when the user wants to see what labels exist before assigning or filtering — companion read for `add_labels` / `update_issue`. Returns one bullet per label with name, colour, and description.",
			inputSchema: {
				...RepoTarget,
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
		async ({ owner, repo, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.listLabelsForRepo({
					owner,
					repo,
					per_page,
					page,
				});
				logRateLimit(headers);
				if (data.length === 0) return text(`# Labels in ${owner}/${repo}\n\n(no labels defined)`);
				const lines = data.map((l) => {
					const desc =
						l.description != null && l.description.length > 0 ? ` — ${l.description}` : "";
					return `- **${l.name}** (#${l.color})${desc}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: `Labels in ${owner}/${repo}`,
					count: data.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"create_issue",
		{
			description:
				"Create a new GitHub issue in the specified repository. Use when the user explicitly asks to file, open, or create an issue. Requires title; body, labels, and assignees are optional. Returns the created issue's number and URL.",
			inputSchema: {
				...RepoTarget,
				title: z.string().min(1).describe("Issue title."),
				body: z
					.string()
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Issue body", MAX_TEXT_FIELD_LENGTH))
					.optional()
					.describe("Issue body (Markdown supported)."),
				labels: z
					.array(z.string())
					.optional()
					.describe("Labels to attach (must already exist in the repo)."),
				assignees: z.array(z.string()).optional().describe("GitHub usernames to assign."),
			},
		},
		async ({ owner, repo, title, body, labels, assignees }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.create(
					stripUndefined({
						owner,
						repo,
						title,
						body,
						labels,
						assignees,
					}),
				);
				logRateLimit(headers);
				logWrite({ tool: "create_issue", owner, repo, issue_number: data.number });
				return text(`# Issue created\n\n- **${data.title}** (#${data.number})\n- ${data.html_url}`);
			}),
	);

	server.registerTool(
		"add_comment",
		{
			description:
				"Add a comment to an existing issue or pull request. Use when the user asks to comment on, reply to, or annotate an issue/PR. PRs accept comments via the same endpoint as issues. Returns the new comment's URL.",
			inputSchema: {
				...RepoTarget,
				issue_number: z.number().int().positive().describe("Issue or PR number to comment on."),
				body: z
					.string()
					.min(1)
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Comment body", MAX_TEXT_FIELD_LENGTH))
					.describe("Comment body (Markdown supported)."),
			},
		},
		async ({ owner, repo, issue_number, body }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.createComment({
					owner,
					repo,
					issue_number,
					body,
				});
				logRateLimit(headers);
				logWrite({ tool: "add_comment", owner, repo, issue_number });
				return text(`# Comment added\n\n- on #${issue_number}\n- ${data.html_url}`);
			}),
	);

	server.registerTool(
		"update_issue",
		{
			description:
				'Edit an existing issue\'s title, body, state, labels, assignees, or milestone in one call. Use when the user asks to edit, close, reopen, retitle, relabel, or reassign an issue. Pass `state: "closed"` with `state_reason` to close. Returns the issue number, new state, and URL.',
			inputSchema: {
				...RepoTarget,
				issue_number: z.number().int().positive().describe("Issue number to update."),
				title: z.string().min(1).optional().describe("New issue title."),
				body: z
					.string()
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Issue body", MAX_TEXT_FIELD_LENGTH))
					.optional()
					.describe(
						"New issue body (Markdown supported); omit to leave unchanged, pass an empty string to clear.",
					),
				state: z.enum(["open", "closed"]).optional().describe("New issue state."),
				state_reason: z
					.enum(["completed", "not_planned", "duplicate", "reopened"])
					.nullable()
					.optional()
					.describe(
						"Reason for the state change (used when closing or reopening); pass null to clear an existing reason.",
					),
				labels: z
					.array(z.string())
					.optional()
					.describe(
						"Replaces the entire label set; omit to leave unchanged, pass `[]` to clear all labels.",
					),
				assignees: z
					.array(z.string())
					.optional()
					.describe(
						"Replaces the entire assignee set; omit to leave unchanged, pass `[]` to clear all assignees.",
					),
				milestone: z
					.number()
					.int()
					.nullable()
					.optional()
					.describe("Milestone number to set; pass null to clear."),
			},
		},
		async ({
			owner,
			repo,
			issue_number,
			title,
			body,
			state,
			state_reason,
			labels,
			assignees,
			milestone,
		}) =>
			wrapTool(async () => {
				// `state_reason` / `milestone` rely on stripUndefined preserving an
				// explicit `null` (the "clear" signal) while dropping `undefined`.
				const { data, headers } = await client().rest.issues.update(
					stripUndefined({
						owner,
						repo,
						issue_number,
						title,
						body,
						state,
						state_reason,
						labels,
						assignees,
						milestone,
					}),
				);
				logRateLimit(headers);
				logWrite({ tool: "update_issue", owner, repo, issue_number });
				return text(
					`# Issue updated\n\n- **${data.title}** (#${data.number}) — state: **${data.state}**${data.state_reason != null ? ` (${data.state_reason})` : ""}\n- ${data.html_url}`,
				);
			}),
	);

	server.registerTool(
		"add_labels",
		{
			description:
				"Append labels to an issue or PR without restating the existing set. Use when the user asks to add, attach, or tag labels — and the existing labels should be preserved. Returns the full updated label list.",
			inputSchema: {
				...RepoTarget,
				issue_number: z.number().int().positive().describe("Issue or PR number to add labels to."),
				labels: z
					.array(z.string())
					.min(1)
					.describe("Label names to append (must already exist in the repo)."),
			},
		},
		async ({ owner, repo, issue_number, labels }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.addLabels({
					owner,
					repo,
					issue_number,
					labels,
				});
				logRateLimit(headers);
				logWrite({ tool: "add_labels", owner, repo, issue_number });
				const names = data.map((l) => l.name);
				return text(
					`# Labels added\n\n- on #${issue_number}\n- labels now: ${formatNameList(names, "code")}`,
				);
			}),
	);

	server.registerTool(
		"remove_label",
		{
			description:
				"Remove a single label from an issue or PR. Use when the user asks to remove, drop, or untag a specific label. Returns the remaining label set.",
			inputSchema: {
				...RepoTarget,
				issue_number: z
					.number()
					.int()
					.positive()
					.describe("Issue or PR number to remove the label from."),
				name: z.string().min(1).describe("Label name to remove."),
			},
		},
		async ({ owner, repo, issue_number, name }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.removeLabel({
					owner,
					repo,
					issue_number,
					name,
				});
				logRateLimit(headers);
				logWrite({ tool: "remove_label", owner, repo, issue_number });
				const names = data.map((l) => l.name);
				return text(
					`# Label removed\n\n- removed \`${name}\` from #${issue_number}\n- labels now: ${formatNameList(names, "code")}`,
				);
			}),
	);

	server.registerTool(
		"add_assignees",
		{
			description:
				"Append assignees to an issue or PR without restating the existing set. Use when the user asks to add or assign people — and existing assignees should be preserved. For requesting PR reviewers, use `request_pr_review` instead. Returns the full updated assignee list.",
			inputSchema: {
				...RepoTarget,
				issue_number: z
					.number()
					.int()
					.positive()
					.describe("Issue or PR number to add assignees to."),
				assignees: z.array(z.string()).min(1).describe("GitHub usernames to assign."),
			},
		},
		async ({ owner, repo, issue_number, assignees }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.addAssignees({
					owner,
					repo,
					issue_number,
					assignees,
				});
				logRateLimit(headers);
				logWrite({ tool: "add_assignees", owner, repo, issue_number });
				const logins = (data.assignees ?? []).map((a) => a.login);
				return text(
					`# Assignees added\n\n- on #${issue_number}\n- assignees now: ${formatNameList(logins, "at")}`,
				);
			}),
	);

	server.registerTool(
		"remove_assignees",
		{
			description:
				"Remove specific assignees from an issue or PR. Use when the user asks to unassign, drop, or detach assignees. Returns the remaining assignee set.",
			inputSchema: {
				...RepoTarget,
				issue_number: z
					.number()
					.int()
					.positive()
					.describe("Issue or PR number to remove assignees from."),
				assignees: z.array(z.string()).min(1).describe("GitHub usernames to remove."),
			},
		},
		async ({ owner, repo, issue_number, assignees }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.removeAssignees({
					owner,
					repo,
					issue_number,
					assignees,
				});
				logRateLimit(headers);
				logWrite({ tool: "remove_assignees", owner, repo, issue_number });
				const logins = (data.assignees ?? []).map((a) => a.login);
				return text(
					`# Assignees removed\n\n- from #${issue_number}\n- assignees now: ${formatNameList(logins, "at")}`,
				);
			}),
	);

	server.registerTool(
		"pin_issue",
		{
			description:
				"Pin an issue to the top of the repository's issue list (GitHub allows at most three pinned issues per repo). Use when the user asks to pin, feature, or highlight an issue. Returns a confirmation with the issue's URL. Backed by GraphQL — the REST pin endpoint is preview-only.",
			inputSchema: {
				...RepoTarget,
				issue_number: z.number().int().positive().describe("Issue number to pin."),
			},
		},
		async ({ owner, repo, issue_number }) =>
			wrapTool(async () => {
				const octo = client();
				const issueId = await resolveIssueNodeId(octo, owner, repo, issue_number);
				if (issueId == null) return issueNotFoundError(owner, repo, issue_number);
				const result = await octo.graphql<PinIssueResult>(PIN_ISSUE_MUTATION, {
					issue_id: issueId,
				});
				const issue = result.pinIssue?.issue;
				if (issue == null) return errorResult(`Failed to pin ${owner}/${repo}#${issue_number}.`);
				logWrite({ tool: "pin_issue", owner, repo, issue_number });
				return text(
					`# Issue pinned\n\n- #${issue_number} pinned in ${owner}/${repo}\n- ${issue.url}`,
				);
			}),
	);

	server.registerTool(
		"unpin_issue",
		{
			description:
				"Unpin a currently pinned issue from the top of the repository's issue list. Use when the user asks to unpin or remove an issue from the pinned section. Returns a confirmation with the issue's URL.",
			inputSchema: {
				...RepoTarget,
				issue_number: z.number().int().positive().describe("Issue number to unpin."),
			},
		},
		async ({ owner, repo, issue_number }) =>
			wrapTool(async () => {
				const octo = client();
				const issueId = await resolveIssueNodeId(octo, owner, repo, issue_number);
				if (issueId == null) return issueNotFoundError(owner, repo, issue_number);
				const result = await octo.graphql<UnpinIssueResult>(UNPIN_ISSUE_MUTATION, {
					issue_id: issueId,
				});
				const issue = result.unpinIssue?.issue;
				if (issue == null) return errorResult(`Failed to unpin ${owner}/${repo}#${issue_number}.`);
				logWrite({ tool: "unpin_issue", owner, repo, issue_number });
				return text(
					`# Issue unpinned\n\n- #${issue_number} unpinned in ${owner}/${repo}\n- ${issue.url}`,
				);
			}),
	);

	server.registerTool(
		"lock_issue",
		{
			description:
				"Lock an issue or pull request's conversation so only collaborators can comment (PRs share the same endpoint). Use when the user asks to lock, freeze, or restrict a discussion — optionally with a reason shown on the timeline. Returns a confirmation.",
			inputSchema: {
				...RepoTarget,
				issue_number: z.number().int().positive().describe("Issue or PR number to lock."),
				lock_reason: z
					.enum(["off-topic", "too heated", "resolved", "spam"])
					.optional()
					.describe("Reason for locking, shown on the issue timeline; omit for no reason."),
			},
		},
		async ({ owner, repo, issue_number, lock_reason }) =>
			wrapTool(async () => {
				const { headers } = await client().rest.issues.lock(
					stripUndefined({ owner, repo, issue_number, lock_reason }),
				);
				logRateLimit(headers);
				logWrite(stripUndefined({ tool: "lock_issue", owner, repo, issue_number, lock_reason }));
				return text(
					`# Conversation locked\n\n- ${owner}/${repo}#${issue_number} locked${lock_reason != null ? ` (${lock_reason})` : ""}`,
				);
			}),
	);

	server.registerTool(
		"unlock_issue",
		{
			description:
				"Unlock a previously locked issue or pull request conversation so anyone can comment again (PRs share the same endpoint). Use when the user asks to unlock or reopen a discussion. Returns a confirmation.",
			inputSchema: {
				...RepoTarget,
				issue_number: z.number().int().positive().describe("Issue or PR number to unlock."),
			},
		},
		async ({ owner, repo, issue_number }) =>
			wrapTool(async () => {
				const { headers } = await client().rest.issues.unlock({ owner, repo, issue_number });
				logRateLimit(headers);
				logWrite({ tool: "unlock_issue", owner, repo, issue_number });
				return text(`# Conversation unlocked\n\n- ${owner}/${repo}#${issue_number} unlocked`);
			}),
	);

	server.registerTool(
		"transfer_issue",
		{
			description:
				"Transfer an issue to another repository owned by the same user or organization. Moves the issue permanently — GitHub preserves comments, assignees, and reactions across the transfer, and the source issue redirects to the new one; labels not present in the destination are dropped unless `create_labels_if_missing` is set. Use only when the user explicitly asks to transfer/move an issue. Returns the issue's new number and URL in the destination repo.",
			inputSchema: {
				...RepoTarget,
				issue_number: z.number().int().positive().describe("Issue number to transfer."),
				new_repository_owner: z
					.string()
					.min(1)
					.describe("Owner of the destination repository (must match the source issue's owner)."),
				new_repository_name: z.string().min(1).describe("Name of the destination repository."),
				create_labels_if_missing: z
					.boolean()
					.optional()
					.describe(
						"Create the issue's labels in the destination repo when they don't exist there. Defaults to false (missing labels are dropped).",
					),
			},
		},
		async ({
			owner,
			repo,
			issue_number,
			new_repository_owner,
			new_repository_name,
			create_labels_if_missing,
		}) =>
			wrapTool(async () => {
				const octo = client();
				const targets = await octo.graphql<TransferIssueTargetsResult>(
					TRANSFER_ISSUE_TARGETS_QUERY,
					{
						owner,
						repo,
						issue_number,
						new_owner: new_repository_owner,
						new_repo: new_repository_name,
					},
				);
				const issueId = targets.source?.issue?.id;
				if (issueId == null) return issueNotFoundError(owner, repo, issue_number);
				const repositoryId = targets.destination?.id;
				if (repositoryId == null)
					return errorResult(
						`Destination repository ${new_repository_owner}/${new_repository_name} not found or not accessible.`,
					);
				const result = await octo.graphql<TransferIssueResult>(TRANSFER_ISSUE_MUTATION, {
					issue_id: issueId,
					repository_id: repositoryId,
					create_labels_if_missing: create_labels_if_missing ?? false,
				});
				const moved = result.transferIssue?.issue;
				if (moved == null)
					return errorResult(
						`Failed to transfer ${owner}/${repo}#${issue_number} to ${new_repository_owner}/${new_repository_name}.`,
					);
				logWrite({
					tool: "transfer_issue",
					owner,
					repo,
					issue_number,
					new_repository_owner,
					new_repository_name,
				});
				return text(
					`# Issue transferred\n\n- ${owner}/${repo}#${issue_number} → ${new_repository_owner}/${new_repository_name}#${moved.number}\n- ${moved.url}`,
				);
			}),
	);

	server.registerTool(
		"delete_issue",
		{
			description:
				"Permanently delete an issue. **Destructive and irrevocable** — the issue is permanently removed with no restoration window; comments, reactions, and cross-references are lost. Requires admin rights on the repo. Use only when the user explicitly asks to delete an issue. Returns a confirmation.",
			inputSchema: {
				...RepoTarget,
				issue_number: z.number().int().positive().describe("Issue number to delete."),
			},
		},
		async ({ owner, repo, issue_number }) =>
			wrapTool(async () => {
				const octo = client();
				const issueId = await resolveIssueNodeId(octo, owner, repo, issue_number);
				if (issueId == null) return issueNotFoundError(owner, repo, issue_number);
				const result = await octo.graphql<DeleteIssueResult>(DELETE_ISSUE_MUTATION, {
					issue_id: issueId,
				});
				const repoName = result.deleteIssue?.repository?.nameWithOwner;
				if (repoName == null)
					return errorResult(`Failed to delete ${owner}/${repo}#${issue_number}.`);
				logWrite({ tool: "delete_issue", owner, repo, issue_number });
				return text(`# Issue deleted\n\n- #${issue_number} permanently deleted from ${repoName}`);
			}),
	);

	server.registerTool(
		"develop_issue",
		{
			description:
				"Create a branch linked to an issue (the 'Create a branch' development link in the GitHub UI). Use when the user asks to start development on an issue with a linked branch. Branches from the default branch's head unless `base_ref` names another base; GitHub derives a branch name from the issue when `branch_name` is omitted. Returns the new branch's name and URL.",
			inputSchema: {
				...RepoTarget,
				issue_number: z.number().int().positive().describe("Issue number to link the branch to."),
				branch_name: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Name for the new branch; omit to let GitHub derive one from the issue number and title.",
					),
				base_ref: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Branch (or qualified ref) to branch from, e.g. "develop". Defaults to the repository\'s default branch.',
					),
			},
		},
		async ({ owner, repo, issue_number, branch_name, base_ref }) =>
			wrapTool(async () => {
				const octo = client();
				const targets = await octo.graphql<DevelopIssueTargetsResult>(
					base_ref != null ? DEVELOP_ISSUE_TARGETS_WITH_BASE_QUERY : DEVELOP_ISSUE_TARGETS_QUERY,
					stripUndefined({ owner, repo, issue_number, base_ref }),
				);
				const issueId = targets.repository?.issue?.id;
				if (issueId == null) return issueNotFoundError(owner, repo, issue_number);
				const oid =
					base_ref != null
						? targets.repository?.baseRef?.target?.oid
						: targets.repository?.defaultBranchRef?.target?.oid;
				if (oid == null)
					return errorResult(
						base_ref != null
							? `Base ref \`${base_ref}\` not found in ${owner}/${repo}.`
							: `Could not resolve the default branch head of ${owner}/${repo}.`,
					);
				const result = await octo.graphql<CreateLinkedBranchResult>(
					CREATE_LINKED_BRANCH_MUTATION,
					stripUndefined({ issue_id: issueId, oid, name: branch_name }),
				);
				const ref = result.createLinkedBranch?.linkedBranch?.ref;
				if (ref == null)
					return errorResult(
						`Failed to create a linked branch for ${owner}/${repo}#${issue_number}.`,
					);
				logWrite({
					tool: "develop_issue",
					owner,
					repo,
					issue_number,
					branch_name: ref.name,
				});
				return text(
					`# Linked branch created\n\n- for issue #${issue_number}\n- branch: \`${ref.name}\`\n- ${ref.repository.url}/tree/${encodeURIComponent(ref.name)}`,
				);
			}),
	);

	server.registerTool(
		"list_linked_branches",
		{
			description:
				"List the branches linked to an issue via the development sidebar (created by develop_issue or the GitHub UI). Use when the user asks which branches are attached to an issue. Returns one bullet per linked branch with its name and repository.",
			inputSchema: {
				...RepoTarget,
				issue_number: z
					.number()
					.int()
					.positive()
					.describe("Issue number whose linked branches to list."),
			},
		},
		async ({ owner, repo, issue_number }) =>
			wrapTool(async () => {
				const result = await client().graphql<ListLinkedBranchesResult>(
					LIST_LINKED_BRANCHES_QUERY,
					{ owner, repo, issue_number },
				);
				if (result.repository?.issue == null) return issueNotFoundError(owner, repo, issue_number);
				const linkedBranches = result.repository.issue.linkedBranches;
				const branches = linkedBranches.nodes
					.map((n) => n?.ref)
					.filter((r): r is NonNullable<typeof r> => r != null);
				if (branches.length === 0)
					return text(`# Linked branches on #${issue_number}\n\n(no linked branches)`);
				const lines = branches.map((r) => `- \`${r.name}\` in ${r.repository.nameWithOwner}`);
				const truncatedHint = linkedBranches.pageInfo.hasNextPage
					? "\n\n_more linked branches exist beyond the first 20; not currently paginated._"
					: "";
				return text(
					truncate(
						`# Linked branches on #${issue_number} (${branches.length})\n\n${lines.join("\n")}${truncatedHint}`,
					),
				);
			}),
	);

	server.registerTool(
		"update_issue_comment",
		{
			description:
				"Edit the body of an existing conversation comment on an issue or pull request. Use when the user asks to edit, correct, or rewrite a comment they can identify by ID (discover via list_issue_comments). Replaces the whole body; returns the comment's URL.",
			inputSchema: {
				...RepoTarget,
				comment_id: z
					.number()
					.int()
					.positive()
					.describe(
						"Numeric ID of the conversation comment to edit. Discover via list_issue_comments (the `id` field).",
					),
				body: z
					.string()
					.min(1)
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Comment body", MAX_TEXT_FIELD_LENGTH))
					.describe("New comment body (Markdown supported); replaces the existing body entirely."),
			},
		},
		async ({ owner, repo, comment_id, body }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.updateComment({
					owner,
					repo,
					comment_id,
					body,
				});
				logRateLimit(headers);
				logWrite({ tool: "update_issue_comment", owner, repo, comment_id });
				return text(`# Comment updated\n\n- comment \`${comment_id}\`\n- ${data.html_url}`);
			}),
	);

	server.registerTool(
		"delete_issue_comment",
		{
			description:
				"Permanently delete a conversation comment from an issue or pull request. Destructive — the comment cannot be restored. Use only when the user explicitly asks to delete a comment they can identify by ID (discover via list_issue_comments). Returns a confirmation.",
			inputSchema: {
				...RepoTarget,
				comment_id: z
					.number()
					.int()
					.positive()
					.describe(
						"Numeric ID of the conversation comment to delete. Discover via list_issue_comments (the `id` field).",
					),
			},
		},
		async ({ owner, repo, comment_id }) =>
			wrapTool(async () => {
				const { headers } = await client().rest.issues.deleteComment({
					owner,
					repo,
					comment_id,
				});
				logRateLimit(headers);
				logWrite({ tool: "delete_issue_comment", owner, repo, comment_id });
				return text(
					`# Comment deleted\n\n- comment \`${comment_id}\` deleted from ${owner}/${repo}`,
				);
			}),
	);
};
