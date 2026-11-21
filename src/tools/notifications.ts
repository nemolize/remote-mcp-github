import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	errorResult,
	logRateLimit,
	logWrite,
	restListHeader,
	text,
	truncate,
	wrapTool,
} from "../mcp/response.js";
import { isHttpStatus, stripUndefined } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";

const NOTIFICATIONS_MAX_PER_PAGE = 50;
const REPO_NOTIFICATIONS_MAX_PER_PAGE = 100;

const ThreadId = z
	.string()
	.regex(/^[1-9][0-9]*$/, "thread_id must be the numeric id from a notification list.")
	.refine((v) => Number.isSafeInteger(Number(v)), "thread_id is out of range.")
	.describe(
		"Notification thread id (the backticked `id` from `list_notifications` or `list_repo_notifications`).",
	);

const Timestamp = (label: string) =>
	z.iso
		.datetime()
		.optional()
		.describe(`${label} (ISO 8601 UTC, for example \`2026-01-31T12:00:00Z\`).`);

const ListFilters = {
	all: z
		.boolean()
		.optional()
		.default(false)
		.describe("If true, include notifications already marked as read. Default: unread only."),
	participating: z
		.boolean()
		.optional()
		.default(false)
		.describe("If true, only threads where the user is directly participating or mentioned."),
	since: Timestamp("Only notifications updated after this time"),
	before: Timestamp("Only notifications updated before this time"),
	page: z.number().int().min(1).optional().describe("Page number (1-indexed). Defaults to 1."),
} as const;

type NotificationThread = {
	id: string;
	unread: boolean;
	reason: string;
	updated_at: string;
	last_read_at: string | null;
	subject: { title: string; type: string; url?: string | null | undefined };
	repository: { full_name: string };
};

type SubjectLink = { number: number; url: string };

const SUBJECT_API_URL =
	/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)$/;
const SUBJECT_KIND: Record<string, { segment: string; html: string }> = {
	Issue: { segment: "issues", html: "issues" },
	PullRequest: { segment: "pulls", html: "pull" },
};

const subjectLink = (thread: NotificationThread): SubjectLink | null => {
	const url = thread.subject.url;
	const kind = SUBJECT_KIND[thread.subject.type];
	if (url == null || kind == null) return null;
	const match = SUBJECT_API_URL.exec(url);
	if (match == null) return null;
	const [, owner, repo, segment, number] = match;
	if (segment !== kind.segment) return null;
	if (`${owner}/${repo}`.toLowerCase() !== thread.repository.full_name.toLowerCase()) return null;
	return {
		number: Number(number),
		url: `https://github.com/${owner}/${repo}/${kind.html}/${number}`,
	};
};

const threadLine = (t: NotificationThread): string => {
	const link = subjectLink(t);
	const subject = link != null ? `${t.subject.type} #${link.number}` : t.subject.type;
	return `- \`${t.id}\` ${t.unread ? "**unread**" : "read"} · reason: **${t.reason}** — ${t.subject.title} (${subject} in ${t.repository.full_name}), updated ${t.updated_at}`;
};

const hasNextPage = (headers: { link?: string | undefined }): boolean =>
	(headers.link ?? "").includes('rel="next"');

const renderThreadList = ({
	title,
	threads,
	page,
	hasMore,
	maxPerPage,
	emptyMessage,
}: {
	title: string;
	threads: NotificationThread[];
	page: number | undefined;
	hasMore: boolean;
	maxPerPage: number;
	emptyMessage: string;
}): string => {
	if (threads.length === 0) {
		return page != null && page > 1 ? "(no notifications on this page)" : emptyMessage;
	}
	const header = restListHeader({ title, count: threads.length, page, hasMore, maxPerPage });
	return truncate(`${header}\n\n${threads.map(threadLine).join("\n")}`);
};

const subscriptionLine = (
	sub: { subscribed: boolean; ignored: boolean; reason: string | null } | null,
): string => {
	if (sub == null) return "no subscription record (default notification rules apply)";
	if (sub.ignored) return "ignored (all notifications from this thread are blocked)";
	if (sub.subscribed) return `subscribed${sub.reason != null ? ` (${sub.reason})` : ""}`;
	return "not subscribed";
};

const bodyHint = (thread: NotificationThread, link: SubjectLink | null): string => {
	if (link == null)
		return `No issue / PR link is available; find it on github.com in ${thread.repository.full_name} by its title.`;
	const [owner, repo] = thread.repository.full_name.split("/");
	const target = `owner \`${owner}\`, repo \`${repo}\`, number ${link.number}`;
	const bodyTool = thread.subject.type === "PullRequest" ? "get_pull_request" : "get_issue";
	return `Read the body with \`${bodyTool}\` and the conversation with \`list_issue_comments\` (${target}).`;
};

