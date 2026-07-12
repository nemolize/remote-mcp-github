import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_RESPONSE_CHARS } from "../src/mcp/response.js";
import { registerProjectTools } from "../src/tools/projects.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

// The projects tools only touch `client().graphql(query, vars)`, so a stub
// carrying just `graphql` is a sufficient Octokit.
const stubOctokit = (graphql) => ({ graphql });

const page = (nodes, { totalCount, hasNextPage = false, endCursor = null } = {}) => ({
	totalCount: totalCount ?? nodes.length,
	pageInfo: { hasNextPage, endCursor },
	nodes,
});

const projectNode = (overrides = {}) => ({
	id: "PVT_kwAA1",
	number: 4,
	title: "Roadmap",
	public: true,
	closed: false,
	updatedAt: "2026-07-01T00:00:00Z",
	...overrides,
});

describe("registerProjectTools", () => {
	it("registers the four read tools and thirteen write tools", () => {
		const { handlers, server } = captureHandlers();
		registerProjectTools(server, () => stubOctokit(async () => ({})));
		for (const name of [
			"list_projects",
			"get_project",
			"list_project_items",
			"list_project_fields",
			"add_project_item",
			"remove_project_item",
			"update_project_item_field",
			"create_project_draft_item",
			"create_project",
			"update_project",
			"delete_project",
			"copy_project",
			"link_project_to_repository",
			"unlink_project_from_repository",
			"create_project_field",
			"delete_project_field",
			"archive_project_item",
		]) {
			expect(handlers.has(name), name).toBe(true);
		}
	});
});

describe("list_projects", () => {
	it("lists the viewer's projects when owner is omitted", async () => {
		const { handlers, server } = captureHandlers();
		let capturedQuery;
		const octokit = stubOctokit(async (query) => {
			capturedQuery = query;
			return { viewer: { projectsV2: page([projectNode()]) } };
		});
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_projects", { per_page: 30 });
		const body = result.content[0].text;
		expect(capturedQuery).toContain("viewer");
		expect(body).toContain("# Projects for the authenticated user (1)");
		expect(body).toContain("#4 Roadmap");
		expect(body).toContain("public, open");
		expect(body).toContain("updated 2026-07-01T00:00:00Z");
		expect(body).toContain("`PVT_kwAA1`");
		expect(result.isError).toBeUndefined();
	});

	it("queries repositoryOwner and forwards pagination vars when owner is given", async () => {
		const { handlers, server } = captureHandlers();
		let capturedQuery;
		let capturedVars;
		const octokit = stubOctokit(async (query, vars) => {
			capturedQuery = query;
			capturedVars = vars;
			return {
				repositoryOwner: {
					projectsV2: page([projectNode({ public: false, closed: true })]),
				},
			};
		});
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_projects", {
			owner: "acme",
			per_page: 10,
			cursor: "CUR_1",
		});
		expect(capturedQuery).toContain("repositoryOwner");
		expect(capturedVars).toEqual({ owner: "acme", first: 10, after: "CUR_1" });
		const body = result.content[0].text;
		expect(body).toContain("# Projects for acme (1)");
		expect(body).toContain("private, closed");
	});

	it("appends the cursor hint when a next page exists", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({
			viewer: {
				projectsV2: page([projectNode()], {
					totalCount: 12,
					hasNextPage: true,
					endCursor: "CUR_next",
				}),
			},
		}));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_projects", { per_page: 1 });
		const body = result.content[0].text;
		expect(body).toContain("(1 of 12 shown; more results exist.");
		expect(body).toContain('cursor: "CUR_next"');
	});

	it("renders an empty state without a cursor hint", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ viewer: { projectsV2: page([]) } }));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_projects", { per_page: 30 });
		expect(result.content[0].text).toContain("No projects.");
	});

	it("errors when the owner does not resolve", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ repositoryOwner: null }));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_projects", { owner: "ghost", per_page: 30 });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Owner ghost not found");
	});
});

