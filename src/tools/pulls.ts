import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveDefaultBranch } from "../github/helpers.js";
import {
	errorResult,
	logRateLimit,
	logWrite,
	MAX_RESPONSE_CHARS,
	text,
	truncate,
	wrapTool,
} from "../mcp/response.js";
import { stripUndefined } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import {
	CrossRepoHeadPattern,
	MAX_TEXT_FIELD_LENGTH,
	maxCharsMessage,
	RepoTarget,
	SameRepoBranchPattern,
} from "./common.js";

/**
 * Trim a one-line comment preview to a fixed width with a plain ellipsis. The
 * shared `truncate()` is for the whole tool response (it appends a "paginate to
 * see more" hint that is nonsensical for an inline snippet), so the snippet uses
 * a simple slice instead.
 */
const SNIPPET_MAX = 120;
const snippetOf = (line: string): string =>
	line.length <= SNIPPET_MAX ? line : `${line.slice(0, SNIPPET_MAX)}…`;

export const registerPullTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"get_pr_diff",
		{
			description:
				"Fetch the unified diff of a pull request. Use when the user asks to review, summarise, or inspect the changes in a specific PR. Returns the diff as a fenced code block (truncated for very large PRs).",
			inputSchema: {
				...RepoTarget,
				pull_number: z.number().int().positive().describe("Pull request number."),
			},
		},
		async ({ owner, repo, pull_number }) =>
			wrapTool(async () => {
				const response = await client().rest.pulls.get({
					owner,
					repo,
					pull_number,
					mediaType: { format: "diff" },
				});
				logRateLimit(response.headers);
				// `mediaType: { format: "diff" }` makes Octokit return the raw diff text,
				// but the generated TS types still claim a structured PR object.
				const raw: unknown = response.data;
				if (typeof raw !== "string") {
					return errorResult("Expected raw diff response from GitHub.");
				}
				const diff = raw;
				return text(
					truncate(`# Diff for ${owner}/${repo}#${pull_number}\n\n\`\`\`diff\n${diff}\n\`\`\``),
				);
			}),
	);

	server.registerTool(
		"create_pull_request",
		{
			description:
				"Open a new pull request in a repository. Use when the user asks to open, file, or create a PR. `head` is a branch in the target repo by default; for cross-repo (fork) PRs, set `cross_repo_head: 'owner:branch'` instead. `base` defaults to the repo's default branch.",
			inputSchema: {
				...RepoTarget,
				title: z.string().min(1).describe("Pull request title."),
				head: z
					.string()
					.min(1)
					.regex(
						SameRepoBranchPattern,
						"Use cross_repo_head for 'owner:branch' form (cross-repo PRs).",
					)
					.optional()
					.describe(
						"Branch in the target repo containing your changes. Required unless cross_repo_head is set.",
					),
				cross_repo_head: z
					.string()
					.min(1)
					.regex(CrossRepoHeadPattern, "Cross-repo head must be of form 'owner:branch'.")
					.optional()
					.describe(
						"For cross-repo (fork) PRs only. Format: 'owner:branch'. Mutually exclusive with `head`.",
					),
				base: z
					.string()
					.optional()
					.describe("Branch to merge into. Defaults to the repo's default branch."),
				body: z
					.string()
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("PR description", MAX_TEXT_FIELD_LENGTH))
					.optional()
					.describe("PR description (Markdown supported)."),
				draft: z.boolean().optional().describe("Create as a draft PR."),
				maintainer_can_modify: z
					.boolean()
					.optional()
					.describe("Allow maintainers to edit the PR branch (cross-repo PRs)."),
			},
		},
		async ({
			owner,
			repo,
			title,
			head,
			cross_repo_head,
			base,
			body,
			draft,
			maintainer_can_modify,
		}) =>
			wrapTool(async () => {
				const effectiveHead = cross_repo_head ?? head;
				if (effectiveHead == null) {
					return errorResult(
						"Provide either `head` (same-repo branch) or `cross_repo_head` ('owner:branch' for fork PRs).",
					);
				}
				if (head != null && cross_repo_head != null) {
					return errorResult(
						"`head` and `cross_repo_head` are mutually exclusive; pass exactly one.",
					);
				}
				const octo = client();
				const target = base ?? (await resolveDefaultBranch(octo, owner, repo));
				const { data, headers } = await octo.rest.pulls.create(
					stripUndefined({
						owner,
						repo,
						title,
						head: effectiveHead,
						base: target,
						body,
						draft,
						maintainer_can_modify,
					}),
				);
				logRateLimit(headers);
				logWrite({ tool: "create_pull_request", owner, repo, pull_number: data.number });
				const flag = data.draft === true ? " (draft)" : "";
				return text(
					`# Pull request opened${flag}\n\n- **${data.title}** (#${data.number}) — \`${effectiveHead}\` → \`${target}\`\n- ${data.html_url}`,
				);
			}),
	);

	server.registerTool(
		"request_pr_review",
		{
			description:
				"Request reviewers (users and/or teams) on an existing pull request. Use when the user asks to assign, request, or add reviewers to a PR. At least one of `reviewers` or `team_reviewers` must be non-empty. Returns the PR URL and the list of requested reviewers.",
			inputSchema: {
				...RepoTarget,
				pull_number: z.number().int().positive().describe("Pull request number."),
				reviewers: z
					.array(z.string())
					.optional()
					.describe(
						"GitHub usernames to request review from. At least one of `reviewers` or `team_reviewers` must be non-empty.",
					),
				team_reviewers: z
					.array(z.string())
					.optional()
					.describe(
						"Team slugs (within the repo's org) to request review from. At least one of `reviewers` or `team_reviewers` must be non-empty.",
					),
			},
		},
		async ({ owner, repo, pull_number, reviewers, team_reviewers }) =>
			wrapTool(async () => {
				const reviewerCount = (reviewers?.length ?? 0) + (team_reviewers?.length ?? 0);
				if (reviewerCount === 0) {
					return errorResult("At least one of `reviewers` or `team_reviewers` must be non-empty.");
				}
				const octo = client();
				const { data, headers } = await octo.rest.pulls.requestReviewers(
					stripUndefined({
						owner,
						repo,
						pull_number,
						reviewers,
						team_reviewers,
					}),
				);
				logRateLimit(headers);
				logWrite({ tool: "request_pr_review", owner, repo, pull_number });
				const users = (data.requested_reviewers ?? []).map((u) => `@${u.login}`);
				const teams = (data.requested_teams ?? []).map((t) => `@${owner}/${t.slug}`);
				const requested = [...users, ...teams];
				const list = requested.length > 0 ? requested.join(", ") : "(none)";
				return text(
					`# Reviewers requested\n\n- PR: #${pull_number} — ${data.html_url}\n- requested: ${list}`,
				);
			}),
	);

	server.registerTool(
		"get_pull_request",
		{
			description:
				"Fetch a single pull request's full detail. Use when the user asks to read, inspect, or check the status of a PR — including whether it is mergeable, draft, or already merged. Returns state, mergeable state, head/base branches and SHAs, requested reviewers, commit/diff counts, timestamps, URL, and a (possibly truncated) body. Richer than the issue endpoint, which omits PR-specific fields.",
			inputSchema: {
				...RepoTarget,
				pull_number: z.number().int().positive().describe("Pull request number."),
			},
		},
		async ({ owner, repo, pull_number }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.pulls.get({
					owner,
					repo,
					pull_number,
				});
				logRateLimit(headers);
				const state = data.merged === true ? "merged" : data.state;
				// `pulls.get` types `user` as non-nullable, unlike the issue endpoint.
				const author = `@${data.user.login}`;
				const requestedUsers = (data.requested_reviewers ?? []).map((u) => `@${u.login}`);
				const requestedTeams = (data.requested_teams ?? []).map((t) => `@${owner}/${t.slug}`);
				const reviewers = [...requestedUsers, ...requestedTeams];
				const reviewerList = reviewers.length > 0 ? reviewers.join(", ") : "(none)";
				const mergeable = data.mergeable_state ?? "unknown";
				const draftFlag = data.draft === true ? " (draft)" : "";
				const body = data.body != null && data.body.length > 0 ? data.body : "(no body)";
				const lines = [
					`# PR #${data.number}: ${data.title}${draftFlag}`,
					"",
					`- state: **${state}**`,
					`- mergeable: ${mergeable}`,
					`- head → base: \`${data.head.ref}\` (${data.head.sha.slice(0, 7)}) → \`${data.base.ref}\` (${data.base.sha.slice(0, 7)})`,
					`- author: ${author}`,
					`- requested_reviewers: ${reviewerList}`,
					`- commits: ${data.commits}, +${data.additions} / -${data.deletions} across ${data.changed_files} file(s)`,
					`- created: ${data.created_at} | updated: ${data.updated_at}${data.merged_at != null ? ` | merged: ${data.merged_at}` : ""}`,
					`- url: ${data.html_url}`,
					"",
					"## Body",
					"",
					body,
				];
				return text(truncate(lines.join("\n")));
			}),
	);

	server.registerTool(
		"list_pr_reviews",
		{
			description:
				"List the reviews submitted on a pull request — the review-level wrappers (state: APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED / PENDING, the summary body, the reviewer, and when it was submitted). Use to check a PR's approval status or read reviewers' summary comments. Distinct from `list_pr_review_threads` (inline file:line comments) and `list_issue_comments` (conversation comments). REST page-based pagination via `page` / `per_page`.",
			inputSchema: {
				...RepoTarget,
				pull_number: z.number().int().positive().describe("Pull request number."),
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
		async ({ owner, repo, pull_number, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.pulls.listReviews({
					owner,
					repo,
					pull_number,
					per_page,
					page,
				});
				logRateLimit(headers);
				if (data.length === 0) {
					return text(`# Reviews on ${owner}/${repo}#${pull_number}\n\nNo reviews submitted.`);
				}
				const lines = data.map((r) => {
					const author = r.user?.login != null ? `@${r.user.login}` : "(unknown)";
					const submitted = r.submitted_at != null ? ` (${r.submitted_at})` : "";
					const snippet =
						r.body.length > 0 ? `\n  > ${snippetOf(r.body.split("\n")[0] ?? "")}` : "";
					return `- ${author} — **${r.state}**${submitted}${snippet}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const pageNum = page ?? 1;
				const header = hasMore
					? `# Reviews on ${owner}/${repo}#${pull_number} (page ${pageNum}, ${data.length} shown; more available — pass next \`page\` or raise \`per_page\` up to 100)`
					: `# Reviews on ${owner}/${repo}#${pull_number} (${data.length})`;
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"update_pull_request",
		{
			description:
				'Edit an existing pull request\'s title, body, state, or base branch. Use when the user asks to retitle, edit the description of, close (without merging), reopen, or retarget a PR. Pass `state: "closed"` to close without merging, `state: "open"` to reopen. `base` retargets the merge destination. To merge a PR, use merge_pull_request instead; to mark a draft as ready for review, that is a separate GraphQL operation not covered here.',
			inputSchema: {
				...RepoTarget,
				pull_number: z.number().int().positive().describe("Pull request number to update."),
				title: z.string().min(1).optional().describe("New PR title."),
				body: z
					.string()
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("PR body", MAX_TEXT_FIELD_LENGTH))
					.optional()
					.describe(
						"New PR body (Markdown supported); omit to leave unchanged, pass an empty string to clear.",
					),
				state: z
					.enum(["open", "closed"])
					.optional()
					.describe("New PR state. `closed` closes without merging; `open` reopens."),
				base: z
					.string()
					.min(1)
					.optional()
					.describe("New base branch to retarget the PR at (the merge destination)."),
			},
		},
		async ({ owner, repo, pull_number, title, body, state, base }) =>
			wrapTool(async () => {
				if (title == null && body == null && state == null && base == null) {
					return errorResult("Provide at least one field to update (title, body, state, or base).");
				}
				const { data, headers } = await client().rest.pulls.update(
					stripUndefined({
						owner,
						repo,
						pull_number,
						title,
						body,
						state,
						base,
					}),
				);
				logRateLimit(headers);
				logWrite({ tool: "update_pull_request", owner, repo, pull_number });
				const resolvedState = data.merged === true ? "merged" : data.state;
				return text(
					`# Pull request updated\n\n- **${data.title}** (#${data.number}) — state: **${resolvedState}** → base \`${data.base.ref}\`\n- ${data.html_url}`,
				);
			}),
	);

	server.registerTool(
		"merge_pull_request",
		{
			description:
				"Merge a pull request. Use when the user asks to merge, squash-merge, or rebase-merge a PR. `merge_method` selects the strategy (the repo must allow it, or GitHub returns 405). `commit_title` / `commit_message` customise the merge commit (ignored for `rebase`). Pass `sha` as a concurrency guard — the merge is refused if the PR head has moved past it. Returns the merge commit SHA on success.",
			inputSchema: {
				...RepoTarget,
				pull_number: z.number().int().positive().describe("Pull request number to merge."),
				merge_method: z
					.enum(["merge", "squash", "rebase"])
					.default("merge")
					.describe(
						"Merge strategy. The repository must permit the chosen method (a disabled method returns 405).",
					),
				commit_title: z
					.string()
					.min(1)
					.optional()
					.describe("Title for the merge commit. Ignored when merge_method is `rebase`."),
				commit_message: z
					.string()
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Commit message", MAX_TEXT_FIELD_LENGTH))
					.optional()
					.describe("Body for the merge commit. Ignored when merge_method is `rebase`."),
				sha: z
					.string()
					.min(1)
					.optional()
					.describe("SHA the PR head must match — the merge is refused if it has advanced."),
			},
		},
		async ({ owner, repo, pull_number, merge_method, commit_title, commit_message, sha }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.pulls.merge(
					stripUndefined({
						owner,
						repo,
						pull_number,
						merge_method,
						commit_title,
						commit_message,
						sha,
					}),
				);
				logRateLimit(headers);
				logWrite({ tool: "merge_pull_request", owner, repo, pull_number });
				if (data.merged !== true) {
					return errorResult(`Merge not completed for #${pull_number}: ${data.message}`);
				}
				return text(
					`# Pull request merged\n\n- PR #${pull_number} merged via \`${merge_method}\`\n- merge commit: \`${data.sha}\`\n- ${data.message}`,
				);
			}),
	);

	registerReviewThreadTools(server, client);
};

/** Shape of one review thread node returned by the `reviewThreads` GraphQL query. */
type ReviewThreadNode = {
	id: string;
	isResolved: boolean;
	isOutdated: boolean;
	comments: {
		nodes: Array<{
			author: { login: string } | null;
			path: string | null;
			line: number | null;
			body: string;
		} | null>;
	};
};

type ReviewThreadsQueryResult = {
	repository: {
		pullRequest: {
			reviewThreads: {
				totalCount: number;
				pageInfo: { hasNextPage: boolean; endCursor: string | null };
				nodes: Array<ReviewThreadNode | null>;
			};
		} | null;
	} | null;
};

type ReviewThreadState = { thread: { id: string; isResolved: boolean } | null };
type ResolveReviewThreadResult = { resolveReviewThread: ReviewThreadState };
type UnresolveReviewThreadResult = { unresolveReviewThread: ReviewThreadState };

const REVIEW_THREADS_QUERY = `
	query ($owner: String!, $repo: String!, $pull_number: Int!, $first: Int!, $after: String) {
		repository(owner: $owner, name: $repo) {
			pullRequest(number: $pull_number) {
				reviewThreads(first: $first, after: $after) {
					totalCount
					pageInfo { hasNextPage endCursor }
					nodes {
						id
						isResolved
						isOutdated
						comments(first: 1) {
							nodes {
								author { login }
								path
								line
								body
							}
						}
					}
				}
			}
		}
	}
`;

const RESOLVE_THREAD_MUTATION = `
	mutation ($thread_id: ID!) {
		resolveReviewThread(input: { threadId: $thread_id }) {
			thread { id isResolved }
		}
	}
`;

const UNRESOLVE_THREAD_MUTATION = `
	mutation ($thread_id: ID!) {
		unresolveReviewThread(input: { threadId: $thread_id }) {
			thread { id isResolved }
		}
	}
`;

const registerReviewThreadTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"list_pr_review_threads",
		{
			description:
				"List the review threads on a pull request, including each thread's node ID (`PRRT_...`) and resolved state. Use this to discover thread IDs before calling resolve_review_thread / unresolve_review_thread, or to check which review threads are still unresolved. Supports cursor pagination via `after` for PRs with more than 100 threads. Backed by GraphQL since the REST review-comment surface does not expose thread IDs.",
			inputSchema: {
				...RepoTarget,
				pull_number: z.number().int().positive().describe("Pull request number."),
				first: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.default(50)
					.describe("Maximum number of review threads to return (1-100)."),
				after: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Opaque pagination cursor from a previous page's endCursor. Omit for the first page.",
					),
			},
		},
		async ({ owner, repo, pull_number, first, after }) =>
			wrapTool(async () => {
				const result = await client().graphql<ReviewThreadsQueryResult>(REVIEW_THREADS_QUERY, {
					owner,
					repo,
					pull_number,
					first,
					after,
				});
				if (result.repository == null) {
					return errorResult(
						`Repository ${owner}/${repo} not found or not accessible (check the name and your token's permissions).`,
					);
				}
				const pr = result.repository.pullRequest;
				if (pr == null) {
					return errorResult(`Pull request ${owner}/${repo}#${pull_number} not found.`);
				}
				const { totalCount, pageInfo, nodes } = pr.reviewThreads;
				const threads = nodes.filter((n): n is ReviewThreadNode => n != null);
				if (threads.length === 0) {
					return text(`# Review threads on ${owner}/${repo}#${pull_number}\n\nNo review threads.`);
				}
				const lines = threads.map((t) => {
					const firstComment = t.comments.nodes.find((c) => c != null) ?? null;
					const author =
						firstComment?.author?.login != null ? `@${firstComment.author.login}` : "(unknown)";
					const location =
						firstComment?.path != null
							? `${firstComment.path}${firstComment.line != null ? `:${firstComment.line}` : ""}`
							: "(no location)";
					const state = t.isResolved ? "resolved" : "unresolved";
					const outdated = t.isOutdated ? ", outdated" : "";
					const snippet =
						firstComment?.body != null ? snippetOf(firstComment.body.split("\n")[0] ?? "") : "";
					return `- \`${t.id}\` — ${state}${outdated} — ${author} on ${location}${snippet !== "" ? `\n  > ${snippet}` : ""}`;
				});
				const more =
					pageInfo.hasNextPage && pageInfo.endCursor != null
						? `\n\n(${threads.length} of ${totalCount} shown; more threads exist. Re-invoke with \`after: "${pageInfo.endCursor}"\` to fetch the next page.)`
						: "";
				// Truncate the thread body within a budget that reserves room for the
				// cursor hint, then append the hint. Since truncate() now honours its
				// cap (notice included), `body` stays within `MAX_RESPONSE_CHARS -
				// more.length`, so `body + more` never exceeds the cap and a large page
				// of long snippets can't drop the `after` cursor — the exact failure
				// #50 set out to fix.
				const body = truncate(
					`# Review threads on ${owner}/${repo}#${pull_number} (${threads.length})\n\n${lines.join("\n")}`,
					MAX_RESPONSE_CHARS - more.length,
				);
				return text(`${body}${more}`);
			}),
	);

	server.registerTool(
		"resolve_review_thread",
		{
			description:
				"Mark a pull request review thread as resolved. Operates on a thread node ID (`PRRT_...`), which you can discover with list_pr_review_threads. Use after a review comment has been addressed.",
			inputSchema: {
				thread_id: z
					.string()
					.min(1)
					.describe("Review thread node ID, e.g. 'PRRT_...'. Discover via list_pr_review_threads."),
			},
		},
		async ({ thread_id }) =>
			wrapTool(async () => {
				const result = await client().graphql<ResolveReviewThreadResult>(RESOLVE_THREAD_MUTATION, {
					thread_id,
				});
				const thread = result.resolveReviewThread.thread;
				if (thread == null) {
					return errorResult(`Failed to resolve review thread ${thread_id}.`);
				}
				logWrite({ tool: "resolve_review_thread", thread_id });
				return text(
					`# Review thread resolved\n\n- \`${thread.id}\` — resolved: ${thread.isResolved}`,
				);
			}),
	);

	server.registerTool(
		"unresolve_review_thread",
		{
			description:
				"Re-open a previously resolved pull request review thread. Operates on a thread node ID (`PRRT_...`), which you can discover with list_pr_review_threads. Use to reverse an accidental or premature resolution.",
			inputSchema: {
				thread_id: z
					.string()
					.min(1)
					.describe("Review thread node ID, e.g. 'PRRT_...'. Discover via list_pr_review_threads."),
			},
		},
		async ({ thread_id }) =>
			wrapTool(async () => {
				const result = await client().graphql<UnresolveReviewThreadResult>(
					UNRESOLVE_THREAD_MUTATION,
					{ thread_id },
				);
				const thread = result.unresolveReviewThread.thread;
				if (thread == null) {
					return errorResult(`Failed to unresolve review thread ${thread_id}.`);
				}
				logWrite({ tool: "unresolve_review_thread", thread_id });
				return text(
					`# Review thread re-opened\n\n- \`${thread.id}\` — resolved: ${thread.isResolved}`,
				);
			}),
	);
};