export const registerNotificationTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"list_notifications",
		{
			description:
				"List the authenticated user's GitHub notification threads (`gh api notifications`): one line per thread with its id, unread state, the reason you were notified (highlighted), the subject title and type, the repo and the last update. Unread only by default; `all: true` includes read threads, `participating: true` narrows to threads you take part in. Use the thread `id` with `get_notification_thread`, `mark_thread_read` or `set_thread_subscription`. To scope to one repo use `list_repo_notifications`. Requires the `notifications` (or `repo`) OAuth scope.",
			inputSchema: {
				...ListFilters,
				per_page: z
					.number()
					.int()
					.min(1)
					.max(NOTIFICATIONS_MAX_PER_PAGE)
					.optional()
					.default(30)
					.describe(`Results per page (1-${NOTIFICATIONS_MAX_PER_PAGE}).`),
			},
		},
		async ({ all, participating, since, before, page, per_page }) =>
			wrapTool(async () => {
				const { data, headers } =
					await client().rest.activity.listNotificationsForAuthenticatedUser(
						stripUndefined({ all, participating, since, before, page, per_page }),
					);
				logRateLimit(headers);
				return text(
					renderThreadList({
						title: "Notifications",
						threads: data,
						page,
						hasMore: hasNextPage(headers),
						maxPerPage: NOTIFICATIONS_MAX_PER_PAGE,
						emptyMessage: all
							? "(no notifications found)"
							: "(no unread notifications found — read ones are hidden; pass `all: true` to include them)",
					}),
				);
			}),
	);

	server.registerTool(
		"list_repo_notifications",
		{
			description:
				"List the authenticated user's notification threads for a single repository — the same rows and filters as `list_notifications`, scoped to one repo (handy when triaging one project). Requires the `notifications` (or `repo`) OAuth scope.",
			inputSchema: {
				...RepoTarget,
				...ListFilters,
				per_page: z
					.number()
					.int()
					.min(1)
					.max(REPO_NOTIFICATIONS_MAX_PER_PAGE)
					.optional()
					.default(30)
					.describe(`Results per page (1-${REPO_NOTIFICATIONS_MAX_PER_PAGE}).`),
			},
		},
		async ({ owner, repo, all, participating, since, before, page, per_page }) =>
			wrapTool(async () => {
				const { data, headers } =
					await client().rest.activity.listRepoNotificationsForAuthenticatedUser(
						stripUndefined({ owner, repo, all, participating, since, before, page, per_page }),
					);
				logRateLimit(headers);
				return text(
					renderThreadList({
						title: `Notifications for ${owner}/${repo}`,
						threads: data,
						page,
						hasMore: hasNextPage(headers),
						maxPerPage: REPO_NOTIFICATIONS_MAX_PER_PAGE,
						emptyMessage: all
							? `(no notifications found for ${owner}/${repo})`
							: `(no unread notifications found for ${owner}/${repo} — read ones are hidden; pass \`all: true\` to include them)`,
					}),
				);
			}),
	);

	server.registerTool(
		"get_notification_thread",
		{
			description:
				"Get one notification thread by id: its subject (title, type, number and GitHub link), the reason, unread / last-read times and your subscription state for the thread. It does not fetch the issue / PR body or comments — it says which tool reads them (`get_issue`, `get_pull_request`, `list_issue_comments`). Get the `thread_id` from `list_notifications` or `list_repo_notifications`. Requires the `notifications` (or `repo`) OAuth scope.",
			inputSchema: { thread_id: ThreadId },
		},
		async ({ thread_id }) =>
			wrapTool(async () => {
				const octokit = client();
				const id = Number(thread_id);
				const thread = await octokit.rest.activity.getThread({ thread_id: id });
				logRateLimit(thread.headers);
				const subscription = await octokit.rest.activity
					.getThreadSubscriptionForAuthenticatedUser({ thread_id: id })
					.then(
						(r) => r.data,
						(e: unknown) => {
							if (isHttpStatus(e, 404)) return null;
							throw e;
						},
					);
				const t: NotificationThread = thread.data;
				const link = subjectLink(t);
				const lines = [
					`# ${t.subject.title}`,
					"",
					`- thread: \`${t.id}\``,
					`- repo: ${t.repository.full_name}`,
					`- type: ${t.subject.type}`,
					link != null
						? `- subject: #${link.number} — ${link.url}`
						: "- subject: (no issue / PR link available)",
					`- reason: ${t.reason}`,
					`- unread: ${t.unread ? "yes" : "no"}`,
					`- updated: ${t.updated_at}`,
					`- last read: ${t.last_read_at ?? "(never)"}`,
					`- subscription: ${subscriptionLine(subscription)}`,
					"",
					bodyHint(t, link),
				];
				return text(truncate(lines.join("\n")));
			}),
	);

	server.registerTool(
		"mark_notifications_read",
		{
			description:
				"Mark notification threads as read in bulk: everything updated up to `last_read_at` (default: now). Pass both `owner` and `repo` to limit it to one repository; omit both to cover all of the user's notifications. GitHub may process a large request asynchronously (the result says so). To mark a single thread use `mark_thread_read`. Requires the `notifications` (or `repo`) OAuth scope.",
			inputSchema: {
				last_read_at: Timestamp(
					"Mark threads updated up to this time as read; newer ones stay unread",
				),
				owner: RepoTarget.owner
					.optional()
					.describe("Repository owner — give together with `repo`."),
				repo: RepoTarget.repo.optional().describe("Repository name — give together with `owner`."),
			},
		},
		async ({ last_read_at, owner, repo }) =>
			wrapTool(async () => {
				if ((owner == null) !== (repo == null)) {
					return errorResult("Pass both `owner` and `repo` to scope to a repository, or neither.");
				}
				const octokit = client();
				const res =
					owner != null && repo != null
						? await octokit.rest.activity.markRepoNotificationsAsRead(
								stripUndefined({ owner, repo, last_read_at }),
							)
						: await octokit.rest.activity.markNotificationsAsRead(stripUndefined({ last_read_at }));
				logRateLimit(res.headers);
				logWrite({
					tool: "mark_notifications_read",
					...stripUndefined({ owner, repo, last_read_at }),
				});
				const scope = owner != null && repo != null ? `**${owner}/${repo}**` : "all repositories";
				const upTo = last_read_at ?? "now";
				const async = res.status === 202 ? " GitHub is processing this asynchronously." : "";
				return text(
					`# Notifications marked as read\n\n- scope: ${scope}\n- up to: ${upTo}\n\nThreads updated after that time stay unread.${async}`,
				);
			}),
	);

	server.registerTool(
		"mark_thread_read",
		{
			description:
				"Mark a single notification thread as read. Get the `thread_id` from `list_notifications` or `list_repo_notifications`. For many threads at once use `mark_notifications_read`. Requires the `notifications` (or `repo`) OAuth scope.",
			inputSchema: { thread_id: ThreadId },
		},
		async ({ thread_id }) =>
			wrapTool(async () => {
				const { headers } = await client().rest.activity.markThreadAsRead({
					thread_id: Number(thread_id),
				});
				logRateLimit(headers);
				logWrite({ tool: "mark_thread_read", notification_thread_id: thread_id });
				return text(`# Thread marked as read\n\n- \`${thread_id}\` is now read.`);
			}),
	);

	server.registerTool(
		"set_thread_subscription",
		{
			description:
				"Change how a notification thread notifies the user. `action` is `subscribe` (get notified about the thread), `ignore` (block all notifications from it — use to silence a noisy thread) or `unsubscribe` (remove the thread subscription; repo-level watching still applies). Get the `thread_id` from `list_notifications` or `list_repo_notifications`. Requires the `notifications` (or `repo`) OAuth scope.",
			inputSchema: {
				thread_id: ThreadId,
				action: z
					.enum(["subscribe", "ignore", "unsubscribe"])
					.describe("What to do with the thread."),
			},
		},
		async ({ thread_id, action }) =>
			wrapTool(async () => {
				const octokit = client();
				const id = Number(thread_id);
				const res =
					action === "unsubscribe"
						? await octokit.rest.activity.deleteThreadSubscription({ thread_id: id })
						: await octokit.rest.activity.setThreadSubscription({
								thread_id: id,
								ignored: action === "ignore",
							});
				logRateLimit(res.headers);
				logWrite({ tool: "set_thread_subscription", notification_thread_id: thread_id, action });
				const done = {
					subscribe: "subscribed",
					ignore: "ignored — no further notifications from it",
					unsubscribe: "unsubscribed (subscription removed)",
				}[action];
				return text(`# Thread subscription updated\n\n- \`${thread_id}\`: ${done}.`);
			}),
	);
};