describe("get_project", () => {
	const detailNode = {
		id: "PVT_kwAA1",
		number: 4,
		title: "Roadmap",
		shortDescription: "Team roadmap",
		public: false,
		closed: false,
		template: false,
		updatedAt: "2026-07-01T00:00:00Z",
		items: { totalCount: 12 },
		fields: {
			totalCount: 2,
			nodes: [
				{ id: "PVTF_title", name: "Title", dataType: "TITLE" },
				{
					id: "PVTSSF_status",
					name: "Status",
					dataType: "SINGLE_SELECT",
					options: [
						{ id: "opt1", name: "Todo" },
						{ id: "opt2", name: "Done" },
					],
				},
			],
		},
	};

	it("renders detail with fields and single-select options (owner + number)", async () => {
		const { handlers, server } = captureHandlers();
		let capturedVars;
		const octokit = stubOctokit(async (_query, vars) => {
			capturedVars = vars;
			return { repositoryOwner: { projectV2: detailNode } };
		});
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "get_project", { owner: "acme", number: 4 });
		expect(capturedVars).toEqual({ owner: "acme", number: 4 });
		const body = result.content[0].text;
		expect(body).toContain("# Project #4: Roadmap");
		expect(body).toContain("- visibility: private");
		expect(body).toContain("- state: open");
		expect(body).toContain("- items: 12");
		expect(body).toContain("- description: Team roadmap");
		expect(body).toContain("## Fields (2)");
		expect(body).toContain("- Title — TITLE — id: `PVTF_title`");
		expect(body).toContain(
			"- Status — SINGLE_SELECT — options: Todo (`opt1`), Done (`opt2`) — id: `PVTSSF_status`",
		);
		expect(result.isError).toBeUndefined();
	});

	it("flags fields beyond the detail query's first page", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({
			repositoryOwner: {
				projectV2: { ...detailNode, fields: { ...detailNode.fields, totalCount: 60 } },
			},
		}));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "get_project", { owner: "acme", number: 4 });
		const body = result.content[0].text;
		expect(body).toContain("## Fields (60)");
		expect(body).toContain("(2 of 60 shown; use list_project_fields to page through the rest.)");
	});

	it("resolves by node ID via the node() query", async () => {
		const { handlers, server } = captureHandlers();
		let capturedQuery;
		let capturedVars;
		const octokit = stubOctokit(async (query, vars) => {
			capturedQuery = query;
			capturedVars = vars;
			return { node: detailNode };
		});
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "get_project", { id: "PVT_kwAA1" });
		expect(capturedQuery).toContain("node(id: $id)");
		expect(capturedVars).toEqual({ id: "PVT_kwAA1" });
		expect(result.content[0].text).toContain("# Project #4: Roadmap");
	});

	it("errors when owner + number resolve to no project", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ repositoryOwner: { projectV2: null } }));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "get_project", { owner: "acme", number: 999 });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Project acme/#999 not found or not accessible");
	});

	it("errors when the owner itself does not resolve", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ repositoryOwner: null }));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "get_project", { owner: "ghost", number: 4 });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Project ghost/#4 not found or not accessible");
	});

	it("errors when a node ID resolves to a non-project node", async () => {
		const { handlers, server } = captureHandlers();
		// A non-ProjectV2 node makes the inline fragment contribute no fields.
		const octokit = stubOctokit(async () => ({ node: {} }));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "get_project", { id: "I_notaproject" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not found or not accessible");
	});

	it("errors when neither id nor owner + number are provided", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({}));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "get_project", { owner: "acme" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Provide either `id`");
	});

	it("rejects an ambiguous ref passing both id and owner + number", async () => {
		const { handlers, server } = captureHandlers();
		let called = false;
		const octokit = stubOctokit(async () => {
			called = true;
			return {};
		});
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "get_project", {
			id: "PVT_kwAA1",
			owner: "acme",
			number: 4,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not both");
		expect(called).toBe(false);
	});
});

