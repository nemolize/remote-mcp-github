import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	cursorMoreHint,
	errorResult,
	MAX_RESPONSE_CHARS,
	text,
	type ToolResult,
	truncate,
	wrapTool,
} from "../mcp/response.js";
import type { OctokitFactory } from "./common.js";

// Projects v2 has no REST surface — every tool here is GraphQL-backed, following
// the cursor-pagination conventions of list_pr_review_threads in pulls.ts.

/** One project row as returned by a `projectsV2` connection. */
type ProjectListNode = {
	id: string;
	number: number;
	title: string;
	public: boolean;
	closed: boolean;
	updatedAt: string;
};

type ProjectsPage = {
	totalCount: number;
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
	nodes: Array<ProjectListNode | null>;
};

/** A field node from a `fields` connection. `options` only exists on single-select fields. */
type ProjectFieldNode = {
	name: string;
	dataType: string;
	options?: Array<{ id: string; name: string }>;
};

type FieldsPage = {
	totalCount: number;
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
	nodes: Array<ProjectFieldNode | null>;
};

type ProjectItemNode = {
	type: string;
	fieldValueByName: { name?: string } | null;
	content: {
		title?: string;
		number?: number;
		repository?: { nameWithOwner: string };
		assignees?: { nodes: Array<{ login: string } | null> };
	} | null;
};

type ItemsPage = {
	totalCount: number;
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
	nodes: Array<ProjectItemNode | null>;
};

const PROJECTS_PAGE_SELECTION = `
	totalCount
	pageInfo { hasNextPage endCursor }
	nodes { id number title public closed updatedAt }
`;

const LIST_OWNER_PROJECTS_QUERY = `
	query ($owner: String!, $first: Int!, $after: String) {
		repositoryOwner(login: $owner) {
			... on User { projectsV2(first: $first, after: $after) { ${PROJECTS_PAGE_SELECTION} } }
			... on Organization { projectsV2(first: $first, after: $after) { ${PROJECTS_PAGE_SELECTION} } }
		}
	}
`;

const LIST_VIEWER_PROJECTS_QUERY = `
	query ($first: Int!, $after: String) {
		viewer { projectsV2(first: $first, after: $after) { ${PROJECTS_PAGE_SELECTION} } }
	}
`;

// `ProjectV2FieldCommon` covers plain, iteration, and single-select fields;
// only single-select adds `options`.
const FIELD_NODES_SELECTION = `
	nodes {
		... on ProjectV2FieldCommon { name dataType }
		... on ProjectV2SingleSelectField { options { id name } }
	}
`;

const PROJECT_DETAIL_SELECTION = `
	id
	number
	title
	shortDescription
	public
	closed
	template
	updatedAt
	items { totalCount }
	fields(first: 50) {
		totalCount
		${FIELD_NODES_SELECTION}
	}
`;

const PROJECT_FIELDS_SELECTION = `
	number
	title
	fields(first: $first, after: $after) {
		totalCount
		pageInfo { hasNextPage endCursor }
		${FIELD_NODES_SELECTION}
	}
`;

// `fieldValueByName("Status")` targets the default single-select Status column;
// a project that renamed it simply renders no status segment.
const PROJECT_ITEMS_SELECTION = `
	number
	title
	items(first: $first, after: $after) {
		totalCount
		pageInfo { hasNextPage endCursor }
		nodes {
			type
			fieldValueByName(name: "Status") {
				... on ProjectV2ItemFieldSingleSelectValue { name }
			}
			content {
				... on Issue {
					title
					number
					repository { nameWithOwner }
					assignees(first: 5) { nodes { login } }
				}
				... on PullRequest {
					title
					number
					repository { nameWithOwner }
					assignees(first: 5) { nodes { login } }
				}
				... on DraftIssue {
					title
					assignees(first: 5) { nodes { login } }
				}
			}
		}
	}
`;

