import { describe, expect, it } from "vitest";

import { registerActionTools } from "../src/tools/actions.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const stubOctokit = (overrides) => ({
	rest: {
		actions: {
			listWorkflowRuns: async () => ({ data: { workflow_runs: [] }, headers: {} }),
			listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [] }, headers: {} }),
			getWorkflowRun: async () => ({ data: {}, headers: {} }),
			listJobsForWorkflowRun: async () => ({ data: { jobs: [] }, headers: {} }),
			...overrides,
		},
	},
});

const sampleRun = (overrides = {}) => ({
	id: 1234567890,
	name: "CI",
	status: "completed",
	conclusion: "success",
	event: "push",
	head_branch: "main",
	head_sha: "abcdef1234567890",
	created_at: "2026-06-01T00:00:00Z",
	...overrides,
});

describe("registerActionTools", () => {
	it("list_workflow_runs renders run ID, name, outcome, event, branch, SHA, time", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			listWorkflowRunsForRepo: async () => ({
				data: { workflow_runs: [sampleRun()] },
				headers: {},
			}),
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "list_workflow_runs", { owner: "o", repo: "r" });
		const body = result.content[0].text;
		expect(body).toContain("# Workflow runs (1)");
		expect(body).toContain(
			"`1234567890` **CI** — success (push on `main` @ `abcdef1`), 2026-06-01T00:00:00Z",
		);
		expect(result.isError).toBeUndefined();
	});

	it("list_workflow_runs shows in-flight status when conclusion is null", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			listWorkflowRunsForRepo: async () => ({
				data: { workflow_runs: [sampleRun({ status: "in_progress", conclusion: null })] },
				headers: {},
			}),
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "list_workflow_runs", { owner: "o", repo: "r" });
		expect(result.content[0].text).toContain("**CI** — in_progress");
	});

	it("list_workflow_runs uses the per-workflow endpoint when workflow_id is given", async () => {
		const { handlers, server } = captureHandlers();
		let repoWideCalled = false;
		let captured;
		const octokit = stubOctokit({
			listWorkflowRunsForRepo: async () => {
				repoWideCalled = true;
				return { data: { workflow_runs: [] }, headers: {} };
			},
			listWorkflowRuns: async (params) => {
				captured = params;
				return { data: { workflow_runs: [sampleRun()] }, headers: {} };
			},
		});
		registerActionTools(server, () => octokit);

		await invoke(handlers, "list_workflow_runs", {
			owner: "o",
			repo: "r",
			workflow_id: "ci.yml",
			branch: "dev",
			event: "pull_request",
			status: "failure",
			per_page: 10,
			page: 2,
		});
		expect(repoWideCalled).toBe(false);
		expect(captured).toMatchObject({
			owner: "o",
			repo: "r",
			workflow_id: "ci.yml",
			branch: "dev",
			event: "pull_request",
			status: "failure",
			per_page: 10,
			page: 2,
		});
	});

	it("list_workflow_runs shows a pagination hint when a next link is present", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			listWorkflowRunsForRepo: async () => ({
				data: { workflow_runs: [sampleRun()] },
				headers: { link: '<https://api.github.com/...?page=2>; rel="next"' },
			}),
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "list_workflow_runs", { owner: "o", repo: "r", page: 1 });
		expect(result.content[0].text).toContain("page 1, 1 shown; more available");
	});

	it("list_workflow_runs reports an empty result", async () => {
		const { handlers, server } = captureHandlers();
		registerActionTools(server, () => stubOctokit({}));

		const result = await invoke(handlers, "list_workflow_runs", { owner: "o", repo: "r" });
		expect(result.content[0].text).toBe("(no workflow runs found)");
	});

	it("get_workflow_run renders header, outcome, event/actor, branch, attempt, URL", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			getWorkflowRun: async () => ({
				data: {
					id: 999,
					name: "Deploy",
					status: "completed",
					conclusion: "failure",
					event: "workflow_dispatch",
					triggering_actor: { login: "alice" },
					actor: { login: "bob" },
					head_branch: "release",
					head_sha: "feedface00001111",
					run_attempt: 2,
					created_at: "2026-06-02T01:00:00Z",
					updated_at: "2026-06-02T01:05:00Z",
					html_url: "https://example.test/run/999",
				},
				headers: {},
			}),
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "get_workflow_run", {
			owner: "o",
			repo: "r",
			run_id: 999,
		});
		const body = result.content[0].text;
		expect(body).toContain("# Workflow run `999` in o/r");
		expect(body).toContain("> Deploy — failure");
		expect(body).toContain("- event: workflow_dispatch (by alice)");
		expect(body).toContain("- branch: `release` @ `feedfac`");
		expect(body).toContain("- attempt: 2");
		expect(body).toContain("- https://example.test/run/999");
	});

	it("get_workflow_run falls back to actor when triggering_actor is absent", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			getWorkflowRun: async () => ({
				data: {
					id: 1,
					name: "CI",
					status: "completed",
					conclusion: "success",
					event: "push",
					triggering_actor: null,
					actor: { login: "bob" },
					head_branch: "main",
					head_sha: "0011223344",
					run_attempt: 1,
					created_at: "2026-06-02T00:00:00Z",
					updated_at: "2026-06-02T00:01:00Z",
					html_url: "https://example.test/run/1",
				},
				headers: {},
			}),
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "get_workflow_run", { owner: "o", repo: "r", run_id: 1 });
		expect(result.content[0].text).toContain("(by bob)");
	});

	it("list_workflow_run_jobs renders each job and its per-step outcome", async () => {
		const { handlers, server } = captureHandlers();
		let captured;
		const octokit = stubOctokit({
			listJobsForWorkflowRun: async (params) => {
				captured = params;
				return {
					data: {
						jobs: [
							{
								id: 42,
								name: "type-check",
								status: "completed",
								conclusion: "failure",
								steps: [
									{ name: "Checkout", status: "completed", conclusion: "success" },
									{ name: "tsc", status: "completed", conclusion: "failure" },
								],
							},
						],
					},
					headers: {},
				};
			},
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "list_workflow_run_jobs", {
			owner: "o",
			repo: "r",
			run_id: 7,
			filter: "all",
		});
		const body = result.content[0].text;
		// The handler forwards `filter` to Octokit as given (Zod applies the
		// "latest" default before the handler runs in production; this harness
		// calls the handler directly, so it passes through whatever is supplied).
		expect(captured.filter).toBe("all");
		expect(body).toContain("# Jobs for run 7 (1)");
		expect(body).toContain("`42` **type-check** — failure");
		expect(body).toContain("  - Checkout: success");
		expect(body).toContain("  - tsc: failure");
	});

	it("list_workflow_run_jobs handles a job with no steps", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			listJobsForWorkflowRun: async () => ({
				data: { jobs: [{ id: 1, name: "build", status: "queued", conclusion: null, steps: [] }] },
				headers: {},
			}),
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "list_workflow_run_jobs", {
			owner: "o",
			repo: "r",
			run_id: 7,
		});
		const body = result.content[0].text;
		expect(body).toContain("`1` **build** — queued");
		expect(body).toContain("  - (no steps reported)");
	});

	it("list_workflow_run_jobs reports an empty result", async () => {
		const { handlers, server } = captureHandlers();
		registerActionTools(server, () => stubOctokit({}));

		const result = await invoke(handlers, "list_workflow_run_jobs", {
			owner: "o",
			repo: "r",
			run_id: 7,
		});
		expect(result.content[0].text).toBe("(no jobs found for this run)");
	});

	it("get_workflow_run surfaces Octokit errors via wrapTool (isError = true)", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			getWorkflowRun: async () => {
				const err = new Error("Not Found");
				err.status = 404;
				throw err;
			},
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "get_workflow_run", {
			owner: "o",
			repo: "r",
			run_id: 0 + 1,
		});
		expect(result.isError).toBe(true);
		const body = result.content[0].text;
		expect(body).toContain("Not Found");
		expect(body).toContain("HTTP 404");
	});
});
