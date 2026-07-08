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
	it("registers the four read tools and four write tools", () => {
		const { handlers, server } = captureHandlers();
		registerProjectTools(server, () => stubOctokit(async () => ({})));
		expect(handlers.has("list_projects")).toBe(true);
		expect(handlers.has("get_project")).toBe(true);
		expect(handlers.has("list_project_items")).toBe(true);
		expect(handlers.has("list_project_fields")).toBe(true);
		expect(handlers.has("add_project_item")).toBe(true);
		expect(handlers.has("remove_project_item")).toBe(true);
		expect(handlers.has("update_project_item_field")).toBe(true);
		expect(handlers.has("create_project_draft_item")).toBe(true);
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