describe("list_project_items", () => {
	const itemsProject = (items, pageOpts) => ({
		repositoryOwner: {
			projectV2: { number: 4, title: "Roadmap", items: page(items, pageOpts) },
		},
	});

	it("renders one row per item with type, ref, status, and assignees", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () =>
			itemsProject([
				{
					id: "PVTI_1",
					type: "ISSUE",
					fieldValueByName: { name: "In Progress" },
					content: {
						title: "Fix login bug",
						number: 12,
						repository: { nameWithOwner: "acme/web" },
						assignees: { totalCount: 2, nodes: [{ login: "alice" }, { login: "bob" }] },
					},
				},
				{
					id: "PVTI_2",
					type: "PULL_REQUEST",
					fieldValueByName: null,
					content: {
						title: "Add cache layer",
						number: 34,
						repository: { nameWithOwner: "acme/api" },
						assignees: { totalCount: 0, nodes: [] },
					},
				},
				{
					id: "PVTI_3",
					type: "DRAFT_ISSUE",
					fieldValueByName: { name: "Todo" },
					content: { title: "Investigate flakiness", assignees: { totalCount: 0, nodes: [] } },
				},
			]),
		);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_project_items", {
			owner: "acme",
			number: 4,
			per_page: 30,
		});
		const body = result.content[0].text;
		expect(body).toContain('# Project #4 "Roadmap" — items (3)');
		expect(body).toContain(
			"- ISSUE — Fix login bug (acme/web#12) — status: In Progress — @alice, @bob — id: `PVTI_1`",
		);
		expect(body).toContain("- PULL_REQUEST — Add cache layer (acme/api#34) — id: `PVTI_2`");
		expect(body).toContain("- DRAFT_ISSUE — Investigate flakiness — status: Todo — id: `PVTI_3`");
		expect(result.isError).toBeUndefined();
	});

	it("flags assignees beyond the queried first five", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () =>
			itemsProject([
				{
					id: "PVTI_7",
					type: "ISSUE",
					fieldValueByName: null,
					content: {
						title: "All hands issue",
						number: 7,
						repository: { nameWithOwner: "acme/web" },
						assignees: {
							totalCount: 7,
							nodes: [
								{ login: "alice" },
								{ login: "bob" },
								{ login: "carol" },
								{ login: "dan" },
								{ login: "eve" },
							],
						},
					},
				},
			]),
		);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_project_items", {
			owner: "acme",
			number: 4,
			per_page: 30,
		});
		expect(result.content[0].text).toContain("— @alice, @bob, @carol, @dan, @eve +2 more");
	});

	it("truncates a large page without dropping the cursor hint", async () => {
		const { handlers, server } = captureHandlers();
		const items = Array.from({ length: 200 }, (_, i) => ({
			id: `PVTI_${i}`,
			type: "ISSUE",
			fieldValueByName: { name: "Todo" },
			content: {
				title: `Item ${i} ${"x".repeat(100)}`,
				number: i + 1,
				repository: { nameWithOwner: "acme/web" },
				assignees: { nodes: [] },
			},
		}));
		const octokit = stubOctokit(async () =>
			itemsProject(items, { totalCount: 500, hasNextPage: true, endCursor: "CUR_tail" }),
		);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_project_items", {
			owner: "acme",
			number: 4,
			per_page: 100,
		});
		const body = result.content[0].text;
		expect(body.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
		expect(body).toContain("truncated;");
		expect(body).toContain('cursor: "CUR_tail"');
	});

	it("forwards pagination vars alongside the project ref", async () => {
		const { handlers, server } = captureHandlers();
		let capturedVars;
		const octokit = stubOctokit(async (_query, vars) => {
			capturedVars = vars;
			return itemsProject([]);
		});
		registerProjectTools(server, () => octokit);

		await invoke(handlers, "list_project_items", {
			owner: "acme",
			number: 4,
			per_page: 50,
			cursor: "CUR_2",
		});
		expect(capturedVars).toEqual({ owner: "acme", number: 4, first: 50, after: "CUR_2" });
	});

	it("errors when neither id nor owner + number are provided", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({}));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_project_items", { number: 4, per_page: 30 });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Provide either `id`");
	});

	it("errors when owner + number resolve to no project", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ repositoryOwner: { projectV2: null } }));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_project_items", {
			owner: "acme",
			number: 999,
			per_page: 30,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Project acme/#999 not found or not accessible");
	});

	it("rejects an ambiguous ref passing both id and owner", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({}));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_project_items", {
			id: "PVT_kwAA1",
			owner: "acme",
			per_page: 30,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not both");
	});
});

describe("list_project_fields", () => {
	it("renders field rows with data types and single-select option IDs", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({
			node: {
				number: 4,
				title: "Roadmap",
				fields: page([
					{ id: "PVTF_title", name: "Title", dataType: "TITLE" },
					{
						id: "PVTSSF_status",
						name: "Status",
						dataType: "SINGLE_SELECT",
						options: [
							{ id: "47fc9ee4", name: "Todo" },
							{ id: "98236657", name: "In Progress" },
						],
					},
					{ id: "PVTIF_iter", name: "Iteration", dataType: "ITERATION" },
				]),
			},
		}));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_project_fields", { id: "PVT_kwAA1", per_page: 30 });
		const body = result.content[0].text;
		expect(body).toContain('# Project #4 "Roadmap" — fields (3)');
		expect(body).toContain("- Title — TITLE — id: `PVTF_title`");
		expect(body).toContain(
			"- Status — SINGLE_SELECT — options: Todo (`47fc9ee4`), In Progress (`98236657`) — id: `PVTSSF_status`",
		);
		expect(body).toContain("- Iteration — ITERATION — id: `PVTIF_iter`");
		expect(result.isError).toBeUndefined();
	});

	it("appends the cursor hint when more fields exist", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({
			node: {
				number: 4,
				title: "Roadmap",
				fields: page([{ id: "PVTF_title", name: "Title", dataType: "TITLE" }], {
					totalCount: 30,
					hasNextPage: true,
					endCursor: "CUR_f",
				}),
			},
		}));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_project_fields", { id: "PVT_kwAA1", per_page: 1 });
		const body = result.content[0].text;
		expect(body).toContain("(1 of 30 shown; more results exist.");
		expect(body).toContain('cursor: "CUR_f"');
	});

	it("errors when neither id nor owner + number are provided", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({}));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_project_fields", { owner: "acme", per_page: 30 });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Provide either `id`");
	});

	it("errors when owner + number resolve to no project", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ repositoryOwner: null }));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_project_fields", {
			owner: "ghost",
			number: 4,
			per_page: 30,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Project ghost/#4 not found or not accessible");
	});

	it("rejects an ambiguous ref passing both id and number", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({}));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_project_fields", {
			id: "PVT_kwAA1",
			number: 4,
			per_page: 30,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not both");
	});
});

