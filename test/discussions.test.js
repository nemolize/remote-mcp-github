import { describe, expect, it } from "vitest";

import { registerDiscussionTools } from "../src/tools/discussions.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

// The discussions tools only touch `client().graphql(query, vars)`, so a stub
// carrying just `graphql` is a sufficient Octokit.
const stubOctokit = (graphql) => ({ graphql });

const page = (nodes, { totalCount, hasNextPage = false, endCursor = null } = {}) => ({
	totalCount: totalCount ?? nodes.length,
	pageInfo: { hasNextPage, endCursor },
	nodes,
});

const discussionNode = (overrides = {}) => ({
	number: 42,
	title: "How do I configure X?",
	author: { login: "alice" },
	category: { name: "Q&A" },
	createdAt: "2026-06-01T00:00:00Z",
	updatedAt: "2026-07-01T00:00:00Z",
	isAnswered: false,
	upvoteCount: 3,
	comments: { totalCount: 5 },
	url: "https://github.com/o/r/discussions/42",
	...overrides,
});

const categoryNode = (overrides = {}) => ({
	id: "DIC_kwAA1",
	name: "Q&A",
	slug: "q-a",
	emoji: ":pray:",
	description: "Ask the community",
	isAnswerable: true,
	...overrides,
});

const commentNode = (overrides = {}) => ({
	author: { login: "bob" },
	body: "Try setting the flag in config.",
	createdAt: "2026-06-02T00:00:00Z",
	lastEditedAt: null,
	url: "https://github.com/o/r/discussions/42#discussioncomment-1",
	isAnswer: false,
	upvoteCount: 1,
	replies: { totalCount: 0 },
	...overrides,
});

describe("registerDiscussionTools", () => {
	it("registers the four read tools", () => {
		const { handlers, server } = captureHandlers();
		registerDiscussionTools(server, () => stubOctokit(async () => ({})));
		expect(handlers.has("list_discussions")).toBe(true);
		expect(handlers.has("list_discussion_categories")).toBe(true);
		expect(handlers.has("get_discussion")).toBe(true);
		expect(handlers.has("get_discussion_comments")).toBe(true);
	});
});

describe("list_discussions", () => {
	it("lists discussions with category, answered state, counts, and URL", async () => {
		const { handlers, server } = captureHandlers();
		let capturedQuery;
		let capturedVars;
		const octokit = stubOctokit(async (query, vars) => {
			capturedQuery = query;
			capturedVars = vars;
			return { repository: { discussions: page([discussionNode()]) } };
		});
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "list_discussions", {
			owner: "o",
			repo: "r",
			per_page: 30,
		});
		expect(capturedQuery).toContain("discussions(");
		expect(capturedVars).toEqual({
			owner: "o",
			repo: "r",
			first: 30,
			after: undefined,
			categoryId: undefined,
		});
		const body = result.content[0].text;
		expect(body).toContain("# Discussions in o/r (1)");
		expect(body).toContain("#42 **How do I configure X?** [Q&A] by @alice");
		expect(body).toContain("unanswered");
		expect(body).toContain("5 comments, 3 upvotes");
		expect(body).toContain("https://github.com/o/r/discussions/42");
		expect(result.isError).toBeUndefined();
	});

	it("forwards the category filter and cursor", async () => {
		const { handlers, server } = captureHandlers();
		let capturedVars;
		const octokit = stubOctokit(async (_query, vars) => {
			capturedVars = vars;
			return { repository: { discussions: page([discussionNode()]) } };
		});
		registerDiscussionTools(server, () => octokit);

		await invoke(handlers, "list_discussions", {
			owner: "o",
			repo: "r",
			category_id: "DIC_kwAA1",
			per_page: 10,
			cursor: "CUR_1",
		});
		expect(capturedVars).toEqual({
			owner: "o",
			repo: "r",
			first: 10,
			after: "CUR_1",
			categoryId: "DIC_kwAA1",
		});
	});

	it("omits the answered segment for non-answerable categories", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({
			repository: {
				discussions: page([
					discussionNode({ isAnswered: null, category: { name: "Announcements" } }),
				]),
			},
		}));
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "list_discussions", {
			owner: "o",
			repo: "r",
			per_page: 30,
		});
		const body = result.content[0].text;
		expect(body).toContain("[Announcements]");
		expect(body).not.toContain("answered");
	});

	it("appends the cursor hint when a next page exists", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({
			repository: {
				discussions: page([discussionNode()], {
					totalCount: 12,
					hasNextPage: true,
					endCursor: "CUR_next",
				}),
			},
		}));
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "list_discussions", {
			owner: "o",
			repo: "r",
			per_page: 1,
		});
		const body = result.content[0].text;
		expect(body).toContain("(1 of 12 shown; more results exist.");
		expect(body).toContain('cursor: "CUR_next"');
	});

	it("renders an empty state", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ repository: { discussions: page([]) } }));
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "list_discussions", {
			owner: "o",
			repo: "r",
			per_page: 30,
		});
		expect(result.content[0].text).toContain("No discussions found.");
	});

	it("errors when the repository does not resolve", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ repository: null }));
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "list_discussions", {
			owner: "ghost",
			repo: "nope",
			per_page: 30,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Repository ghost/nope not found");
	});
});

