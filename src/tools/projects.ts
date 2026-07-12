import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	errorResult,
	logWrite,
	previewLine,
	text,
	type ToolResult,
	truncate,
	wrapTool,
} from "../mcp/response.js";
import { stripUndefined } from "../utils.js";
import {
	MAX_TEXT_FIELD_LENGTH,
	maxCharsMessage,
	type OctokitFactory,
	type Page,
	paginatedList,
	PaginationSchema,
} from "./common.js";

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

/** A field node from a `fields` connection. `options` only exists on single-select fields. */
type ProjectFieldNode = {
	id: string;
	name: string;
	dataType: string;
	options?: Array<{ id: string; name: string }>;
};

type ProjectItemNode = {
	id: string;
	type: string;
	isArchived: boolean;
	fieldValueByName: { name?: string } | null;
	content: {
		title?: string;
		number?: number;
		repository?: { nameWithOwner: string };
		assignees?: { totalCount: number; nodes: Array<{ login: string } | null> };
	} | null;
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
		... on ProjectV2FieldCommon { id name dataType }
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
// `archivedStates` defaults to [NOT_ARCHIVED] on the API side; the variable is
// only supplied when the caller opts in to seeing archived items.
const PROJECT_ITEMS_SELECTION = `
	number
	title
	items(first: $first, after: $after, archivedStates: $archivedStates) {
		totalCount
		pageInfo { hasNextPage endCursor }
		nodes {
			id
			type
			isArchived
			fieldValueByName(name: "Status") {
				... on ProjectV2ItemFieldSingleSelectValue { name }
			}
			content {
				... on Issue {
					title
					number
					repository { nameWithOwner }
					assignees(first: 5) { totalCount nodes { login } }
				}
				... on PullRequest {
					title
					number
					repository { nameWithOwner }
					assignees(first: 5) { totalCount nodes { login } }
				}
				... on DraftIssue {
					title
					assignees(first: 5) { totalCount nodes { login } }
				}
			}
		}
	}
`;

/** Pagination variable declarations appended to a list tool's query signature. */
const PAGINATION_VARS = ", $first: Int!, $after: String";

/** Extra variable declaration for list_project_items' archived-state opt-in. */
const ARCHIVED_STATES_VAR = ", $archivedStates: [ProjectV2ItemArchivedState!]";

/**
 * Build the by-node-ID and by-owner+number query pair around a shared
 * selection. `extraVars` carries `PAGINATION_VARS` for the list tools —
 * GraphQL rejects declared-but-unused variables, so the detail query must
 * omit them.
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
		.describe("Project node ID (`PVT_...`). Mutually exclusive with `owner` + `number`."),
} as const;

/** `null` when the ref is usable; the shared invalid-ref error otherwise. */
const refValidationError = (ref: ProjectRef): ToolResult | null => {
	if (ref.id != null && (ref.owner != null || ref.number != null)) {
		return errorResult("Pass either `id` or `owner` + `number`, not both.");
	}
	if (ref.id == null && (ref.owner == null || ref.number == null)) {
		return errorResult("Provide either `id` (project node ID) or both `owner` and `number`.");
	}
	return null;
};

const notFoundError = (ref: ProjectRef): ToolResult =>
	errorResult(
		`Project ${
			ref.id != null ? `\`${ref.id}\`` : `${ref.owner ?? "?"}/#${ref.number ?? "?"}`
		} not found or not accessible (check the identifier and your token's Projects scope — \`read:project\` for reads, \`project\` for writes).`,
	);

/**
 * Fetch a project by node ID or by owner + number. Returns `null` when the
 * identifier resolves to nothing or to a non-ProjectV2 node — the required
 * `title` constraint forces every selection to include the field that check
 * relies on.
 */
const fetchProject = async <T extends { title: string }>(
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

type ResolvedProject<T> = { project: T } | { error: ToolResult };

/**
 * The ref-validate → fetch → not-found prologue every project tool shares.
 * Callers narrow with `"error" in resolved`.
 */
const resolveProject = async <T extends { title: string }>(
	octo: ReturnType<OctokitFactory>,
	ref: ProjectRef,
	queries: { byId: string; byOwner: string },
	extraVars: Record<string, unknown> = {},
): Promise<ResolvedProject<T>> => {
	const refError = refValidationError(ref);
	if (refError != null) return { error: refError };
	const project = await fetchProject<T>(octo, ref, queries, extraVars);
	if (project == null) return { error: notFoundError(ref) };
	return { project };
};

// Every write resolves the project first: the mutation needs `id`, the
// rendering needs `number` + `title`, and the audit line needs the owner login.
const PROJECT_WRITE_SELECTION = `
	id
	number
	title
	owner {
		... on User { login }
		... on Organization { login }
	}
`;

type ProjectWriteTarget = {
	id: string;
	number: number;
	title: string;
	owner: { login?: string } | null;
};

const resolveProjectForWrite = (
	octo: ReturnType<OctokitFactory>,
	ref: ProjectRef,
): Promise<ResolvedProject<ProjectWriteTarget>> =>
	resolveProject<ProjectWriteTarget>(octo, ref, projectQueryPair(PROJECT_WRITE_SELECTION));

const ADD_PROJECT_ITEM_MUTATION = `
	mutation ($projectId: ID!, $contentId: ID!) {
		addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
			item {
				id
				type
				content {
					... on Issue { title number repository { nameWithOwner } }
					... on PullRequest { title number repository { nameWithOwner } }
				}
			}
		}
	}
`;

const DELETE_PROJECT_ITEM_MUTATION = `
	mutation ($projectId: ID!, $itemId: ID!) {
		deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
			deletedItemId
		}
	}
`;

const UPDATE_PROJECT_ITEM_FIELD_MUTATION = `
	mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
		updateProjectV2ItemFieldValue(
			input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }
		) {
			projectV2Item { id }
		}
	}
`;

const ADD_PROJECT_DRAFT_ISSUE_MUTATION = `
	mutation ($projectId: ID!, $title: String!, $body: String) {
		addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body }) {
			projectItem { id }
		}
	}
`;

const CREATE_PROJECT_MUTATION = `
	mutation ($ownerId: ID!, $title: String!) {
		createProjectV2(input: { ownerId: $ownerId, title: $title }) {
			projectV2 { ${PROJECT_WRITE_SELECTION} }
		}
	}
`;

const UPDATE_PROJECT_MUTATION = `
	mutation ($projectId: ID!, $title: String, $shortDescription: String, $public: Boolean, $closed: Boolean) {
		updateProjectV2(
			input: {
				projectId: $projectId
				title: $title
				shortDescription: $shortDescription
				public: $public
				closed: $closed
			}
		) {
			projectV2 { id number title public closed }
		}
	}
`;

const DELETE_PROJECT_MUTATION = `
	mutation ($projectId: ID!) {
		deleteProjectV2(input: { projectId: $projectId }) {
			projectV2 { id number title }
		}
	}
`;

const COPY_PROJECT_MUTATION = `
	mutation ($projectId: ID!, $ownerId: ID!, $title: String!, $includeDraftIssues: Boolean) {
		copyProjectV2(
			input: {
				projectId: $projectId
				ownerId: $ownerId
				title: $title
				includeDraftIssues: $includeDraftIssues
			}
		) {
			projectV2 { ${PROJECT_WRITE_SELECTION} }
		}
	}
`;

const LINK_PROJECT_MUTATION = `
	mutation ($projectId: ID!, $repositoryId: ID!) {
		linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
			repository { nameWithOwner }
		}
	}
`;

const UNLINK_PROJECT_MUTATION = `
	mutation ($projectId: ID!, $repositoryId: ID!) {
		unlinkProjectV2FromRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
			repository { nameWithOwner }
		}
	}
`;

const FIELD_RESULT_SELECTION = `
	... on ProjectV2FieldCommon { id name dataType }
	... on ProjectV2SingleSelectField { options { id name } }
`;

const CREATE_PROJECT_FIELD_MUTATION = `
	mutation ($projectId: ID!, $dataType: ProjectV2CustomFieldType!, $name: String!, $singleSelectOptions: [ProjectV2SingleSelectFieldOptionInput!]) {
		createProjectV2Field(
			input: {
				projectId: $projectId
				dataType: $dataType
				name: $name
				singleSelectOptions: $singleSelectOptions
			}
		) {
			projectV2Field { ${FIELD_RESULT_SELECTION} }
		}
	}
`;

// The deleted field's parent project is selected so the audit line carries
// owner + project context — an irreversible mutation deserves a full trail.
const DELETE_PROJECT_FIELD_MUTATION = `
	mutation ($fieldId: ID!) {
		deleteProjectV2Field(input: { fieldId: $fieldId }) {
			projectV2Field {
				${FIELD_RESULT_SELECTION}
				... on ProjectV2FieldCommon {
					project {
						id
						owner {
							... on User { login }
							... on Organization { login }
						}
					}
				}
			}
		}
	}
`;

const ARCHIVE_PROJECT_ITEM_MUTATION = `
	mutation ($projectId: ID!, $itemId: ID!) {
		archiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
			item { id }
		}
	}
`;

const UNARCHIVE_PROJECT_ITEM_MUTATION = `
	mutation ($projectId: ID!, $itemId: ID!) {
		unarchiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
			item { id }
		}
	}
`;

const OWNER_ID_QUERY = `
	query ($owner: String!) {
		repositoryOwner(login: $owner) { id login }
	}
`;

const VIEWER_ID_QUERY = `
	query {
		viewer { id login }
	}
`;

const REPOSITORY_ID_QUERY = `
	query ($owner: String!, $name: String!) {
		repository(owner: $owner, name: $name) { id nameWithOwner }
	}
`;

type OwnerNode = { id: string; login: string };

/**
 * Resolve a login — or the authenticated viewer when omitted — to the node ID
 * that ownerId-taking mutations (createProjectV2, copyProjectV2) require.
 * Returns `null` when the login does not resolve.
 */
const resolveOwnerId = async (
	octo: ReturnType<OctokitFactory>,
	owner: string | undefined,
): Promise<OwnerNode | null> => {
	if (owner == null) {
		const result = await octo.graphql<{ viewer: OwnerNode }>(VIEWER_ID_QUERY);
		return result.viewer;
	}
	const result = await octo.graphql<{ repositoryOwner: OwnerNode | null }>(OWNER_ID_QUERY, {
		owner,
	});
	return result.repositoryOwner;
};

const ownerNotFoundError = (owner: string): ToolResult =>
	errorResult(`Owner ${owner} not found (check the user or organisation login).`);

type AddedProjectItem = {
	id: string;
	type: string;
	content: { title?: string; number?: number; repository?: { nameWithOwner: string } } | null;
};

const ItemIdSchema = z
	.string()
	.min(1)
	.describe("Project item node ID (`PVTI_...`). Discover via list_project_items.");

type FieldValueInput = {
	text?: string | undefined;
	number?: number | undefined;
	date?: string | undefined;
	single_select_option_id?: string | undefined;
};

// Mirrors GraphQL's ProjectV2FieldValue one-of input; the exactly-one guard
// lives in the handler because a raw-shape schema can't express it (same
// pattern as refValidationError).
const FieldValueSchema = z
	.object({
		text: z
			.string()
			.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Field text", MAX_TEXT_FIELD_LENGTH))
			.optional()
			.describe("New value for a TEXT (or TITLE) field."),
		number: z.number().optional().describe("New value for a NUMBER field."),
		date: z
			.string()
			.min(1)
			.optional()
			.describe("New value for a DATE field, as an ISO 8601 date (e.g. 2026-07-08)."),
		single_select_option_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Option ID for a SINGLE_SELECT field. Discover option IDs via list_project_fields.",
			),
	})
	.describe("The value to set. Provide exactly one of the four value forms.");

/** `null` when exactly one value form is present; the shared error otherwise. */
const fieldValueValidationError = (value: FieldValueInput): ToolResult | null => {
	const provided = [value.text, value.number, value.date, value.single_select_option_id].filter(
		(v) => v != null,
	);
	if (provided.length !== 1) {
		return errorResult(
			"Provide exactly one of `value.text`, `value.number`, `value.date`, or `value.single_select_option_id`.",
		);
	}
	return null;
};

const renderFieldValue = (value: FieldValueInput): string => {
	if (value.text != null) return `text "${previewLine(value.text, 80)}"`;
	if (value.number != null) return `number ${value.number}`;
	if (value.date != null) return `date ${value.date}`;
	return `option \`${value.single_select_option_id}\``;
};

/** Render `— options: Name (`id`), …` for a single-select field, or "" otherwise. */
const optionsSuffix = (field: ProjectFieldNode): string =>
	field.options != null && field.options.length > 0
		? ` — options: ${field.options.map((o) => `${o.name} (\`${o.id}\`)`).join(", ")}`
		: "";

// The trailing field node ID is what update_project_item_field's `field_id`
// expects — without it the discovery chain from list_project_fields is broken.
const fieldLine = (field: ProjectFieldNode): string =>
	`- ${field.name} — ${field.dataType}${optionsSuffix(field)} — id: \`${field.id}\``;