/**
 * Build the by-node-ID and by-owner+number query pair around a shared
 * selection. `extraVars` carries the pagination variable declarations
 * (`, $first: Int!, $after: String`) for the list tools — GraphQL rejects
 * declared-but-unused variables, so the detail query must omit them.
 */
const projectQueryPair = (
	selection: string,
	extraVars = "",
): { byId: string; byOwner: string } => ({
	byId: `
		query ($id: ID!${extraVars}) {
			node(id: $id) { ... on ProjectV2 { ${selection} } }
		}
	`,
	byOwner: `
		query ($owner: String!, $number: Int!${extraVars}) {
			repositoryOwner(login: $owner) {
				... on User { projectV2(number: $number) { ${selection} } }
				... on Organization { projectV2(number: $number) { ${selection} } }
			}
		}
	`,
});

type ProjectRef = {
	id?: string | undefined;
	owner?: string | undefined;
	number?: number | undefined;
};

const ProjectRefSchema = {
	owner: z
		.string()
		.optional()
		.describe("Project owner (user or organisation login). Pair with `number`."),
	number: z.number().int().positive().optional().describe("Project number. Pair with `owner`."),
	id: z
		.string()
		.min(1)
		.optional()
		.describe("Project node ID (`PVT_...`). Alternative to `owner` + `number`."),
} as const;

const invalidRefError = (): ToolResult =>
	errorResult("Provide either `id` (project node ID) or both `owner` and `number`.");

const notFoundError = (ref: ProjectRef): ToolResult =>
	errorResult(
		`Project ${
			ref.id != null ? `\`${ref.id}\`` : `${ref.owner ?? "?"}/#${ref.number ?? "?"}`
		} not found or not accessible (check the identifier and your token's \`read:project\` scope).`,
	);

/**
 * Fetch a project by node ID or by owner + number. Returns `null` when the
 * identifier resolves to nothing (or to a non-ProjectV2 node — callers detect
 * that via a required selection field such as `title` being absent).
 */
const fetchProject = async <T extends { title?: string }>(
	octo: ReturnType<OctokitFactory>,
	ref: ProjectRef,
	queries: { byId: string; byOwner: string },
	extraVars: Record<string, unknown> = {},
): Promise<T | null> => {
	if (ref.id != null) {
		const result = await octo.graphql<{ node: T | null }>(queries.byId, {
			id: ref.id,
			...extraVars,
		});
		// A non-ProjectV2 node id yields `node: {}` (fragment did not apply).
		return result.node?.title != null ? result.node : null;
	}
	const result = await octo.graphql<{ repositoryOwner: { projectV2: T | null } | null }>(
		queries.byOwner,
		{ owner: ref.owner, number: ref.number, ...extraVars },
	);
	return result.repositoryOwner?.projectV2 ?? null;
};

const CURSOR_INSTRUCTION = (endCursor: string | null): string =>
	`Re-invoke with \`cursor: "${endCursor}"\` to fetch the next page.`;

const PaginationSchema = {
	per_page: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.default(30)
		.describe("Results per page (1-100)."),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Opaque pagination cursor from a previous page's endCursor. Omit for the first page.",
		),
} as const;

/** Render `— options: Name (`id`), …` for a single-select field, or "" otherwise. */
const optionsSuffix = (field: ProjectFieldNode): string =>
	field.options != null && field.options.length > 0
		? ` — options: ${field.options.map((o) => `${o.name} (\`${o.id}\`)`).join(", ")}`
		: "";

const fieldLine = (field: ProjectFieldNode): string =>
	`- ${field.name} — ${field.dataType}${optionsSuffix(field)}`;

const itemLine = (item: ProjectItemNode): string => {
	const title = item.content?.title ?? "(no title)";
	const ref =
		item.content?.repository != null && item.content.number != null
			? ` (${item.content.repository.nameWithOwner}#${item.content.number})`
			: "";
	const status =
		item.fieldValueByName?.name != null ? ` — status: ${item.fieldValueByName.name}` : "";
	const assignees = (item.content?.assignees?.nodes ?? [])
		.filter((a): a is { login: string } => a != null)
		.map((a) => `@${a.login}`)
		.join(", ");
	const assigneeSuffix = assignees === "" ? "" : ` — ${assignees}`;
	return `- ${item.type} — ${title}${ref}${status}${assigneeSuffix}`;
};