describe("list_discussion_categories", () => {
	it("lists categories with slug, answerable flag, and node ID", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({
			repository: {
				discussionCategories: page([
					categoryNode(),
					categoryNode({
						id: "DIC_kwAA2",
						name: "Announcements",
						slug: "announcements",
						emoji: ":mega:",
						description: null,
						isAnswerable: false,
					}),
				]),
			},
		}));
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "list_discussion_categories", {
			owner: "o",
			repo: "r",
			per_page: 30,
		});
		const body = result.content[0].text;
		expect(body).toContain("# Discussion categories in o/r (2)");
		expect(body).toContain(
			"**Q&A** (`q-a`) — answerable (Q&A) — Ask the community — id: `DIC_kwAA1`",
		);
		expect(body).toContain("**Announcements** (`announcements`) — id: `DIC_kwAA2`");
		expect(result.isError).toBeUndefined();
	});

	it("renders an empty state hinting Discussions may be disabled", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({
			repository: { discussionCategories: page([]) },
		}));
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "list_discussion_categories", {
			owner: "o",
			repo: "r",
			per_page: 30,
		});
		expect(result.content[0].text).toContain("Discussions may be disabled");
	});

	it("errors when the repository does not resolve", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ repository: null }));
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "list_discussion_categories", {
			owner: "ghost",
			repo: "nope",
			per_page: 30,
		});
		expect(result.isError).toBe(true);
	});
});

describe("get_discussion", () => {
	const detailNode = (overrides = {}) => ({
		id: "D_kwAA1",
		number: 42,
		title: "How do I configure X?",
		body: "Long form question body.",
		author: { login: "alice" },
		category: { name: "Q&A", isAnswerable: true },
		createdAt: "2026-06-01T00:00:00Z",
		updatedAt: "2026-07-01T00:00:00Z",
		isAnswered: true,
		upvoteCount: 3,
		comments: { totalCount: 5 },
		answer: {
			url: "https://github.com/o/r/discussions/42#discussioncomment-9",
			author: { login: "bob" },
		},
		url: "https://github.com/o/r/discussions/42",
		...overrides,
	});

	it("renders the detail with answered state and body", async () => {
		const { handlers, server } = captureHandlers();
		let capturedVars;
		const octokit = stubOctokit(async (_query, vars) => {
			capturedVars = vars;
			return { repository: { discussion: detailNode() } };
		});
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "get_discussion", {
			owner: "o",
			repo: "r",
			discussion_number: 42,
		});
		expect(capturedVars).toEqual({ owner: "o", repo: "r", number: 42 });
		const body = result.content[0].text;
		expect(body).toContain("# Discussion #42: How do I configure X?");
		expect(body).toContain("- author: @alice");
		expect(body).toContain("- category: Q&A");
		expect(body).toContain(
			"- answered: yes — by @bob (https://github.com/o/r/discussions/42#discussioncomment-9)",
		);
		expect(body).toContain("- comments: 5");
		expect(body).toContain("## Body");
		expect(body).toContain("Long form question body.");
		expect(result.isError).toBeUndefined();
	});

	it("omits the answered line for non-answerable categories and handles an empty body", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({
			repository: {
				discussion: detailNode({
					isAnswered: null,
					answer: null,
					body: "",
					category: { name: "General", isAnswerable: false },
				}),
			},
		}));
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "get_discussion", {
			owner: "o",
			repo: "r",
			discussion_number: 42,
		});
		const body = result.content[0].text;
		expect(body).not.toContain("- answered:");
		expect(body).toContain("(no body)");
	});

	it("errors when the discussion is not found", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ repository: { discussion: null } }));
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "get_discussion", {
			owner: "o",
			repo: "r",
			discussion_number: 999,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Discussion #999 not found in o/r");
	});

	it("errors when the repository does not resolve", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ repository: null }));
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "get_discussion", {
			owner: "ghost",
			repo: "nope",
			discussion_number: 1,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Repository ghost/nope not found");
	});
});

