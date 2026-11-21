import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_RESPONSE_CHARS } from "../src/mcp/response.js";
import { registerNotificationTools } from "../src/tools/notifications.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const thread = (overrides = {}) => ({
	id: "1001",
	unread: true,
	reason: "review_requested",
	updated_at: "2026-01-02T00:00:00Z",
	last_read_at: null,
	subject: {
		title: "Fix the thing",
		type: "PullRequest",
		url: "https://api.github.com/repos/o/r/pulls/12",
	},
	repository: { full_name: "o/r" },
	...overrides,
});

const httpError = (message, status) => {
	const err = new Error(message);
	err.status = status;
	return err;
};

const setup = (activity = {}) => {
	const { handlers, server } = captureHandlers();
	registerNotificationTools(server, () => ({ rest: { activity } }));
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

describe("list_notifications", () => {
	it("renders one line per thread with the reason highlighted and a PR number", async () => {
		const handlers = setup({
			listNotificationsForAuthenticatedUser: async () => ({
				data: [
					thread(),
					thread({
						id: "1002",
						unread: false,
						reason: "mention",
						subject: {
							title: "Bug",
							type: "Issue",
							url: "https://api.github.com/repos/o/r/issues/7",
						},
					}),
				],
				headers: {},
			}),
		});
		const body = (await invoke(handlers, "list_notifications", { per_page: 30 })).content[0].text;
		expect(body).toContain("# Notifications (2)");
		expect(body).toContain(
			"- `1001` **unread** · reason: **review_requested** — Fix the thing (PullRequest #12 in o/r), updated 2026-01-02T00:00:00Z",
		);
		expect(body).toContain("- `1002` read · reason: **mention** — Bug (Issue #7 in o/r)");
	});

	it("passes only the filters it was given", async () => {
		const spy = vi.fn(async () => ({ data: [], headers: {} }));
		const handlers = setup({ listNotificationsForAuthenticatedUser: spy });
		await invoke(handlers, "list_notifications", {
			all: true,
			participating: false,
			since: "2026-01-01T00:00:00Z",
			per_page: 10,
		});
		expect(spy).toHaveBeenCalledWith({
			all: true,
			participating: false,
			since: "2026-01-01T00:00:00Z",
			per_page: 10,
		});
	});

	it("says so when there is nothing, and when a later page is empty", async () => {
		const handlers = setup({
			listNotificationsForAuthenticatedUser: async () => ({ data: [], headers: {} }),
		});
		expect((await invoke(handlers, "list_notifications", {})).content[0].text).toBe(
			"(no notifications found)",
		);
		expect((await invoke(handlers, "list_notifications", { page: 3 })).content[0].text).toBe(
			"(no notifications on this page)",
		);
	});

	it("keeps the next-page hint when the page exceeds the response cap", async () => {
		const many = Array.from({ length: 50 }, (_, i) =>
			thread({
				id: String(2000 + i),
				subject: { title: "x".repeat(300), type: "Discussion", url: null },
			}),
		);
		const handlers = setup({
			listNotificationsForAuthenticatedUser: async () => ({
				data: many,
				headers: { link: '<https://api.github.com/notifications?page=2>; rel="next"' },
			}),
		});
		const body = (await invoke(handlers, "list_notifications", { per_page: 50 })).content[0].text;
		expect(body.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
		expect(body).toContain("more available — pass next `page` or raise `per_page` up to 50");
		expect(body).toContain("truncated");
	});

	it("renders no link for subjects it cannot open as an issue or PR", async () => {
		const bad = [
			{ title: "disc", type: "Discussion", url: null },
			{ title: "wrong repo", type: "PullRequest", url: "https://api.github.com/repos/x/y/pulls/3" },
			{
				title: "wrong kind",
				type: "PullRequest",
				url: "https://api.github.com/repos/o/r/issues/3",
			},
			{ title: "other host", type: "Issue", url: "https://evil.example/repos/o/r/issues/3" },
			{
				title: "extra path",
				type: "Issue",
				url: "https://api.github.com/repos/o/r/issues/3/comments/9",
			},
		];
		const handlers = setup({
			listNotificationsForAuthenticatedUser: async () => ({
				data: bad.map((subject, i) => thread({ id: String(3000 + i), subject })),
				headers: {},
			}),
		});
		const body = (await invoke(handlers, "list_notifications", {})).content[0].text;
		expect(body).not.toMatch(/#\d/);
	});
});

describe("list_repo_notifications", () => {
	it("scopes to the repo and uses the repo endpoint's per_page cap in the hint", async () => {
		const spy = vi.fn(async () => ({
			data: [thread()],
			headers: { link: '<x>; rel="next"' },
		}));
		const handlers = setup({ listRepoNotificationsForAuthenticatedUser: spy });
		const body = (
			await invoke(handlers, "list_repo_notifications", { owner: "o", repo: "r", per_page: 30 })
		).content[0].text;
		expect(spy).toHaveBeenCalledWith({ owner: "o", repo: "r", per_page: 30 });
		expect(body).toContain("# Notifications for o/r (page 1, 1 shown; more available");
		expect(body).toContain("up to 100");
	});

	it("names the repo when empty", async () => {
		const handlers = setup({
			listRepoNotificationsForAuthenticatedUser: async () => ({ data: [], headers: {} }),
		});
		expect(
			(await invoke(handlers, "list_repo_notifications", { owner: "o", repo: "r" })).content[0]
				.text,
		).toBe("(no notifications found for o/r)");
	});
});

describe("get_notification_thread", () => {
	const make = (subscription) =>
		setup({
			getThread: async () => ({ data: thread(), headers: {} }),
			getThreadSubscriptionForAuthenticatedUser: subscription,
		});

	it("renders the subject link, read state and subscription, and points to the body tools", async () => {
		const handlers = make(async () => ({
			data: { subscribed: true, ignored: false, reason: "manual" },
			headers: {},
		}));
		const body = (await invoke(handlers, "get_notification_thread", { thread_id: "1001" }))
			.content[0].text;
		expect(body).toContain("# Fix the thing");
		expect(body).toContain("- subject: #12 — https://github.com/o/r/pull/12");
		expect(body).toContain("- last read: (never)");
		expect(body).toContain("- subscription: subscribed (manual)");
		expect(body).toContain("`get_pull_request`");
	});

	it("shows ignored and not-subscribed states", async () => {
		const ignored = make(async () => ({
			data: { subscribed: false, ignored: true, reason: null },
			headers: {},
		}));
		expect(
			(await invoke(ignored, "get_notification_thread", { thread_id: "1001" })).content[0].text,
		).toContain("- subscription: ignored");
		const none = make(async () => ({
			data: { subscribed: false, ignored: false, reason: null },
			headers: {},
		}));
		expect(
			(await invoke(none, "get_notification_thread", { thread_id: "1001" })).content[0].text,
		).toContain("- subscription: not subscribed");
	});

	it("treats a 404 on the subscription as no record, and surfaces any other error", async () => {
		const missing = make(async () => {
			throw httpError("Not Found", 404);
		});
		const ok = await invoke(missing, "get_notification_thread", { thread_id: "1001" });
		expect(ok.isError).toBeUndefined();
		expect(ok.content[0].text).toContain("- subscription: no subscription record");

		const denied = make(async () => {
			throw httpError("Forbidden", 403);
		});
		const err = await invoke(denied, "get_notification_thread", { thread_id: "1001" });
		expect(err.isError).toBe(true);
		expect(err.content[0].text).toContain("(HTTP 403)");
	});

	it("passes the id as a number and does not fetch the subject", async () => {
		const getThread = vi.fn(async () => ({ data: thread(), headers: {} }));
		const request = vi.fn();
		const { handlers, server } = captureHandlers();
		registerNotificationTools(server, () => ({
			request,
			rest: {
				activity: {
					getThread,
					getThreadSubscriptionForAuthenticatedUser: async () => ({
						data: { subscribed: false, ignored: false, reason: null },
						headers: {},
					}),
				},
			},
		}));
		await invoke(handlers, "get_notification_thread", { thread_id: "1001" });
		expect(getThread).toHaveBeenCalledWith({ thread_id: 1001 });
		expect(request).not.toHaveBeenCalled();
	});

	it("falls back to a no-link line for a subject without an issue/PR URL", async () => {
		const handlers = setup({
			getThread: async () => ({
				data: thread({ subject: { title: "CI", type: "CheckSuite", url: null } }),
				headers: {},
			}),
			getThreadSubscriptionForAuthenticatedUser: async () => ({
				data: { subscribed: true, ignored: false, reason: null },
				headers: {},
			}),
		});
		const body = (await invoke(handlers, "get_notification_thread", { thread_id: "1001" }))
			.content[0].text;
		expect(body).toContain("- subject: (no issue / PR link available)");
	});

	it("surfaces a thread 404", async () => {
		const handlers = setup({
			getThread: async () => {
				throw httpError("Not Found", 404);
			},
		});
		const res = await invoke(handlers, "get_notification_thread", { thread_id: "999" });
		expect(res.isError).toBe(true);
	});
});

describe("mark_notifications_read", () => {
	it("marks everything and audits without a repo", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const spy = vi.fn(async () => ({ status: 205, data: undefined, headers: {} }));
		const handlers = setup({ markNotificationsAsRead: spy });
		const body = (await invoke(handlers, "mark_notifications_read", {})).content[0].text;
		expect(spy).toHaveBeenCalledWith({});
		expect(body).toContain("- scope: all repositories");
		expect(body).toContain("- up to: now");
		expect(auditLines(logSpy)).toEqual([{ tool: "mark_notifications_read" }]);
	});

	it("scopes to a repo with a cut-off and notes asynchronous processing on 202", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const spy = vi.fn(async () => ({ status: 202, data: { message: "queued" }, headers: {} }));
		const handlers = setup({ markRepoNotificationsAsRead: spy });
		const body = (
			await invoke(handlers, "mark_notifications_read", {
				owner: "o",
				repo: "r",
				last_read_at: "2026-01-01T00:00:00Z",
			})
		).content[0].text;
		expect(spy).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			last_read_at: "2026-01-01T00:00:00Z",
		});
		expect(body).toContain("- scope: **o/r**");
		expect(body).toContain("asynchronously");
		expect(auditLines(logSpy)).toEqual([
			{
				tool: "mark_notifications_read",
				owner: "o",
				repo: "r",
				last_read_at: "2026-01-01T00:00:00Z",
			},
		]);
	});

	it("rejects an owner without a repo before any request", async () => {
		const spy = vi.fn();
		const handlers = setup({ markNotificationsAsRead: spy, markRepoNotificationsAsRead: spy });
		const res = await invoke(handlers, "mark_notifications_read", { owner: "o" });
		expect(res.isError).toBe(true);
		expect(spy).not.toHaveBeenCalled();
	});

	it("does not audit when the call fails", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const handlers = setup({
			markNotificationsAsRead: async () => {
				throw httpError("Forbidden", 403);
			},
		});
		const res = await invoke(handlers, "mark_notifications_read", {});
		expect(res.isError).toBe(true);
		expect(auditLines(logSpy)).toEqual([]);
	});
});