// Shared fixture for the write tools: every write resolves the project first
// (id + number + title + owner login), then issues its mutation. `writeStub`
// records each graphql call and routes mutations to `mutationResult`.
const writeTarget = {
	id: "PVT_kwAA1",
	number: 4,
	title: "Roadmap",
	owner: { login: "acme" },
};

const writeStub = (mutationResult, { project = writeTarget } = {}) => {
	const calls = [];
	const octokit = stubOctokit(async (query, vars) => {
		calls.push({ query, vars });
		if (query.trimStart().startsWith("mutation")) {
			if (mutationResult instanceof Error) throw mutationResult;
			return mutationResult;
		}
		return query.includes("node(id: $id)")
			? { node: project }
			: { repositoryOwner: project == null ? { projectV2: null } : { projectV2: project } };
	});
	return { calls, octokit };
};

describe("add_project_item", () => {
	const addedItem = {
		id: "PVTI_new1",
		type: "ISSUE",
		content: { title: "Fix login bug", number: 12, repository: { nameWithOwner: "acme/web" } },
	};

	it("adds an issue by content node ID to a project referenced by id", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub({ addProjectV2ItemById: { item: addedItem } });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "add_project_item", {
			id: "PVT_kwAA1",
			content_id: "I_abc",
		});
		expect(calls).toHaveLength(2);
		expect(calls[0].query).toContain("node(id: $id)");
		expect(calls[1].vars).toEqual({ projectId: "PVT_kwAA1", contentId: "I_abc" });
		expect(result.content[0].text).toBe(
			'Added ISSUE — Fix login bug (acme/web#12) to project #4 "Roadmap". Item ID: `PVTI_new1`.',
		);
		expect(result.isError).toBeUndefined();
	});

	it("resolves the project id first when referenced by owner + number", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub({ addProjectV2ItemById: { item: addedItem } });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "add_project_item", {
			owner: "acme",
			number: 4,
			content_id: "PR_xyz",
		});
		expect(calls[0].query).toContain("repositoryOwner");
		expect(calls[0].vars).toEqual({ owner: "acme", number: 4 });
		expect(calls[1].vars).toEqual({ projectId: "PVT_kwAA1", contentId: "PR_xyz" });
		expect(result.isError).toBeUndefined();
	});

	it("rejects an ambiguous ref without calling the API", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub({});
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "add_project_item", {
			id: "PVT_kwAA1",
			owner: "acme",
			number: 4,
			content_id: "I_abc",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not both");
		expect(calls).toHaveLength(0);
	});

	it("errors when the project does not resolve", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub({}, { project: null });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "add_project_item", {
			owner: "acme",
			number: 999,
			content_id: "I_abc",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Project acme/#999 not found or not accessible");
		expect(calls).toHaveLength(1);
	});

	it("errors when the mutation returns no item", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = writeStub({ addProjectV2ItemById: { item: null } });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "add_project_item", {
			id: "PVT_kwAA1",
			content_id: "I_abc",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to add `I_abc` to project #4.");
	});

	it("surfaces a GraphQL error from the mutation (e.g. bad content id)", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = writeStub(new Error("Could not resolve to a node with the global id"));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "add_project_item", {
			id: "PVT_kwAA1",
			content_id: "I_bogus",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Could not resolve to a node");
	});
});

describe("remove_project_item", () => {
	it("removes an item and confirms with the project title", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub({ deleteProjectV2Item: { deletedItemId: "PVTI_9" } });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "remove_project_item", {
			owner: "acme",
			number: 4,
			item_id: "PVTI_9",
		});
		expect(calls[1].vars).toEqual({ projectId: "PVT_kwAA1", itemId: "PVTI_9" });
		expect(result.content[0].text).toBe('Removed item `PVTI_9` from project #4 "Roadmap".');
		expect(result.isError).toBeUndefined();
	});

	it("errors when the project does not resolve", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = writeStub({}, { project: null });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "remove_project_item", {
			owner: "acme",
			number: 999,
			item_id: "PVTI_9",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Project acme/#999 not found or not accessible");
	});

	it("errors when the mutation returns no deleted item id", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = writeStub({ deleteProjectV2Item: { deletedItemId: null } });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "remove_project_item", {
			id: "PVT_kwAA1",
			item_id: "PVTI_gone",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to remove item `PVTI_gone`");
	});
});

