import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	errorResult,
	previewLine,
	text,
	type ToolResult,
	truncate,
	wrapTool,
} from "../mcp/response.js";
import {
	type OctokitFactory,
	type Page,
	paginatedList,
	PaginationSchema,
	RepoTarget,
} from "./common.js";

// Discussions has no REST v3 surface — every tool here is GraphQL-backed,
// following the cursor-pagination conventions of projects.ts.

type DiscussionListNode = {
	number: number;
	title: string;
	author: { login: string } | null;
	category: { name: string } | null;
	createdAt: string;
	updatedAt: string;
	// `null` when the discussion's category is not answerable.
	isAnswered: boolean | null;
	upvoteCount: number;
	comments: { totalCount: number };
	url: string;
};

type CategoryNode = {
	id: string;
	name: string;
	slug: string;
	emoji: string;
	description: string | null;
	isAnswerable: boolean;
};

type DiscussionDetail = {
	id: string;
	number: number;
	title: string;
	body: string;
	author: { login: string } | null;
	category: { name: string; isAnswerable: boolean } | null;
	createdAt: string;
	updatedAt: string;
	isAnswered: boolean | null;
	upvoteCount: number;
	comments: { totalCount: number };
	answer: { url: string; author: { login: string } | null } | null;
	url: string;
};

type DiscussionCommentNode = {
	author: { login: string } | null;
	body: string;
	createdAt: string;
	lastEditedAt: string | null;
	url: string;
	isAnswer: boolean;
	upvoteCount: number;
	replies: { totalCount: number };
};

// UPDATED_AT DESC pins the ordering to "most recent activity first" rather than
// relying on the connection's unspecified default.
const LIST_DISCUSSIONS_QUERY = `
	query ($owner: String!, $repo: String!, $first: Int!, $after: String, $categoryId: ID) {
		repository(owner: $owner, name: $repo) {
			discussions(
				first: $first
				after: $after
				categoryId: $categoryId
				orderBy: { field: UPDATED_AT, direction: DESC }
			) {
				totalCount
				pageInfo { hasNextPage endCursor }
				nodes {
					number
					title
					author { login }
					category { name }
					createdAt
					updatedAt
					isAnswered
					upvoteCount
					comments { totalCount }
					url
				}
			}
		}
	}
`;

const LIST_CATEGORIES_QUERY = `
	query ($owner: String!, $repo: String!, $first: Int!, $after: String) {
		repository(owner: $owner, name: $repo) {
			discussionCategories(first: $first, after: $after) {
				totalCount
				pageInfo { hasNextPage endCursor }
				nodes { id name slug emoji description isAnswerable }
			}
		}
	}
`;

const GET_DISCUSSION_QUERY = `
	query ($owner: String!, $repo: String!, $number: Int!) {
		repository(owner: $owner, name: $repo) {
			discussion(number: $number) {
				id
				number
				title
				body
				author { login }
				category { name isAnswerable }
				createdAt
				updatedAt
				isAnswered
				upvoteCount
				comments { totalCount }
				answer { url author { login } }
				url
			}
		}
	}
`;

const GET_DISCUSSION_COMMENTS_QUERY = `
	query ($owner: String!, $repo: String!, $number: Int!, $first: Int!, $after: String) {
		repository(owner: $owner, name: $repo) {
			discussion(number: $number) {
				number
				title
				comments(first: $first, after: $after) {
					totalCount
					pageInfo { hasNextPage endCursor }
					nodes {
						author { login }
						body
						createdAt
						lastEditedAt
						url
						isAnswer
						upvoteCount
						replies { totalCount }
					}
				}
			}
		}
	}
`;

const repoNotFoundError = (owner: string, repo: string): ToolResult =>
	errorResult(
		`Repository ${owner}/${repo} not found or not accessible (check the name and your token's scopes).`,
	);

