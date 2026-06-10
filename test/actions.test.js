import { describe, expect, it } from "vitest";

import { registerActionTools } from "../src/tools/actions.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const stubOctokit = (overrides, { request } = {}) => ({
	request: request ?? (async () => ({ data: "", headers: {} })),
	rest: {
		actions: {
			listWorkflowRuns: async () => ({ data: { workflow_runs: [] }, headers: {} }),
			listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [] }, headers: {} }),
			getWorkflowRun: async () => ({ data: {}, headers: {} }),
			listJobsForWorkflowRun: async () => ({ data: { jobs: [] }, headers: {} }),
			listRepoWorkflows: async () => ({ data: { workflows: [] }, headers: {} }),
			downloadJobLogsForWorkflowRun: async () => ({ data: "", headers: {} }),
			listWorkflowRunArtifacts: async () => ({ data: { artifacts: [] }, headers: {} }),
			getArtifact: async () => ({ data: {}, headers: {} }),
			reRunWorkflow: async () => ({ data: {}, headers: {} }),
			reRunWorkflowFailedJobs: async () => ({ data: {}, headers: {} }),
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

	it("list_workflows renders each workflow's ID, name, state, and path", async () => {
		const { handlers, server } = captureHandlers();
		let captured;
		const octokit = stubOctokit({
			listRepoWorkflows: async (params) => {
				captured = params;
				return {
					data: {
						workflows: [
							{ id: 101, name: "CI", state: "active", path: ".github/workflows/ci.yml" },
							{
								id: 102,
								name: "Deploy",
								state: "disabled_manually",
								path: ".github/workflows/deploy.yml",
							},
						],
					},
					headers: {},
				};
			},
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "list_workflows", {
			owner: "o",
			repo: "r",
			per_page: 50,
			page: 2,
		});
		const body = result.content[0].text;
		expect(captured).toMatchObject({ owner: "o", repo: "r", per_page: 50, page: 2 });
		expect(body).toContain("# Workflows (2)");
		expect(body).toContain("`101` **CI** — active (`.github/workflows/ci.yml`)");
		expect(body).toContain("`102` **Deploy** — disabled_manually (`.github/workflows/deploy.yml`)");
		expect(result.isError).toBeUndefined();
	});

	it("list_workflows reports an empty result", async () => {
		const { handlers, server } = captureHandlers();
		registerActionTools(server, () => stubOctokit({}));

		const result = await invoke(handlers, "list_workflows", { owner: "o", repo: "r" });
		expect(result.content[0].text).toBe("(no workflows found)");
	});

	it("get_job_logs returns the job log under a heading", async () => {
		const { handlers, server } = captureHandlers();
		let captured;
		const octokit = stubOctokit({
			downloadJobLogsForWorkflowRun: async (params) => {
				captured = params;
				return { data: "2026-06-01 step one ok\n2026-06-01 step two FAILED\n", headers: {} };
			},
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "get_job_logs", { owner: "o", repo: "r", job_id: 42 });
		const body = result.content[0].text;
		expect(captured).toMatchObject({ owner: "o", repo: "r", job_id: 42 });
		expect(body).toContain("# Logs for job 42 in o/r");
		expect(body).toContain("step two FAILED");
		expect(result.isError).toBeUndefined();
	});

	it("get_job_logs keeps the tail and drops leading lines when over the cap", async () => {
		const { handlers, server } = captureHandlers();
		// Build a log far larger than the 8000-char response cap, with a unique
		// marker only at the very end so we can assert the tail is retained.
		const filler = "x".repeat(20000);
		const octokit = stubOctokit({
			downloadJobLogsForWorkflowRun: async () => ({
				data: `${filler}\nTAIL_MARKER_FAILURE`,
				headers: {},
			}),
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "get_job_logs", { owner: "o", repo: "r", job_id: 1 });
		const body = result.content[0].text;
		expect(body).toContain("TAIL_MARKER_FAILURE");
		expect(body).toContain("leading characters omitted");
		// The head filler must be gone (we can't fit 20k chars under the cap).
		expect(body).not.toContain(filler);
	});

	it("get_job_logs reports an empty log", async () => {
		const { handlers, server } = captureHandlers();
		registerActionTools(server, () => stubOctokit({}));

		const result = await invoke(handlers, "get_job_logs", { owner: "o", repo: "r", job_id: 9 });
		expect(result.content[0].text).toBe("(no logs for job 9)");
	});

	it("get_workflow_run_logs returns the short-lived archive URL without following the redirect", async () => {
		const { handlers, server } = captureHandlers();
		let captured;
		const octokit = stubOctokit(
			{},
			{
				request: async (route, params) => {
					captured = { route, params };
					return {
						status: 302,
						data: "",
						headers: { location: "https://logs.example/archive.zip?sig=abc" },
					};
				},
			},
		);
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "get_workflow_run_logs", {
			owner: "o",
			repo: "r",
			run_id: 555,
		});
		const body = result.content[0].text;
		expect(captured.route).toContain("/actions/runs/{run_id}/logs");
		expect(captured.params).toMatchObject({
			owner: "o",
			repo: "r",
			run_id: 555,
			request: { redirect: "manual" },
		});
		expect(body).toContain("# Logs for run 555 in o/r");
		expect(body).toContain("https://logs.example/archive.zip?sig=abc");
		expect(body).toContain("get_job_logs");
		expect(result.isError).toBeUndefined();
	});

	it("get_workflow_run_logs reports when no archive URL is returned", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(
			{},
			{ request: async () => ({ status: 302, data: "", headers: {} }) },
		);
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "get_workflow_run_logs", {
			owner: "o",
			repo: "r",
			run_id: 7,
		});
		expect(result.content[0].text).toBe("(no log archive URL returned for run 7)");
	});

	it("list_workflow_run_artifacts renders ID, name, size, expiry, created time", async () => {
		const { handlers, server } = captureHandlers();
		let captured;
		const octokit = stubOctokit({
			listWorkflowRunArtifacts: async (params) => {
				captured = params;
				return {
					data: {
						artifacts: [
							{
								id: 555,
								name: "dist",
								size_in_bytes: 1536,
								expired: false,
								expires_at: "2026-09-01T00:00:00Z",
								created_at: "2026-06-01T00:00:00Z",
							},
							{
								id: 556,
								name: "coverage",
								size_in_bytes: 100,
								expired: true,
								expires_at: "2026-05-01T00:00:00Z",
								created_at: "2026-04-01T00:00:00Z",
							},
						],
					},
					headers: {},
				};
			},
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "list_workflow_run_artifacts", {
			owner: "o",
			repo: "r",
			run_id: 7,
			name: "dist",
			per_page: 10,
			page: 2,
		});
		const body = result.content[0].text;
		expect(captured).toMatchObject({
			owner: "o",
			repo: "r",
			run_id: 7,
			name: "dist",
			per_page: 10,
			page: 2,
		});
		expect(body).toContain("# Artifacts for run 7 (2)");
		expect(body).toContain(
			"`555` **dist** — 1.5 KiB, expires 2026-09-01T00:00:00Z, created 2026-06-01T00:00:00Z",
		);
		expect(body).toContain("`556` **coverage** — 100 B, expired, created 2026-04-01T00:00:00Z");
		expect(result.isError).toBeUndefined();
	});

	it("list_workflow_run_artifacts reports an empty result", async () => {
		const { handlers, server } = captureHandlers();
		registerActionTools(server, () => stubOctokit({}));

		const result = await invoke(handlers, "list_workflow_run_artifacts", {
			owner: "o",
			repo: "r",
			run_id: 7,
		});
		expect(result.content[0].text).toBe("(no artifacts found for this run)");
	});

	it("get_artifact renders metadata, producing run, and download URL", async () => {
		const { handlers, server } = captureHandlers();
		let captured;
		const octokit = stubOctokit({
			getArtifact: async (params) => {
				captured = params;
				return {
					data: {
						id: 555,
						name: "dist",
						size_in_bytes: 2 * 1024 * 1024,
						expired: false,
						expires_at: "2026-09-01T00:00:00Z",
						created_at: "2026-06-01T00:00:00Z",
						updated_at: "2026-06-01T00:05:00Z",
						workflow_run: { id: 999, head_branch: "main", head_sha: "abcdef1234567890" },
						archive_download_url: "https://api.github.com/repos/o/r/actions/artifacts/555/zip",
					},
					headers: {},
				};
			},
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "get_artifact", {
			owner: "o",
			repo: "r",
			artifact_id: 555,
		});
		const body = result.content[0].text;
		expect(captured).toMatchObject({ owner: "o", repo: "r", artifact_id: 555 });
		expect(body).toContain("# Artifact `555` in o/r");
		expect(body).toContain("> dist — 2.0 MiB (zip)");
		expect(body).toContain("- expires 2026-09-01T00:00:00Z");
		expect(body).toContain("- from run: `999` (branch `main` @ `abcdef1`)");
		expect(body).toContain(
			"- download (authenticated API request): https://api.github.com/repos/o/r/actions/artifacts/555/zip",
		);
		expect(result.isError).toBeUndefined();
	});

	it("get_artifact handles a missing workflow_run block", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			getArtifact: async () => ({
				data: {
					id: 1,
					name: "logs",
					size_in_bytes: 10,
					expired: true,
					expires_at: null,
					created_at: null,
					updated_at: null,
					workflow_run: null,
					archive_download_url: "https://api.github.com/repos/o/r/actions/artifacts/1/zip",
				},
				headers: {},
			}),
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "get_artifact", {
			owner: "o",
			repo: "r",
			artifact_id: 1,
		});
		const body = result.content[0].text;
		expect(body).toContain("- expired");
		expect(body).toContain("- created: (unknown)");
		expect(body).toContain("- from run: (unknown)");
	});

	it("get_artifact handles a workflow_run block whose id is absent", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			getArtifact: async () => ({
				data: {
					id: 2,
					name: "logs",
					size_in_bytes: 10,
					expired: false,
					expires_at: "2026-09-01T00:00:00Z",
					created_at: "2026-06-01T00:00:00Z",
					updated_at: "2026-06-01T00:00:00Z",
					workflow_run: { head_branch: "main" },
					archive_download_url: "https://api.github.com/repos/o/r/actions/artifacts/2/zip",
				},
				headers: {},
			}),
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "get_artifact", {
			owner: "o",
			repo: "r",
			artifact_id: 2,
		});
		const body = result.content[0].text;
		expect(body).toContain("- from run: (unknown)");
		expect(body).not.toContain("undefined");
	});

	it("rerun_workflow_run returns confirmation with run ID and repo", async () => {
		const { handlers, server } = captureHandlers();
		let capturedParams;
		const octokit = stubOctokit({
			reRunWorkflow: async (params) => {
				capturedParams = params;
				return { data: {}, headers: {} };
			},
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "rerun_workflow_run", {
			owner: "o",
			repo: "r",
			run_id: 999,
			enable_debug_logging: true,
		});
		const body = result.content[0].text;
		expect(body).toContain("# Re-run requested");
		expect(body).toContain("`999`");
		expect(body).toContain("o/r");
		expect(body).toContain("all jobs");
		expect(result.isError).toBeUndefined();
		// Verify the correct Octokit method was called with the right params
		expect(capturedParams).toMatchObject({
			owner: "o",
			repo: "r",
			run_id: 999,
			enable_debug_logging: true,
		});
	});

	it("rerun_workflow_run surfaces Octokit errors via wrapTool (isError = true)", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			reRunWorkflow: async () => {
				const err = new Error("Forbidden");
				err.status = 403;
				throw err;
			},
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "rerun_workflow_run", {
			owner: "o",
			repo: "r",
			run_id: 1,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("HTTP 403");
	});

	it("rerun_failed_jobs returns confirmation with run ID and repo", async () => {
		const { handlers, server } = captureHandlers();
		let capturedParams;
		const octokit = stubOctokit({
			reRunWorkflowFailedJobs: async (params) => {
				capturedParams = params;
				return { data: {}, headers: {} };
			},
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "rerun_failed_jobs", {
			owner: "o",
			repo: "r",
			run_id: 888,
			enable_debug_logging: false,
		});
		const body = result.content[0].text;
		expect(body).toContain("# Re-run requested (failed jobs)");
		expect(body).toContain("`888`");
		expect(body).toContain("o/r");
		expect(result.isError).toBeUndefined();
		// Verify the correct Octokit method was called with the right params
		// enable_debug_logging: false is stripped by stripUndefined (false is falsy but not
		// undefined — stripUndefined only removes undefined values, so false passes through)
		expect(capturedParams).toMatchObject({ owner: "o", repo: "r", run_id: 888 });
	});

	it("rerun_failed_jobs surfaces Octokit errors via wrapTool (isError = true)", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			reRunWorkflowFailedJobs: async () => {
				const err = new Error("Not Found");
				err.status = 404;
				throw err;
			},
		});
		registerActionTools(server, () => octokit);

		const result = await invoke(handlers, "rerun_failed_jobs", {
			owner: "o",
			repo: "r",
			run_id: 1,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("HTTP 404");
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