describe("update_project_item_field", () => {
	const updateOk = { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_9" } } };
	const baseParams = { owner: "acme", number: 4, item_id: "PVTI_9", field_id: "F_1" };

	it.each([
		[{ text: "Ship it" }, { text: "Ship it" }, 'text "Ship it"'],
		[{ number: 8 }, { number: 8 }, "number 8"],
		[{ date: "2026-07-08" }, { date: "2026-07-08" }, "date 2026-07-08"],
		[
			{ single_select_option_id: "47fc9ee4" },
			{ singleSelectOptionId: "47fc9ee4" },
			"option `47fc9ee4`",
		],
	])("sets %o", async (value, expectedMutationValue, expectedRendering) => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub(updateOk);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "update_project_item_field", { ...baseParams, value });
		expect(calls[1].vars).toEqual({
			projectId: "PVT_kwAA1",
			itemId: "PVTI_9",
			fieldId: "F_1",
			value: expectedMutationValue,
		});
		expect(result.content[0].text).toBe(
			`Updated field \`F_1\` on item \`PVTI_9\` in project #4 "Roadmap" to ${expectedRendering}.`,
		);
		expect(result.isError).toBeUndefined();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("errors and skips the audit log when the mutation returns no item", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { handlers, server } = captureHandlers();
		const { octokit } = writeStub({ updateProjectV2ItemFieldValue: { projectV2Item: null } });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "update_project_item_field", {
			...baseParams,
			value: { text: "x" },
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to update field `F_1` on item `PVTI_9`");
		const auditLines = logSpy.mock.calls.filter(([line]) =>
			String(line).startsWith("[github-audit]"),
		);
		expect(auditLines).toEqual([]);
	});

	it("rejects an empty value object without calling the API", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub(updateOk);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "update_project_item_field", {
			...baseParams,
			value: {},
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("exactly one");
		expect(calls).toHaveLength(0);
	});

	it("rejects multiple value forms without calling the API", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub(updateOk);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "update_project_item_field", {
			...baseParams,
			value: { text: "a", number: 1 },
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("exactly one");
		expect(calls).toHaveLength(0);
	});
});

describe("create_project_draft_item", () => {
	it("creates a draft item with title and body", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub({
			addProjectV2DraftIssue: { projectItem: { id: "PVTI_draft1" } },
		});
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "create_project_draft_item", {
			owner: "acme",
			number: 4,
			title: "Investigate flakiness",
			body: "CI job X fails intermittently.",
		});
		expect(calls[1].vars).toEqual({
			projectId: "PVT_kwAA1",
			title: "Investigate flakiness",
			body: "CI job X fails intermittently.",
		});
		expect(result.content[0].text).toBe(
			'Created draft item "Investigate flakiness" in project #4 "Roadmap". Item ID: `PVTI_draft1`.',
		);
		expect(result.isError).toBeUndefined();
	});

	it("errors when the project does not resolve", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = writeStub({}, { project: null });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "create_project_draft_item", {
			owner: "ghost",
			number: 4,
			title: "t",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Project ghost/#4 not found or not accessible");
	});

	it("errors when the mutation returns no project item", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = writeStub({ addProjectV2DraftIssue: { projectItem: null } });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "create_project_draft_item", {
			id: "PVT_kwAA1",
			title: "t",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to create a draft item");
	});
});

// Dispatch-style stub for the tools that mix owner-id / repository-id lookup
// queries with the shared project-resolution query and a mutation. Routes each
// graphql call on a query substring; unmatched queries throw so a test never
// silently passes on the wrong call shape.
const dispatchStub = (routes) => {
	const calls = [];
	const octokit = stubOctokit(async (query, vars) => {
		calls.push({ query, vars });
		for (const [needle, result] of routes) {
			if (query.includes(needle)) {
				if (result instanceof Error) throw result;
				return result;
			}
		}
		throw new Error(`unexpected query: ${query}`);
	});
	return { calls, octokit };
};

describe("create_project", () => {
	const createdProject = {
		id: "PVT_new1",
		number: 9,
		title: "Roadmap",
		owner: { login: "me" },
	};

	it("creates a project under the viewer when owner is omitted", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = dispatchStub([
			["viewer { id login }", { viewer: { id: "U_9", login: "me" } }],
			["createProjectV2(", { createProjectV2: { projectV2: createdProject } }],
		]);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "create_project", { title: "Roadmap" });
		expect(calls).toHaveLength(2);
		expect(calls[1].vars).toEqual({ ownerId: "U_9", title: "Roadmap" });
		expect(result.content[0].text).toBe(
			'Created project #9 "Roadmap" for me. Project ID: `PVT_new1`.',
		);
		expect(result.isError).toBeUndefined();
	});

	it("resolves an explicit owner login to its node ID", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = dispatchStub([
			[
				"repositoryOwner(login: $owner) { id login }",
				{ repositoryOwner: { id: "O_1", login: "acme" } },
			],
			[
				"createProjectV2(",
				{ createProjectV2: { projectV2: { ...createdProject, owner: { login: "acme" } } } },
			],
		]);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "create_project", { owner: "acme", title: "Roadmap" });
		expect(calls[0].vars).toEqual({ owner: "acme" });
		expect(calls[1].vars).toEqual({ ownerId: "O_1", title: "Roadmap" });
		expect(result.content[0].text).toContain("for acme");
	});

	it("errors when the owner login does not resolve", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = dispatchStub([
			["repositoryOwner(login: $owner) { id login }", { repositoryOwner: null }],
		]);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "create_project", { owner: "ghost", title: "t" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Owner ghost not found");
	});

	it("errors when the mutation returns no project", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = dispatchStub([
			["viewer { id login }", { viewer: { id: "U_9", login: "me" } }],
			["createProjectV2(", { createProjectV2: { projectV2: null } }],
		]);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "create_project", { title: "t" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Failed to create project "t".');
	});
});