describe("mark_thread_read", () => {
	it("marks the thread and audits its id", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const spy = vi.fn(async () => ({ status: 205, data: undefined, headers: {} }));
		const handlers = setup({ markThreadAsRead: spy });
		const body = (await invoke(handlers, "mark_thread_read", { thread_id: "1001" })).content[0]
			.text;
		expect(spy).toHaveBeenCalledWith({ thread_id: 1001 });
		expect(body).toContain("`1001` is now read");
		expect(auditLines(logSpy)).toEqual([{ tool: "mark_thread_read", thread_id: "1001" }]);
	});

	it("surfaces a 404 for an unknown thread", async () => {
		const handlers = setup({
			markThreadAsRead: async () => {
				throw httpError("Not Found", 404);
			},
		});
		const res = await invoke(handlers, "mark_thread_read", { thread_id: "1" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("(HTTP 404)");
	});
});

describe("set_thread_subscription", () => {
	it("subscribes with ignored:false and ignores with ignored:true", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const set = vi.fn(async () => ({ data: {}, headers: {} }));
		const handlers = setup({ setThreadSubscription: set });
		await invoke(handlers, "set_thread_subscription", { thread_id: "5", action: "subscribe" });
		await invoke(handlers, "set_thread_subscription", { thread_id: "5", action: "ignore" });
		expect(set).toHaveBeenNthCalledWith(1, { thread_id: 5, ignored: false });
		expect(set).toHaveBeenNthCalledWith(2, { thread_id: 5, ignored: true });
		expect(auditLines(logSpy)).toEqual([
			{ tool: "set_thread_subscription", thread_id: "5", action: "subscribe" },
			{ tool: "set_thread_subscription", thread_id: "5", action: "ignore" },
		]);
	});

	it("unsubscribes through the delete endpoint", async () => {
		const del = vi.fn(async () => ({ status: 204, data: undefined, headers: {} }));
		const set = vi.fn();
		const handlers = setup({ deleteThreadSubscription: del, setThreadSubscription: set });
		const body = (
			await invoke(handlers, "set_thread_subscription", { thread_id: "5", action: "unsubscribe" })
		).content[0].text;
		expect(del).toHaveBeenCalledWith({ thread_id: 5 });
		expect(set).not.toHaveBeenCalled();
		expect(body).toContain("unsubscribed");
	});
});

describe("thread_id input schema", () => {
	const schemas = () => {
		const configs = new Map();
		registerNotificationTools(
			{ registerTool: (name, config) => configs.set(name, config) },
			() => ({}),
		);
		return configs;
	};

	it.each(["get_notification_thread", "mark_thread_read", "set_thread_subscription"])(
		"%s accepts digits only",
		(name) => {
			const { thread_id } = schemas().get(name).inputSchema;
			for (const ok of ["1", "1001", "9007199254740991"]) {
				expect(thread_id.safeParse(ok).success, ok).toBe(true);
			}
			for (const bad of ["0", "01", "-1", "1e3", "1/subscription", " 1", "", "9007199254740993"]) {
				expect(thread_id.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
			}
		},
	);

	it("caps per_page per endpoint and rejects non-UTC timestamps", () => {
		const s = schemas();
		expect(s.get("list_notifications").inputSchema.per_page.safeParse(51).success).toBe(false);
		expect(s.get("list_notifications").inputSchema.per_page.safeParse(50).success).toBe(true);
		expect(s.get("list_repo_notifications").inputSchema.per_page.safeParse(100).success).toBe(true);
		expect(s.get("list_notifications").inputSchema.since.safeParse("yesterday").success).toBe(
			false,
		);
	});
});