describe("get_discussion_comments", () => {
	const discussionWithComments = (comments, pageOverrides = {}) => ({
		repository: {
			discussion: {
				number: 42,
				title: "How do I configure X?",
				comments: page(comments, pageOverrides),
			},
		},
	});

	it("renders comment previews with answer marker and reply count", async () => {
		const { handlers, server } = captureHandlers();
		let capturedVars;
		const octokit = stubOctokit(async (_query, vars) => {
			capturedVars = vars;
			return discussionWithComments([
				commentNode(),
				commentNode({
					author: { login: "carol" },
					isAnswer: true,
					replies: { totalCount: 2 },
					lastEditedAt: "2026-06-03T00:00:00Z",
					url: "https://github.com/o/r/discussions/42#discussioncomment-2",
				}),
			]);
		});
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "get_discussion_comments", {
			owner: "o",
			repo: "r",
			discussion_number: 42,
			per_page: 30,
		});
		expect(capturedVars).toEqual({
			owner: "o",
			repo: "r",
			number: 42,
			first: 30,
			after: undefined,
		});
		const body = result.content[0].text;
		expect(body).toContain('# Comments on discussion #42 "How do I configure X?" (2)');
		expect(body).toContain("@bob — 2026-06-02T00:00:00Z — 1 upvotes —");
		expect(body).toContain("Try setting the flag in config.");
		expect(body).toContain("@carol — 2026-06-03T00:00:00Z (created 2026-06-02T00:00:00Z)");
		expect(body).toContain("✓ accepted answer");
		expect(body).toContain("2 replies");
		expect(body).toContain("1 upvotes");
		expect(result.isError).toBeUndefined();
	});

	it("omits the upvotes segment when a comment has zero upvotes", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () =>
			discussionWithComments([commentNode({ upvoteCount: 0 })]),
		);
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "get_discussion_comments", {
			owner: "o",
			repo: "r",
			discussion_number: 42,
			per_page: 30,
		});
		const body = result.content[0].text;
		expect(body).not.toContain("upvotes");
	});

	it("appends the cursor hint when a next page exists", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () =>
			discussionWithComments([commentNode()], {
				totalCount: 40,
				hasNextPage: true,
				endCursor: "CUR_next",
			}),
		);
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "get_discussion_comments", {
			owner: "o",
			repo: "r",
			discussion_number: 42,
			per_page: 1,
		});
		const body = result.content[0].text;
		expect(body).toContain("(1 of 40 shown; more results exist.");
		expect(body).toContain('cursor: "CUR_next"');
	});

	it("renders an empty state", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => discussionWithComments([]));
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "get_discussion_comments", {
			owner: "o",
			repo: "r",
			discussion_number: 42,
			per_page: 30,
		});
		expect(result.content[0].text).toContain("(no comments found)");
	});

	it("errors when the discussion is not found", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ repository: { discussion: null } }));
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "get_discussion_comments", {
			owner: "o",
			repo: "r",
			discussion_number: 999,
			per_page: 30,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Discussion #999 not found in o/r");
	});

	it("surfaces a GraphQL error through wrapTool", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => {
			throw new Error("boom");
		});
		registerDiscussionTools(server, () => octokit);

		const result = await invoke(handlers, "get_discussion_comments", {
			owner: "o",
			repo: "r",
			discussion_number: 42,
			per_page: 30,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Error: boom");
	});
});