describe("update_project", () => {
	const updateOk = {
		updateProjectV2: { projectV2: { id: "PVT_kwAA1", number: 4, title: "New name" } },
	};

	it("updates title and visibility and reports the changed fields", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub(updateOk);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "update_project", {
			owner: "acme",
			number: 4,
			title: "New name",
			public: true,
		});
		expect(calls[1].vars).toEqual({
			projectId: "PVT_kwAA1",
			title: "New name",
			shortDescription: undefined,
			public: true,
			closed: undefined,
		});
		expect(result.content[0].text).toBe(
			'Updated project #4 "New name" — set title to "New name", visibility to public.',
		);
		expect(result.isError).toBeUndefined();
	});

	it("closes a project via closed: true", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub({
			updateProjectV2: { projectV2: { id: "PVT_kwAA1", number: 4, title: "Roadmap" } },
		});
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "update_project", { id: "PVT_kwAA1", closed: true });
		expect(calls[1].vars).toMatchObject({ projectId: "PVT_kwAA1", closed: true });
		expect(result.content[0].text).toBe('Updated project #4 "Roadmap" — set state to closed.');
	});

	it("rejects a no-op update without calling the API", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub(updateOk);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "update_project", { owner: "acme", number: 4 });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("at least one");
		expect(calls).toHaveLength(0);
	});

	it("errors when the mutation returns no project", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = writeStub({ updateProjectV2: { projectV2: null } });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "update_project", { id: "PVT_kwAA1", title: "t" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to update project #4.");
	});
});

describe("delete_project", () => {
	it("deletes a project and confirms with number, title, and node ID", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub({ deleteProjectV2: { projectV2: { id: "PVT_kwAA1" } } });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "delete_project", { owner: "acme", number: 4 });
		expect(calls[1].vars).toEqual({ projectId: "PVT_kwAA1" });
		expect(result.content[0].text).toBe('Deleted project #4 "Roadmap" (`PVT_kwAA1`).');
		expect(result.isError).toBeUndefined();
	});

	it("errors when the project does not resolve", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = writeStub({}, { project: null });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "delete_project", { owner: "acme", number: 999 });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Project acme/#999 not found or not accessible");
	});

	it("errors when the mutation returns no project", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = writeStub({ deleteProjectV2: { projectV2: null } });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "delete_project", { id: "PVT_kwAA1" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to delete project #4.");
	});
});

describe("copy_project", () => {
	const copiedProject = {
		id: "PVT_copy1",
		number: 11,
		title: "Roadmap copy",
		owner: { login: "me" },
	};
	const sourceRoutes = [
		["projectV2(number: $number)", { repositoryOwner: { projectV2: writeTarget } }],
	];

	it("copies to the viewer when target_owner is omitted", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = dispatchStub([
			...sourceRoutes,
			["viewer { id login }", { viewer: { id: "U_9", login: "me" } }],
			["copyProjectV2(", { copyProjectV2: { projectV2: copiedProject } }],
		]);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "copy_project", {
			owner: "acme",
			number: 4,
			title: "Roadmap copy",
			include_draft_issues: true,
		});
		expect(calls[2].vars).toEqual({
			projectId: "PVT_kwAA1",
			ownerId: "U_9",
			title: "Roadmap copy",
			includeDraftIssues: true,
		});
		expect(result.content[0].text).toBe(
			'Copied project #4 "Roadmap" to new project #11 "Roadmap copy" for me. Project ID: `PVT_copy1`.',
		);
		expect(result.isError).toBeUndefined();
	});

	it("errors when the target owner does not resolve", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = dispatchStub([
			...sourceRoutes,
			["repositoryOwner(login: $owner) { id login }", { repositoryOwner: null }],
		]);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "copy_project", {
			owner: "acme",
			number: 4,
			title: "t",
			target_owner: "ghost",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Owner ghost not found");
	});

	it("errors when the mutation returns no project", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = dispatchStub([
			...sourceRoutes,
			["viewer { id login }", { viewer: { id: "U_9", login: "me" } }],
			["copyProjectV2(", { copyProjectV2: { projectV2: null } }],
		]);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "copy_project", { owner: "acme", number: 4, title: "t" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to copy project #4.");
	});
});

