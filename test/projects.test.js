import { describe, expect, it } from "vitest";

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
	it("registers all four read tools", () => {
		const { handlers, server } = captureHandlers();
		registerProjectTools(server, () => stubOctokit(async () => ({})));
		expect(handlers.has("list_projects")).toBe(true);
		expect(handlers.has("get_project")).toBe(true);
		expect(handlers.has("list_project_items")).toBe(true);
		expect(handlers.has("list_project_fields")).toBe(true);
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
				{ name: "Title", dataType: "TITLE" },
				{
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
		expect(body).toContain("- Title — TITLE");
		expect(body).toContain("- Status — SINGLE_SELECT — options: Todo (`opt1`), Done (`opt2`)");
		expect(result.isError).toBeUndefined();
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
					type: "ISSUE",
					fieldValueByName: { name: "In Progress" },
					content: {
						title: "Fix login bug",
						number: 12,
						repository: { nameWithOwner: "acme/web" },
						assignees: { nodes: [{ login: "alice" }, { login: "bob" }] },
					},
				},
				{
					type: "PULL_REQUEST",
					fieldValueByName: null,
					content: {
						title: "Add cache layer",
						number: 34,
						repository: { nameWithOwner: "acme/api" },
						assignees: { nodes: [] },
					},
				},
				{
					type: "DRAFT_ISSUE",
					fieldValueByName: { name: "Todo" },
					content: { title: "Investigate flakiness", assignees: { nodes: [] } },
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
			"- ISSUE — Fix login bug (acme/web#12) — status: In Progress — @alice, @bob",
		);
		expect(body).toContain("- PULL_REQUEST — Add cache layer (acme/api#34)");
		expect(body).toContain("- DRAFT_ISSUE — Investigate flakiness — status: Todo");
		expect(result.isError).toBeUndefined();
	});

	it("truncates a large page without dropping the cursor hint", async () => {
		const { handlers, server } = captureHandlers();
		const items = Array.from({ length: 200 }, (_, i) => ({
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
});

describe("list_project_fields", () => {
	it("renders field rows with data types and single-select option IDs", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({
			node: {
				number: 4,
				title: "Roadmap",
				fields: page([
					{ name: "Title", dataType: "TITLE" },
					{
						name: "Status",
						dataType: "SINGLE_SELECT",
						options: [
							{ id: "47fc9ee4", name: "Todo" },
							{ id: "98236657", name: "In Progress" },
						],
					},
					{ name: "Iteration", dataType: "ITERATION" },
				]),
			},
		}));
		registerProjectTools(server, () => octokit);

		const result = await invoke(handlers, "list_project_fields", { id: "PVT_kwAA1", per_page: 30 });
		const body = result.content[0].text;
		expect(body).toContain('# Project #4 "Roadmap" — fields (3)');
		expect(body).toContain("- Title — TITLE");
		expect(body).toContain(
			"- Status — SINGLE_SELECT — options: Todo (`47fc9ee4`), In Progress (`98236657`)",
		);
		expect(body).toContain("- Iteration — ITERATION");
		expect(result.isError).toBeUndefined();
	});

	it("appends the cursor hint when more fields exist", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(async () => ({
			node: {
				number: 4,
				title: "Roadmap",
				fields: page([{ name: "Title", dataType: "TITLE" }], {
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
});