/**
 * Render a cursor-paginated list body: truncate within a budget that reserves
 * room for the cursor hint so a large page can never drop the `cursor` (the
 * same #50 discipline as list_pr_review_threads).
 */
const paginatedList = (
	header: string,
	lines: string[],
	page: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null } },
): ToolResult => {
	const more = cursorMoreHint({
		shown: lines.length,
		total: page.totalCount,
		hasMore: page.pageInfo.hasNextPage && page.pageInfo.endCursor != null,
		nextPageInstruction: CURSOR_INSTRUCTION(page.pageInfo.endCursor),
	});
	const body = truncate(`${header}\n\n${lines.join("\n")}`, MAX_RESPONSE_CHARS - more.length);
	return text(`${body}${more}`);
};

export const registerProjectTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"list_projects",
		{
			description:
				"List GitHub Projects (v2) owned by a user or organisation, or by the authenticated user when `owner` is omitted. Returns number, title, visibility, open/closed state, updated date, and node ID (`PVT_...`) per project. Cursor pagination via `cursor`. Requires the `read:project` scope.",
			inputSchema: {
				owner: z
					.string()
					.optional()
					.describe("User or organisation login. Omit to list the authenticated user's projects."),
				...PaginationSchema,
			},
		},
		async ({ owner, per_page, cursor }) =>
			wrapTool(async () => {
				const vars = { first: per_page, after: cursor };
				let page: ProjectsPage;
				let label: string;
				if (owner != null) {
					const result = await client().graphql<{
						repositoryOwner: { projectsV2?: ProjectsPage } | null;
					}>(LIST_OWNER_PROJECTS_QUERY, { owner, ...vars });
					if (result.repositoryOwner?.projectsV2 == null) {
						return errorResult(
							`Owner ${owner} not found or has no accessible projects (check the login and your token's \`read:project\` scope).`,
						);
					}
					page = result.repositoryOwner.projectsV2;
					label = owner;
				} else {
					const result = await client().graphql<{ viewer: { projectsV2: ProjectsPage } }>(
						LIST_VIEWER_PROJECTS_QUERY,
						vars,
					);
					page = result.viewer.projectsV2;
					label = "the authenticated user";
				}
				const projects = page.nodes.filter((n): n is ProjectListNode => n != null);
				if (projects.length === 0) {
					return text(`# Projects for ${label}\n\nNo projects.`);
				}
				const lines = projects.map(
					(p) =>
						`- #${p.number} ${p.title} — ${p.public ? "public" : "private"}, ${
							p.closed ? "closed" : "open"
						} — updated ${p.updatedAt} — id: \`${p.id}\``,
				);
				return paginatedList(`# Projects for ${label} (${projects.length})`, lines, page);
			}),
	);

	server.registerTool(
		"get_project",
		{
			description:
				"Get one GitHub Project (v2) in detail — title, description, visibility, open/closed/template state, item count, updated date, and its field definitions (single-select options included). Identify the project by `owner` + `number`, or by node ID (`id`, `PVT_...`) from list_projects. Requires the `read:project` scope.",
			inputSchema: ProjectRefSchema,
		},
		async ({ owner, number, id }) =>
			wrapTool(async () => {
				if (id == null && (owner == null || number == null)) return invalidRefError();
				type Detail = {
					id: string;
					number: number;
					title: string;
					shortDescription: string | null;
					public: boolean;
					closed: boolean;
					template: boolean;
					updatedAt: string;
					items: { totalCount: number };
					fields: { totalCount: number; nodes: Array<ProjectFieldNode | null> };
				};
				const project = await fetchProject<Detail>(
					client(),
					{ id, owner, number },
					projectQueryPair(PROJECT_DETAIL_SELECTION),
				);
				if (project == null) return notFoundError({ id, owner, number });
				const fields = project.fields.nodes.filter((n): n is ProjectFieldNode => n != null);
				const meta = [
					`- id: \`${project.id}\``,
					`- visibility: ${project.public ? "public" : "private"}`,
					`- state: ${project.closed ? "closed" : "open"}${project.template ? " (template)" : ""}`,
					`- items: ${project.items.totalCount}`,
					`- updated: ${project.updatedAt}`,
					...(project.shortDescription != null && project.shortDescription !== ""
						? [`- description: ${project.shortDescription}`]
						: []),
				];
				const body = [
					`# Project #${project.number}: ${project.title}`,
					"",
					...meta,
					"",
					`## Fields (${project.fields.totalCount})`,
					"",
					...fields.map(fieldLine),
				].join("\n");
				return text(truncate(body));
			}),
	);

	server.registerTool(
		"list_project_items",
		{
			description:
				"List the items on a GitHub Project (v2) board — one row per item with its content type (ISSUE / PULL_REQUEST / DRAFT_ISSUE), title, linked `owner/repo#number` where applicable, Status field value, and assignees. Identify the project by `owner` + `number`, or by node ID (`id`). Cursor pagination via `cursor`. Requires the `read:project` scope.",
			inputSchema: { ...ProjectRefSchema, ...PaginationSchema },
		},
		async ({ owner, number, id, per_page, cursor }) =>
			wrapTool(async () => {
				if (id == null && (owner == null || number == null)) return invalidRefError();
				type ItemsProject = { number: number; title: string; items: ItemsPage };
				const project = await fetchProject<ItemsProject>(
					client(),
					{ id, owner, number },
					projectQueryPair(PROJECT_ITEMS_SELECTION, ", $first: Int!, $after: String"),
					{ first: per_page, after: cursor },
				);
				if (project == null) return notFoundError({ id, owner, number });
				const items = project.items.nodes.filter((n): n is ProjectItemNode => n != null);
				const header = `# Project #${project.number} "${project.title}" — items`;
				if (items.length === 0) {
					return text(`${header}\n\nNo items.`);
				}
				return paginatedList(`${header} (${items.length})`, items.map(itemLine), project.items);
			}),
	);

	server.registerTool(
		"list_project_fields",
		{
			description:
				"List the field definitions of a GitHub Project (v2) — one row per field with its name, data type, and (for single-select fields) the option names + option IDs. Identify the project by `owner` + `number`, or by node ID (`id`). Cursor pagination via `cursor`. Requires the `read:project` scope.",
			inputSchema: { ...ProjectRefSchema, ...PaginationSchema },
		},
		async ({ owner, number, id, per_page, cursor }) =>
			wrapTool(async () => {
				if (id == null && (owner == null || number == null)) return invalidRefError();
				type FieldsProject = { number: number; title: string; fields: FieldsPage };
				const project = await fetchProject<FieldsProject>(
					client(),
					{ id, owner, number },
					projectQueryPair(PROJECT_FIELDS_SELECTION, ", $first: Int!, $after: String"),
					{ first: per_page, after: cursor },
				);
				if (project == null) return notFoundError({ id, owner, number });
				const fields = project.fields.nodes.filter((n): n is ProjectFieldNode => n != null);
				const header = `# Project #${project.number} "${project.title}" — fields`;
				if (fields.length === 0) {
					return text(`${header}\n\nNo fields.`);
				}
				return paginatedList(`${header} (${fields.length})`, fields.map(fieldLine), project.fields);
			}),
	);
};