describe("link_project_to_repository / unlink_project_from_repository", () => {
	const repoRoute = [
		"repository(owner: $owner, name: $name)",
		{ repository: { id: "R_5", nameWithOwner: "acme/web" } },
	];
	const sourceRoute = [
		"projectV2(number: $number)",
		{ repositoryOwner: { projectV2: writeTarget } },
	];

	it("links a project to a repository", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = dispatchStub([
			sourceRoute,
			repoRoute,
			[
				"linkProjectV2ToRepository(",
				{ linkProjectV2ToRepository: { repository: { nameWithOwner: "acme/web" } } },
			],
		]);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "link_project_to_repository", {
			owner: "acme",
			number: 4,
			repo_owner: "acme",
			repo: "web",
		});
		expect(calls[1].vars).toEqual({ owner: "acme", name: "web" });
		expect(calls[2].vars).toEqual({ projectId: "PVT_kwAA1", repositoryId: "R_5" });
		expect(result.content[0].text).toBe('Linked project #4 "Roadmap" to acme/web.');
		expect(result.isError).toBeUndefined();
	});

	it("unlinks a project from a repository", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = dispatchStub([
			["node(id: $id)", { node: writeTarget }],
			repoRoute,
			[
				"unlinkProjectV2FromRepository(",
				{ unlinkProjectV2FromRepository: { repository: { nameWithOwner: "acme/web" } } },
			],
		]);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "unlink_project_from_repository", {
			id: "PVT_kwAA1",
			repo_owner: "acme",
			repo: "web",
		});
		expect(calls[2].vars).toEqual({ projectId: "PVT_kwAA1", repositoryId: "R_5" });
		expect(result.content[0].text).toBe('Unlinked project #4 "Roadmap" from acme/web.');
		expect(result.isError).toBeUndefined();
	});

	it("errors when the repository does not resolve", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = dispatchStub([
			sourceRoute,
			["repository(owner: $owner, name: $name)", { repository: null }],
		]);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "link_project_to_repository", {
			owner: "acme",
			number: 4,
			repo_owner: "acme",
			repo: "gone",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Repository acme/gone not found or not accessible.");
	});

	it("errors when the unlink mutation returns no repository", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = dispatchStub([
			sourceRoute,
			repoRoute,
			["unlinkProjectV2FromRepository(", { unlinkProjectV2FromRepository: { repository: null } }],
		]);
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "unlink_project_from_repository", {
			owner: "acme",
			number: 4,
			repo_owner: "acme",
			repo: "web",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to unlink project #4 from acme/web.");
	});
});

describe("create_project_field", () => {
	it("creates a single-select field and surfaces the new option IDs", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub({
			createProjectV2Field: {
				projectV2Field: {
					id: "PVTSSF_new",
					name: "Priority",
					dataType: "SINGLE_SELECT",
					options: [
						{ id: "opt_hi", name: "High" },
						{ id: "opt_lo", name: "Low" },
					],
				},
			},
		});
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "create_project_field", {
			owner: "acme",
			number: 4,
			name: "Priority",
			data_type: "SINGLE_SELECT",
			options: ["High", "Low"],
		});
		expect(calls[1].vars).toEqual({
			projectId: "PVT_kwAA1",
			dataType: "SINGLE_SELECT",
			name: "Priority",
			singleSelectOptions: [
				{ name: "High", color: "GRAY", description: "" },
				{ name: "Low", color: "GRAY", description: "" },
			],
		});
		expect(result.content[0].text).toContain('Created field in project #4 "Roadmap":');
		expect(result.content[0].text).toContain(
			"- Priority — SINGLE_SELECT — options: High (`opt_hi`), Low (`opt_lo`) — id: `PVTSSF_new`",
		);
		expect(result.isError).toBeUndefined();
	});

	it("creates a plain TEXT field without options", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub({
			createProjectV2Field: {
				projectV2Field: { id: "PVTF_new", name: "Notes", dataType: "TEXT" },
			},
		});
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "create_project_field", {
			id: "PVT_kwAA1",
			name: "Notes",
			data_type: "TEXT",
		});
		expect(calls[1].vars).toEqual({
			projectId: "PVT_kwAA1",
			dataType: "TEXT",
			name: "Notes",
			singleSelectOptions: undefined,
		});
		expect(result.content[0].text).toContain("- Notes — TEXT — id: `PVTF_new`");
	});

	it("rejects SINGLE_SELECT without options before calling the API", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub({});
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "create_project_field", {
			id: "PVT_kwAA1",
			name: "Priority",
			data_type: "SINGLE_SELECT",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("requires `options`");
		expect(calls).toHaveLength(0);
	});

	it("rejects options on a non-single-select field before calling the API", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub({});
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "create_project_field", {
			id: "PVT_kwAA1",
			name: "Due",
			data_type: "DATE",
			options: ["x"],
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("only applies to SINGLE_SELECT");
		expect(calls).toHaveLength(0);
	});
});