const discussionNotFoundError = (owner: string, repo: string, number: number): ToolResult =>
	errorResult(`Discussion #${number} not found in ${owner}/${repo}.`);

const authorLogin = (author: { login: string } | null): string =>
	author != null ? `@${author.login}` : "(unknown)";

const discussionLine = (d: DiscussionListNode): string => {
	const category = d.category != null ? ` [${d.category.name}]` : "";
	const answered = d.isAnswered == null ? "" : d.isAnswered ? " — answered" : " — unanswered";
	return `- #${d.number} **${d.title}**${category} by ${authorLogin(d.author)}${answered} — ${d.comments.totalCount} comments, ${d.upvoteCount} upvotes — updated ${d.updatedAt}\n  - ${d.url}`;
};

const categoryLine = (c: CategoryNode): string => {
	const desc = c.description != null && c.description.length > 0 ? ` — ${c.description}` : "";
	const answerable = c.isAnswerable ? " — answerable (Q&A)" : "";
	return `- ${c.emoji} **${c.name}** (\`${c.slug}\`)${answerable}${desc} — id: \`${c.id}\``;
};

export const registerDiscussionTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"list_discussions",
		{
			description:
				"List discussions in a repository, most recently updated first. Use when the user asks to browse, find, or check GitHub Discussions. Optionally filter by category via `category_id` (a `DIC_...` node ID from list_discussion_categories). Returns number, title, category, author, answered state, comment/upvote counts, and URL per discussion. Cursor pagination via `cursor`.",
			inputSchema: {
				...RepoTarget,
				category_id: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Discussion category node ID (`DIC_...`) to filter by. Discover via list_discussion_categories.",
					),
				...PaginationSchema,
			},
		},
		async ({ owner, repo, category_id, per_page, cursor }) =>
			wrapTool(async () => {
				const result = await client().graphql<{
					repository: { discussions: Page<DiscussionListNode> } | null;
				}>(LIST_DISCUSSIONS_QUERY, {
					owner,
					repo,
					first: per_page,
					after: cursor,
					categoryId: category_id,
				});
				if (result.repository == null) return repoNotFoundError(owner, repo);
				const page = result.repository.discussions;
				const discussions = page.nodes.filter((n): n is DiscussionListNode => n != null);
				const header = `# Discussions in ${owner}/${repo}`;
				if (discussions.length === 0) {
					return text(`${header}\n\nNo discussions found.`);
				}
				return paginatedList(
					`${header} (${discussions.length})`,
					discussions.map(discussionLine),
					page,
				);
			}),
	);

	server.registerTool(
		"list_discussion_categories",
		{
			description:
				"List the discussion categories defined in a repository. Use before filtering list_discussions by category — the rendered `DIC_...` node ID is what its `category_id` expects. Returns name, slug, emoji, answerable (Q&A) flag, description, and node ID per category. Cursor pagination via `cursor`.",
			inputSchema: { ...RepoTarget, ...PaginationSchema },
		},
		async ({ owner, repo, per_page, cursor }) =>
			wrapTool(async () => {
				const result = await client().graphql<{
					repository: { discussionCategories: Page<CategoryNode> } | null;
				}>(LIST_CATEGORIES_QUERY, { owner, repo, first: per_page, after: cursor });
				if (result.repository == null) return repoNotFoundError(owner, repo);
				const page = result.repository.discussionCategories;
				const categories = page.nodes.filter((n): n is CategoryNode => n != null);
				const header = `# Discussion categories in ${owner}/${repo}`;
				if (categories.length === 0) {
					return text(`${header}\n\nNo discussion categories (Discussions may be disabled).`);
				}
				return paginatedList(
					`${header} (${categories.length})`,
					categories.map(categoryLine),
					page,
				);
			}),
	);

	server.registerTool(
		"get_discussion",
		{
			description:
				"Fetch a single discussion's details. Use when the user asks to read, view, or inspect a discussion by number. Returns title, author, category, answered state (with a link to the accepted answer when one exists), comment/upvote counts, timestamps, URL, and the (possibly truncated) body.",
			inputSchema: {
				...RepoTarget,
				discussion_number: z.number().int().positive().describe("Discussion number to fetch."),
			},
		},
		async ({ owner, repo, discussion_number }) =>
			wrapTool(async () => {
				const result = await client().graphql<{
					repository: { discussion: DiscussionDetail | null } | null;
				}>(GET_DISCUSSION_QUERY, { owner, repo, number: discussion_number });
				if (result.repository == null) return repoNotFoundError(owner, repo);
				const d = result.repository.discussion;
				if (d == null) return discussionNotFoundError(owner, repo, discussion_number);
				const answered =
					d.isAnswered == null
						? []
						: d.isAnswered
							? [
									`- answered: yes${
										d.answer != null
											? ` — by ${authorLogin(d.answer.author)} (${d.answer.url})`
											: ""
									}`,
								]
							: ["- answered: no"];
				const body = d.body.length > 0 ? d.body : "(no body)";
				const lines = [
					`# Discussion #${d.number}: ${d.title}`,
					"",
					`- author: ${authorLogin(d.author)}`,
					`- category: ${d.category != null ? d.category.name : "(none)"}`,
					...answered,
					`- comments: ${d.comments.totalCount}`,
					`- upvotes: ${d.upvoteCount}`,
					`- created: ${d.createdAt}`,
					`- updated: ${d.updatedAt}`,
					`- url: ${d.url}`,
					"",
					"## Body",
					"",
					body,
				];
				return text(truncate(lines.join("\n")));
			}),
	);

	server.registerTool(
		"get_discussion_comments",
		{
			description:
				"List top-level comments on a discussion. Use when the user asks to read the replies or conversation on a discussion. Returns one bullet per comment with author, timestamp, reply/upvote counts, an accepted-answer marker where applicable, URL, and a short body preview. Cursor pagination via `cursor`.",
			inputSchema: {
				...RepoTarget,
				discussion_number: z
					.number()
					.int()
					.positive()
					.describe("Discussion number whose comments to list."),
				...PaginationSchema,
			},
		},
		async ({ owner, repo, discussion_number, per_page, cursor }) =>
			wrapTool(async () => {
				const result = await client().graphql<{
					repository: {
						discussion: {
							number: number;
							title: string;
							comments: Page<DiscussionCommentNode>;
						} | null;
					} | null;
				}>(GET_DISCUSSION_COMMENTS_QUERY, {
					owner,
					repo,
					number: discussion_number,
					first: per_page,
					after: cursor,
				});
				if (result.repository == null) return repoNotFoundError(owner, repo);
				const discussion = result.repository.discussion;
				if (discussion == null) return discussionNotFoundError(owner, repo, discussion_number);
				const comments = discussion.comments.nodes.filter(
					(n): n is DiscussionCommentNode => n != null,
				);
				const header = `# Comments on discussion #${discussion.number} "${discussion.title}"`;
				if (comments.length === 0) {
					return text(`${header}\n\n(no comments found)`);
				}
				// Each comment is a one-line preview (whitespace collapsed, 200-char cap),
				// matching list_issue_comments; fetch the discussion page for full text.
				const lines = comments.map((c) => {
					const preview = previewLine(c.body);
					const ts =
						c.lastEditedAt != null ? `${c.lastEditedAt} (created ${c.createdAt})` : c.createdAt;
					const answer = c.isAnswer ? " — ✓ accepted answer" : "";
					const replies = c.replies.totalCount > 0 ? ` — ${c.replies.totalCount} replies` : "";
					return `- ${authorLogin(c.author)} — ${ts}${answer}${replies} — ${c.url}\n  - ${preview.length > 0 ? preview : "(empty)"}`;
				});
				return paginatedList(`${header} (${comments.length})`, lines, discussion.comments);
			}),
	);
};