const itemLine = (item: ProjectItemNode): string => {
	const title = item.content?.title ?? "(no title)";
	const ref =
		item.content?.repository != null && item.content.number != null
			? ` (${item.content.repository.nameWithOwner}#${item.content.number})`
			: "";
	const status =
		item.fieldValueByName?.name != null ? ` — status: ${item.fieldValueByName.name}` : "";
	const assigneeList = (item.content?.assignees?.nodes ?? []).filter(
		(a): a is { login: string } => a != null,
	);
	const assignees = assigneeList.map((a) => `@${a.login}`).join(", ");
	// The query caps assignees at first: 5 — flag anything beyond it.
	const total = item.content?.assignees?.totalCount ?? assigneeList.length;
	const overflow = total > assigneeList.length ? ` +${total - assigneeList.length} more` : "";
	const assigneeSuffix = assignees === "" ? "" : ` — ${assignees}${overflow}`;
	// The archived marker keeps archived rows (surfaced via include_archived)
	// distinguishable — their node ID is what archive_project_item's undo needs.
	const archived = item.isArchived ? " — archived" : "";
	// The trailing item node ID is what remove_project_item and
	// update_project_item_field expect as `item_id`.
	return `- ${item.type} — ${title}${ref}${status}${assigneeSuffix}${archived} — id: \`${item.id}\``;
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
				let page: Page<ProjectListNode>;
				let label: string;
				if (owner != null) {
					const result = await client().graphql<{
						repositoryOwner: { projectsV2?: Page<ProjectListNode> } | null;
					}>(LIST_OWNER_PROJECTS_QUERY, { owner, ...vars });
					if (result.repositoryOwner?.projectsV2 == null) {
						return errorResult(
							`Owner ${owner} not found or has no accessible projects (check the login and your token's \`read:project\` scope).`,
						);
					}
					page = result.repositoryOwner.projectsV2;
					label = owner;
				} else {
					const result = await client().graphql<{ viewer: { projectsV2: Page<ProjectListNode> } }>(
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
				const resolved = await resolveProject<Detail>(
					client(),
					{ id, owner, number },
					projectQueryPair(PROJECT_DETAIL_SELECTION),
				);
				if ("error" in resolved) return resolved.error;
				const { project } = resolved;
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
					// The detail query pins fields(first: 50); flag anything beyond it.
					...(project.fields.totalCount > fields.length
						? [
								"",
								`(${fields.length} of ${project.fields.totalCount} shown; use list_project_fields to page through the rest.)`,
							]
						: []),
				].join("\n");
				return text(truncate(body));
			}),
	);

	server.registerTool(
		"list_project_items",
		{
			description:
				"List the items on a GitHub Project (v2) board — one row per item with its content type (ISSUE / PULL_REQUEST / DRAFT_ISSUE), title, linked `owner/repo#number` where applicable, Status field value, assignees, and item node ID (`PVTI_...`, usable as remove_project_item / update_project_item_field's `item_id`). Archived items are hidden by default; pass `include_archived: true` to list them too (marked `archived` — their node ID is what archive_project_item's `undo` needs). Identify the project by `owner` + `number`, or by node ID (`id`). Cursor pagination via `cursor`. Requires the `read:project` scope.",
			inputSchema: {
				...ProjectRefSchema,
				...PaginationSchema,
				include_archived: z
					.boolean()
					.optional()
					.describe("Also list archived items (marked `archived` in the output)."),
			},
		},
		async ({ owner, number, id, per_page, cursor, include_archived }) =>
			wrapTool(async () => {
				type ItemsProject = { number: number; title: string; items: Page<ProjectItemNode> };
				const resolved = await resolveProject<ItemsProject>(
					client(),
					{ id, owner, number },
					projectQueryPair(PROJECT_ITEMS_SELECTION, PAGINATION_VARS + ARCHIVED_STATES_VAR),
					{
						first: per_page,
						after: cursor,
						// Omitted → the argument-level default ([NOT_ARCHIVED]) applies.
						archivedStates: include_archived === true ? ["ARCHIVED", "NOT_ARCHIVED"] : undefined,
					},
				);
				if ("error" in resolved) return resolved.error;
				const { project } = resolved;
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
				"List the field definitions of a GitHub Project (v2) — one row per field with its name, data type, field node ID (usable as update_project_item_field's `field_id`), and (for single-select fields) the option names + option IDs. Identify the project by `owner` + `number`, or by node ID (`id`). Cursor pagination via `cursor`. Requires the `read:project` scope.",
			inputSchema: { ...ProjectRefSchema, ...PaginationSchema },
		},
		async ({ owner, number, id, per_page, cursor }) =>
			wrapTool(async () => {
				type FieldsProject = { number: number; title: string; fields: Page<ProjectFieldNode> };
				const resolved = await resolveProject<FieldsProject>(
					client(),
					{ id, owner, number },
					projectQueryPair(PROJECT_FIELDS_SELECTION, PAGINATION_VARS),
					{ first: per_page, after: cursor },
				);
				if ("error" in resolved) return resolved.error;
				const { project } = resolved;
				const fields = project.fields.nodes.filter((n): n is ProjectFieldNode => n != null);
				const header = `# Project #${project.number} "${project.title}" — fields`;
				if (fields.length === 0) {
					return text(`${header}\n\nNo fields.`);
				}
				return paginatedList(`${header} (${fields.length})`, fields.map(fieldLine), project.fields);
			}),
	);

	server.registerTool(
		"add_project_item",
		{
			description:
				"Add an existing issue or pull request to a GitHub Project (v2) by its content node ID (`I_...` / `PR_...`, surfaced by get_issue / get_pull_request). Identify the project by `owner` + `number`, or by node ID (`id`). Returns the new item's node ID (`PVTI_...`). Requires the `project` scope.",
			inputSchema: {
				...ProjectRefSchema,
				content_id: z
					.string()
					.min(1)
					.describe("GraphQL node ID of the issue or pull request to add (`I_...` / `PR_...`)."),
			},
		},
		async ({ owner, number, id, content_id }) =>
			wrapTool(async () => {
				const octo = client();
				const resolved = await resolveProjectForWrite(octo, { id, owner, number });
				if ("error" in resolved) return resolved.error;
				const { project } = resolved;
				const result = await octo.graphql<{
					addProjectV2ItemById: { item: AddedProjectItem | null };
				}>(ADD_PROJECT_ITEM_MUTATION, { projectId: project.id, contentId: content_id });
				const item = result.addProjectV2ItemById.item;
				if (item == null) {
					return errorResult(`Failed to add \`${content_id}\` to project #${project.number}.`);
				}
				logWrite(
					stripUndefined({
						tool: "add_project_item",
						owner: project.owner?.login,
						project_id: project.id,
						content_id,
						item_id: item.id,
					}),
				);
				const contentRef =
					item.content?.repository != null && item.content.number != null
						? ` (${item.content.repository.nameWithOwner}#${item.content.number})`
						: "";
				return text(
					`Added ${item.type} — ${item.content?.title ?? "(no title)"}${contentRef} to project #${project.number} "${project.title}". Item ID: \`${item.id}\`.`,
				);
			}),
	);

	server.registerTool(
		"remove_project_item",
		{
			description:
				"Remove an item from a GitHub Project (v2) by its item node ID (`PVTI_...`, surfaced by list_project_items). Removing an issue/PR item does not delete the underlying issue or PR; removing a draft item deletes the draft. Identify the project by `owner` + `number`, or by node ID (`id`). Requires the `project` scope.",
			inputSchema: { ...ProjectRefSchema, item_id: ItemIdSchema },
		},
		async ({ owner, number, id, item_id }) =>
			wrapTool(async () => {
				const octo = client();
				const resolved = await resolveProjectForWrite(octo, { id, owner, number });
				if ("error" in resolved) return resolved.error;
				const { project } = resolved;
				const result = await octo.graphql<{
					deleteProjectV2Item: { deletedItemId: string | null };
				}>(DELETE_PROJECT_ITEM_MUTATION, { projectId: project.id, itemId: item_id });
				if (result.deleteProjectV2Item.deletedItemId == null) {
					return errorResult(
						`Failed to remove item \`${item_id}\` from project #${project.number}.`,
					);
				}
				logWrite(
					stripUndefined({
						tool: "remove_project_item",
						owner: project.owner?.login,
						project_id: project.id,
						item_id,
					}),
				);
				return text(
					`Removed item \`${item_id}\` from project #${project.number} "${project.title}".`,
				);
			}),
	);

	server.registerTool(
		"update_project_item_field",
		{
			description:
				"Set a field value on a GitHub Project (v2) item. Takes the item node ID (`PVTI_...`, from list_project_items), the field node ID (from list_project_fields), and exactly one value form: `value.text`, `value.number`, `value.date` (ISO 8601), or `value.single_select_option_id`. Identify the project by `owner` + `number`, or by node ID (`id`). Requires the `project` scope.",
			inputSchema: {
				...ProjectRefSchema,
				item_id: ItemIdSchema,
				field_id: z
					.string()
					.min(1)
					.describe("Project field node ID. Discover via list_project_fields."),
				value: FieldValueSchema,
			},
		},
		async ({ owner, number, id, item_id, field_id, value }) =>
			wrapTool(async () => {
				// The explicit ref check keeps ref-error precedence over the value
				// error; resolveProjectForWrite re-runs it (pure, no extra API call).
				const refError = refValidationError({ id, owner, number });
				if (refError != null) return refError;
				const valueError = fieldValueValidationError(value);
				if (valueError != null) return valueError;
				const octo = client();
				const resolved = await resolveProjectForWrite(octo, { id, owner, number });
				if ("error" in resolved) return resolved.error;
				const { project } = resolved;
				const mutationValue =
					value.text != null
						? { text: value.text }
						: value.number != null
							? { number: value.number }
							: value.date != null
								? { date: value.date }
								: { singleSelectOptionId: value.single_select_option_id };
				const result = await octo.graphql<{
					updateProjectV2ItemFieldValue: { projectV2Item: { id: string } | null };
				}>(UPDATE_PROJECT_ITEM_FIELD_MUTATION, {
					projectId: project.id,
					itemId: item_id,
					fieldId: field_id,
					value: mutationValue,
				});
				if (result.updateProjectV2ItemFieldValue.projectV2Item == null) {
					return errorResult(
						`Failed to update field \`${field_id}\` on item \`${item_id}\` in project #${project.number}.`,
					);
				}
				logWrite(
					stripUndefined({
						tool: "update_project_item_field",
						owner: project.owner?.login,
						project_id: project.id,
						item_id,
						field_id,
					}),
				);
				return text(
					`Updated field \`${field_id}\` on item \`${item_id}\` in project #${project.number} "${project.title}" to ${renderFieldValue(value)}.`,
				);
			}),
	);

	server.registerTool(
		"create_project_draft_item",
		{
			description:
				"Add a draft item (title + optional body) to a GitHub Project (v2) without creating an underlying issue. Identify the project by `owner` + `number`, or by node ID (`id`). Returns the new item's node ID (`PVTI_...`). Requires the `project` scope.",
			inputSchema: {
				...ProjectRefSchema,
				title: z
					.string()
					.min(1)
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Draft title", MAX_TEXT_FIELD_LENGTH))
					.describe("Title of the draft item."),
				body: z
					.string()
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Draft body", MAX_TEXT_FIELD_LENGTH))
					.optional()
					.describe("Markdown body of the draft item."),
			},
		},
		async ({ owner, number, id, title, body }) =>
			wrapTool(async () => {
				const octo = client();
				const resolved = await resolveProjectForWrite(octo, { id, owner, number });
				if ("error" in resolved) return resolved.error;
				const { project } = resolved;
				const result = await octo.graphql<{
					addProjectV2DraftIssue: { projectItem: { id: string } | null };
				}>(ADD_PROJECT_DRAFT_ISSUE_MUTATION, { projectId: project.id, title, body });
				const item = result.addProjectV2DraftIssue.projectItem;
				if (item == null) {
					return errorResult(`Failed to create a draft item in project #${project.number}.`);
				}
				logWrite(
					stripUndefined({
						tool: "create_project_draft_item",
						owner: project.owner?.login,
						project_id: project.id,
						item_id: item.id,
					}),
				);
				return text(
					`Created draft item "${previewLine(title, 120)}" in project #${project.number} "${project.title}". Item ID: \`${item.id}\`.`,
				);
			}),
	);

	server.registerTool(
		"create_project",
		{
			description:
				"Create a GitHub Project (v2) owned by a user or organisation (`owner`), or by the authenticated user when `owner` is omitted. Returns the new project's number and node ID (`PVT_...`). Requires the `project` scope.",
			inputSchema: {
				owner: z
					.string()
					.optional()
					.describe(
						"User or organisation login to own the project. Omit to create it under the authenticated user.",
					),
				title: z
					.string()
					.min(1)
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Project title", MAX_TEXT_FIELD_LENGTH))
					.describe("Title of the new project."),
			},
		},
		async ({ owner, title }) =>
			wrapTool(async () => {
				const octo = client();
				const ownerNode = await resolveOwnerId(octo, owner);
				if (ownerNode == null) return ownerNotFoundError(owner ?? "?");
				const result = await octo.graphql<{
					createProjectV2: { projectV2: ProjectWriteTarget | null };
				}>(CREATE_PROJECT_MUTATION, { ownerId: ownerNode.id, title });
				const project = result.createProjectV2.projectV2;
				if (project == null) {
					return errorResult(`Failed to create project "${previewLine(title, 120)}".`);
				}
				logWrite(
					stripUndefined({
						tool: "create_project",
						owner: project.owner?.login ?? ownerNode.login,
						project_id: project.id,
					}),
				);
				return text(
					`Created project #${project.number} "${project.title}" for ${ownerNode.login}. Project ID: \`${project.id}\`.`,
				);
			}),
	);

	server.registerTool(
		"update_project",
		{
			description:
				"Edit a GitHub Project (v2) — set its title, short description, visibility (`public`), and/or open/closed state (`closed: true` closes, `closed: false` reopens). Provide at least one of those fields. Identify the project by `owner` + `number`, or by node ID (`id`). Requires the `project` scope.",
			inputSchema: {
				...ProjectRefSchema,
				title: z
					.string()
					.min(1)
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Project title", MAX_TEXT_FIELD_LENGTH))
					.optional()
					.describe("New project title."),
				description: z
					.string()
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Project description", MAX_TEXT_FIELD_LENGTH))
					.optional()
					.describe("New short description."),
				public: z.boolean().optional().describe("New visibility: true = public, false = private."),
				closed: z.boolean().optional().describe("New state: true = closed, false = open."),
			},
		},
		async ({ owner, number, id, title, description, public: isPublic, closed }) =>
			wrapTool(async () => {
				// Keep ref-error precedence over the no-op error (same discipline as
				// update_project_item_field's ref-before-value ordering).
				const refError = refValidationError({ id, owner, number });
				if (refError != null) return refError;
				if (title == null && description == null && isPublic == null && closed == null) {
					return errorResult(
						"Provide at least one of `title`, `description`, `public`, or `closed`.",
					);
				}
				const octo = client();
				const resolved = await resolveProjectForWrite(octo, { id, owner, number });
				if ("error" in resolved) return resolved.error;
				const { project } = resolved;
				const result = await octo.graphql<{
					updateProjectV2: {
						projectV2: { id: string; number: number; title: string } | null;
					};
				}>(UPDATE_PROJECT_MUTATION, {
					projectId: project.id,
					title,
					shortDescription: description,
					public: isPublic,
					closed,
				});
				const updated = result.updateProjectV2.projectV2;
				if (updated == null) {
					return errorResult(`Failed to update project #${project.number}.`);
				}
				logWrite(
					stripUndefined({
						tool: "update_project",
						owner: project.owner?.login,
						project_id: project.id,
					}),
				);
				const changes = [
					...(title != null ? [`title to "${previewLine(title, 80)}"`] : []),
					...(description != null ? ["description"] : []),
					...(isPublic != null ? [`visibility to ${isPublic ? "public" : "private"}`] : []),
					...(closed != null ? [`state to ${closed ? "closed" : "open"}`] : []),
				];
				return text(
					`Updated project #${updated.number} "${updated.title}" — set ${changes.join(", ")}.`,
				);
			}),
	);

	server.registerTool(
		"delete_project",
		{
			description:
				"Delete a GitHub Project (v2) permanently, including its draft items and field configuration (irreversible; issues and PRs on the board are not deleted). Identify the project by `owner` + `number`, or by node ID (`id`). Requires the `project` scope.",
			inputSchema: ProjectRefSchema,
		},
		async ({ owner, number, id }) =>
			wrapTool(async () => {
				const octo = client();
				const resolved = await resolveProjectForWrite(octo, { id, owner, number });
				if ("error" in resolved) return resolved.error;
				const { project } = resolved;
				const result = await octo.graphql<{
					deleteProjectV2: { projectV2: { id: string } | null };
				}>(DELETE_PROJECT_MUTATION, { projectId: project.id });
				if (result.deleteProjectV2.projectV2 == null) {
					return errorResult(`Failed to delete project #${project.number}.`);
				}
				logWrite(
					stripUndefined({
						tool: "delete_project",
						owner: project.owner?.login,
						project_id: project.id,
					}),
				);
				return text(`Deleted project #${project.number} "${project.title}" (\`${project.id}\`).`);
			}),
	);

	server.registerTool(
		"copy_project",
		{
			description:
				"Copy a GitHub Project (v2) — its fields, views, and workflows — to a new project. The copy is owned by `target_owner` (user or organisation login), or by the authenticated user when omitted. Draft items are copied only when `include_draft_issues` is true. Identify the source project by `owner` + `number`, or by node ID (`id`). Requires the `project` scope.",
			inputSchema: {
				...ProjectRefSchema,
				title: z
					.string()
					.min(1)
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Project title", MAX_TEXT_FIELD_LENGTH))
					.describe("Title of the new (copied) project."),
				target_owner: z
					.string()
					.optional()
					.describe(
						"User or organisation login to own the copy. Omit to copy under the authenticated user.",
					),
				include_draft_issues: z
					.boolean()
					.optional()
					.describe("Also copy the source project's draft items."),
			},
		},
		async ({ owner, number, id, title, target_owner, include_draft_issues }) =>
			wrapTool(async () => {
				const octo = client();
				const resolved = await resolveProjectForWrite(octo, { id, owner, number });
				if ("error" in resolved) return resolved.error;
				const { project } = resolved;
				const ownerNode = await resolveOwnerId(octo, target_owner);
				if (ownerNode == null) return ownerNotFoundError(target_owner ?? "?");
				const result = await octo.graphql<{
					copyProjectV2: { projectV2: ProjectWriteTarget | null };
				}>(COPY_PROJECT_MUTATION, {
					projectId: project.id,
					ownerId: ownerNode.id,
					title,
					includeDraftIssues: include_draft_issues,
				});
				const copy = result.copyProjectV2.projectV2;
				if (copy == null) {
					return errorResult(`Failed to copy project #${project.number}.`);
				}
				logWrite(
					stripUndefined({
						tool: "copy_project",
						owner: copy.owner?.login ?? ownerNode.login,
						project_id: copy.id,
						source_project_id: project.id,
					}),
				);
				return text(
					`Copied project #${project.number} "${project.title}" to new project #${copy.number} "${copy.title}" for ${ownerNode.login}. Project ID: \`${copy.id}\`.`,
				);
			}),
	);

	// link / unlink share everything but the mutation and the verb — register
	// them from one loop so the repo-resolution prologue lives once. They stay
	// two sibling tools (rather than one tool with an `unlink` flag, the shape
	// archive_project_item uses for undo) to match the `gh project link` /
	// `gh project unlink` subcommand split — each verb keeps its own
	// discoverable identity in the tool list.
	for (const { toolName, mutation, verb, pastTense, preposition, summary } of [
		{
			toolName: "link_project_to_repository",
			mutation: LINK_PROJECT_MUTATION,
			verb: "link",
			pastTense: "Linked",
			preposition: "to",
			summary:
				"Link a GitHub Project (v2) to a repository so the project appears in the repository's Projects tab.",
		},
		{
			toolName: "unlink_project_from_repository",
			mutation: UNLINK_PROJECT_MUTATION,
			verb: "unlink",
			pastTense: "Unlinked",
			preposition: "from",
			summary:
				"Unlink a GitHub Project (v2) from a repository, removing it from the repository's Projects tab.",
		},
	] as const) {
		server.registerTool(
			toolName,
			{
				description: `${summary} Identify the project by \`owner\` + \`number\`, or by node ID (\`id\`); identify the repository by \`repo_owner\` + \`repo\`. Requires the \`project\` scope.`,
				inputSchema: {
					...ProjectRefSchema,
					repo_owner: z.string().describe("Owner (user or organisation login) of the repository."),
					repo: z.string().describe("Repository name."),
				},
			},
			async ({ owner, number, id, repo_owner, repo }) =>
				wrapTool(async () => {
					const octo = client();
					const resolved = await resolveProjectForWrite(octo, { id, owner, number });
					if ("error" in resolved) return resolved.error;
					const { project } = resolved;
					const repoResult = await octo.graphql<{
						repository: { id: string; nameWithOwner: string } | null;
					}>(REPOSITORY_ID_QUERY, { owner: repo_owner, name: repo });
					if (repoResult.repository == null) {
						return errorResult(`Repository ${repo_owner}/${repo} not found or not accessible.`);
					}
					type LinkPayload = { repository: { nameWithOwner: string } | null };
					const result = await octo.graphql<{
						linkProjectV2ToRepository?: LinkPayload;
						unlinkProjectV2FromRepository?: LinkPayload;
					}>(mutation, { projectId: project.id, repositoryId: repoResult.repository.id });
					const payload =
						verb === "link"
							? result.linkProjectV2ToRepository
							: result.unlinkProjectV2FromRepository;
					if (payload?.repository == null) {
						return errorResult(
							`Failed to ${verb} project #${project.number} ${preposition} ${repo_owner}/${repo}.`,
						);
					}
					// `owner` is the project owner, matching every sibling project write;
					// the linked repository is identified by its own `repo` field.
					logWrite(
						stripUndefined({
							tool: toolName,
							owner: project.owner?.login,
							repo,
							project_id: project.id,
						}),
					);
					return text(
						`${pastTense} project #${project.number} "${project.title}" ${preposition} ${payload.repository.nameWithOwner}.`,
					);
				}),
		);
	}

	server.registerTool(
		"create_project_field",
		{
			description:
				"Create a custom field on a GitHub Project (v2). `data_type` is one of TEXT, NUMBER, DATE, or SINGLE_SELECT; a SINGLE_SELECT field additionally requires `options` (its option names). Returns the new field's node ID (and option IDs for single-select). Identify the project by `owner` + `number`, or by node ID (`id`). Requires the `project` scope.",
			inputSchema: {
				...ProjectRefSchema,
				name: z
					.string()
					.min(1)
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Field name", MAX_TEXT_FIELD_LENGTH))
					.describe("Name of the new field."),
				data_type: z
					.enum(["TEXT", "NUMBER", "DATE", "SINGLE_SELECT"])
					.describe("Data type of the new field."),
				options: z
					.array(
						z
							.string()
							.min(1)
							.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Option name", MAX_TEXT_FIELD_LENGTH)),
					)
					.min(1)
					.optional()
					.describe(
						"Option names for a SINGLE_SELECT field (required for SINGLE_SELECT, rejected otherwise).",
					),
			},
		},
		async ({ owner, number, id, name, data_type, options }) =>
			wrapTool(async () => {
				const refError = refValidationError({ id, owner, number });
				if (refError != null) return refError;
				if (data_type === "SINGLE_SELECT" && options == null) {
					return errorResult("A SINGLE_SELECT field requires `options` (its option names).");
				}
				if (data_type !== "SINGLE_SELECT" && options != null) {
					return errorResult(`\`options\` only applies to SINGLE_SELECT fields, not ${data_type}.`);
				}
				const octo = client();
				const resolved = await resolveProjectForWrite(octo, { id, owner, number });
				if ("error" in resolved) return resolved.error;
				const { project } = resolved;
				const result = await octo.graphql<{
					createProjectV2Field: { projectV2Field: ProjectFieldNode | null };
				}>(CREATE_PROJECT_FIELD_MUTATION, {
					projectId: project.id,
					dataType: data_type,
					name,
					// The API requires color + description per option; default them so
					// the tool surface stays the option-name list gh takes.
					singleSelectOptions: options?.map((option) => ({
						name: option,
						color: "GRAY",
						description: "",
					})),
				});
				const field = result.createProjectV2Field.projectV2Field;
				if (field?.id == null) {
					return errorResult(`Failed to create field "${name}" in project #${project.number}.`);
				}
				logWrite(
					stripUndefined({
						tool: "create_project_field",
						owner: project.owner?.login,
						project_id: project.id,
						field_id: field.id,
					}),
				);
				return text(
					`Created field in project #${project.number} "${project.title}":\n${fieldLine(field)}`,
				);
			}),
	);

	server.registerTool(
		"delete_project_field",
		{
			description:
				"Delete a custom field from a GitHub Project (v2) by its field node ID (from list_project_fields), discarding the field's values on every item (irreversible). Built-in fields (Title, Assignees, Status, ...) cannot be deleted. Requires the `project` scope.",
			inputSchema: {
				field_id: z
					.string()
					.min(1)
					.describe("Project field node ID. Discover via list_project_fields."),
			},
		},
		async ({ field_id }) =>
			wrapTool(async () => {
				type DeletedFieldNode = ProjectFieldNode & {
					project?: { id: string; owner: { login?: string } | null };
				};
				const result = await client().graphql<{
					deleteProjectV2Field: { projectV2Field: DeletedFieldNode | null };
				}>(DELETE_PROJECT_FIELD_MUTATION, { fieldId: field_id });
				const field = result.deleteProjectV2Field.projectV2Field;
				if (field?.id == null) {
					return errorResult(`Failed to delete field \`${field_id}\`.`);
				}
				logWrite(
					stripUndefined({
						tool: "delete_project_field",
						owner: field.project?.owner?.login,
						project_id: field.project?.id,
						field_id,
					}),
				);
				return text(`Deleted field "${field.name}" (${field.dataType}, \`${field.id}\`).`);
			}),
	);

	server.registerTool(
		"archive_project_item",
		{
			description:
				"Archive an item on a GitHub Project (v2) by its item node ID (`PVTI_...`, from list_project_items) — the item leaves the board but stays restorable, unlike remove_project_item. Pass `undo: true` to unarchive (restore) instead. Identify the project by `owner` + `number`, or by node ID (`id`). Requires the `project` scope.",
			inputSchema: {
				...ProjectRefSchema,
				item_id: ItemIdSchema,
				undo: z
					.boolean()
					.optional()
					.describe("Unarchive (restore) the item instead of archiving it."),
			},
		},
		async ({ owner, number, id, item_id, undo }) =>
			wrapTool(async () => {
				const octo = client();
				const resolved = await resolveProjectForWrite(octo, { id, owner, number });
				if ("error" in resolved) return resolved.error;
				const { project } = resolved;
				const unarchive = undo === true;
				type ArchivePayload = { item: { id: string } | null };
				const result = await octo.graphql<{
					archiveProjectV2Item?: ArchivePayload;
					unarchiveProjectV2Item?: ArchivePayload;
				}>(unarchive ? UNARCHIVE_PROJECT_ITEM_MUTATION : ARCHIVE_PROJECT_ITEM_MUTATION, {
					projectId: project.id,
					itemId: item_id,
				});
				const payload = unarchive ? result.unarchiveProjectV2Item : result.archiveProjectV2Item;
				if (payload?.item == null) {
					return errorResult(
						`Failed to ${unarchive ? "unarchive" : "archive"} item \`${item_id}\` in project #${project.number}.`,
					);
				}
				logWrite(
					stripUndefined({
						tool: "archive_project_item",
						owner: project.owner?.login,
						project_id: project.id,
						item_id,
						action: unarchive ? "unarchive" : "archive",
					}),
				);
				return text(
					`${unarchive ? "Unarchived" : "Archived"} item \`${item_id}\` in project #${project.number} "${project.title}".`,
				);
			}),
	);
};