describe("delete_project_field", () => {
	it("deletes a field by node ID and confirms with its name", async () => {
		const { handlers, server } = captureHandlers();
		let capturedVars;
		const octokit = stubOctokit(async (_query, vars) => {
			capturedVars = vars;
			return {
				deleteProjectV2Field: {
					projectV2Field: { id: "PVTF_1", name: "Priority", dataType: "TEXT" },
				},
			};
		});
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "delete_project_field", { field_id: "PVTF_1" });
		expect(capturedVars).toEqual({ fieldId: "PVTF_1" });
		expect(result.content[0].text).toBe('Deleted field "Priority" (TEXT, `PVTF_1`).');
		expect(result.isError).toBeUndefined();
	});

	it("errors when the mutation returns no field", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({ deleteProjectV2Field: { projectV2Field: null } }));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "delete_project_field", { field_id: "PVTF_gone" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to delete field `PVTF_gone`.");
	});
});

describe("archive_project_item", () => {
	it("archives an item", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub({ archiveProjectV2Item: { item: { id: "PVTI_9" } } });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "archive_project_item", {
			owner: "acme",
			number: 4,
			item_id: "PVTI_9",
		});
		expect(calls[1].query).toContain("archiveProjectV2Item(");
		expect(calls[1].vars).toEqual({ projectId: "PVT_kwAA1", itemId: "PVTI_9" });
		expect(result.content[0].text).toBe('Archived item `PVTI_9` in project #4 "Roadmap".');
		expect(result.isError).toBeUndefined();
	});

	it("unarchives an item when undo is true", async () => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub({ unarchiveProjectV2Item: { item: { id: "PVTI_9" } } });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "archive_project_item", {
			id: "PVT_kwAA1",
			item_id: "PVTI_9",
			undo: true,
		});
		expect(calls[1].query).toContain("unarchiveProjectV2Item(");
		expect(result.content[0].text).toBe('Unarchived item `PVTI_9` in project #4 "Roadmap".');
	});

	it("errors when the mutation returns no item", async () => {
		const { handlers, server } = captureHandlers();
		const { octokit } = writeStub({ archiveProjectV2Item: { item: null } });
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "archive_project_item", {
			id: "PVT_kwAA1",
			item_id: "PVTI_gone",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to archive item `PVTI_gone` in project #4.");
	});
});

// Every project-ref-taking write tool must reject an ambiguous ref (both `id`
// and `owner` + `number`) before any API call — including before its own
// secondary validation (update_project's no-op check and create_project_field's
// options check deliberately trip here too, proving the ref-error precedence
// the handlers claim).
describe("write tools reject an ambiguous project ref before calling the API", () => {
	it.each([
		// update_project: no change fields supplied → ref error must still win.
		["update_project", {}],
		["delete_project", {}],
		["copy_project", { title: "t" }],
		["link_project_to_repository", { repo_owner: "acme", repo: "web" }],
		["unlink_project_from_repository", { repo_owner: "acme", repo: "web" }],
		// create_project_field: SINGLE_SELECT without options → ref error must still win.
		["create_project_field", { name: "f", data_type: "SINGLE_SELECT" }],
		["archive_project_item", { item_id: "PVTI_1" }],
	])("%s", async (toolName, extraParams) => {
		const { handlers, server } = captureHandlers();
		const { calls, octokit } = writeStub({});
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, toolName, {
			id: "PVT_kwAA1",
			owner: "acme",
			number: 4,
			...extraParams,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not both");
		expect(calls).toHaveLength(0);
	});
});

describe("list_project_items archived visibility", () => {
	const archivedItem = {
		id: "PVTI_arch",
		type: "ISSUE",
		isArchived: true,
		fieldValueByName: null,
		content: {
			title: "Old task",
			number: 2,
			repository: { nameWithOwner: "acme/web" },
			assignees: { totalCount: 0, nodes: [] },
		},
	};

	it("omits archivedStates by default so the API-side NOT_ARCHIVED default applies", async () => {
		const { handlers, server } = captureHandlers();
		let capturedVars;
		const octokit = stubOctokit(async (_query, vars) => {
			capturedVars = vars;
			return { repositoryOwner: { projectV2: { number: 4, title: "Roadmap", items: page([]) } } };
		});
		registerProjectTools(server, () => octokit);

		await invoke(handlers, "list_project_items", { owner: "acme", number: 4, per_page: 30 });
		expect(capturedVars).toEqual({ owner: "acme", number: 4, first: 30, after: undefined });
		expect("archivedStates" in capturedVars ? capturedVars.archivedStates : undefined).toBe(
			undefined,
		);
	});

	it("passes both archived states and marks archived rows when include_archived is true", async () => {
		const { handlers, server } = captureHandlers();
		let capturedVars;
		const octokit = stubOctokit(async (_query, vars) => {
			capturedVars = vars;
			return {
				repositoryOwner: {
					projectV2: { number: 4, title: "Roadmap", items: page([archivedItem]) },
				},
			};
		});
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_project_items", {
			owner: "acme",
			number: 4,
			per_page: 30,
			include_archived: true,
		});
		expect(capturedVars.archivedStates).toEqual(["ARCHIVED", "NOT_ARCHIVED"]);
		expect(result.content[0].text).toContain(
			"- ISSUE — Old task (acme/web#2) — archived — id: `PVTI_arch`",
		);
	});
});
