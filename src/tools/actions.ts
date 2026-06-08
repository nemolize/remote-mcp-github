import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logRateLimit, restListHeader, text, truncate, wrapTool } from "../mcp/response.js";
import { stripUndefined } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";

// A run / job carries a `status` (lifecycle) and, once finished, a
// `conclusion` (outcome). Surfacing them together as one token is what the
// "is CI green? / what failed?" loop reads, so collapse the pair into a single
// human-facing label: the conclusion when present, else the in-flight status.
const outcomeOf = (status: string | null, conclusion: string | null): string =>
	conclusion ?? status ?? "(unknown)";

// `workflow_id` accepts either a filename (`ci.yml`) or a numeric ID, matching
// GitHub's own polymorphism. Octokit types the path param as `number`, but the
// REST endpoint resolves a filename string too, so a string is forwarded as-is.
const WorkflowId = z
	.union([z.number().int().positive(), z.string().min(1)])
	.describe("Workflow filename (e.g. 'ci.yml') or numeric ID.");

export const registerActionTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"list_workflow_runs",
		{
			description:
				"List recent GitHub Actions workflow runs. Use when the user asks whether CI is green, what runs lately, or to find a run to inspect / rerun. Filter by `workflow_id` (one workflow), `branch`, `event`, and `status`. Returns one line per run (run ID, workflow name, outcome, event, branch, head SHA, created time).",
			inputSchema: {
				...RepoTarget,
				workflow_id: WorkflowId.optional().describe(
					"Workflow filename (e.g. 'ci.yml') or numeric ID. Omit to list runs across all workflows.",
				),
				branch: z.string().optional().describe("Only runs on this branch."),
				event: z
					.string()
					.optional()
					.describe(
						"Trigger event (e.g. 'push', 'pull_request', 'workflow_dispatch', 'schedule').",
					),
				status: z
					.enum([
						"queued",
						"in_progress",
						"completed",
						"success",
						"failure",
						"cancelled",
						"skipped",
					])
					.optional()
					.describe("Filter by run status or conclusion."),
				per_page: z.number().int().min(1).max(100).optional().default(20),
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number (1-indexed). Defaults to 1."),
			},
		},
		async ({ owner, repo, workflow_id, branch, event, status, per_page, page }) =>
			wrapTool(async () => {
				// Two distinct endpoints: per-workflow when `workflow_id` is given,
				// repo-wide otherwise. Both share the filter / pagination params and
				// return the same `{ workflow_runs }` shape.
				const params = stripUndefined({
					owner,
					repo,
					branch,
					event,
					status,
					per_page,
					page,
				});
				const { data, headers } =
					workflow_id != null
						? await client().rest.actions.listWorkflowRuns({ ...params, workflow_id })
						: await client().rest.actions.listWorkflowRunsForRepo(params);
				logRateLimit(headers);
				if (data.workflow_runs.length === 0) return text("(no workflow runs found)");
				const lines = data.workflow_runs.map((r) => {
					const outcome = outcomeOf(r.status, r.conclusion);
					const name = r.name ?? "(unnamed)";
					const short = r.head_sha.slice(0, 7);
					return `- \`${r.id}\` **${name}** — ${outcome} (${r.event} on \`${r.head_branch ?? "?"}\` @ \`${short}\`), ${r.created_at}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: "Workflow runs",
					count: data.workflow_runs.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"get_workflow_run",
		{
			description:
				"Fetch a single workflow run's detail: status / conclusion, the workflow name, triggering event and actor, head branch / SHA, run attempt, timestamps, and the URL. Use when the user asks about a specific run by ID. Pair with `list_workflow_run_jobs` to see which job / step failed.",
			inputSchema: {
				...RepoTarget,
				run_id: z.number().int().positive().describe("Workflow run ID."),
			},
		},
		async ({ owner, repo, run_id }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.actions.getWorkflowRun({
					owner,
					repo,
					run_id,
				});
				logRateLimit(headers);
				const outcome = outcomeOf(data.status, data.conclusion);
				const name = data.name ?? "(unnamed)";
				const actor = data.triggering_actor?.login ?? data.actor?.login ?? "(unknown)";
				const short = data.head_sha.slice(0, 7);
				const lines = [
					`# Workflow run \`${data.id}\` in ${owner}/${repo}`,
					"",
					`> ${name} — ${outcome}`,
					"",
					`- event: ${data.event} (by ${actor})`,
					`- branch: \`${data.head_branch ?? "?"}\` @ \`${short}\``,
					`- attempt: ${data.run_attempt ?? 1}`,
					`- created: ${data.created_at}`,
					`- updated: ${data.updated_at}`,
					`- ${data.html_url}`,
				];
				return text(truncate(lines.join("\n")));
			}),
	);

	server.registerTool(
		"list_workflow_run_jobs",
		{
			description:
				"List the jobs of a workflow run with their per-step status — the primary 'what failed?' lookup. Use when a run failed and the user asks which job / step broke. By default returns jobs from the latest attempt; pass `filter: 'all'` for every attempt. Returns each job's outcome plus a bulleted step list with each step's outcome.",
			inputSchema: {
				...RepoTarget,
				run_id: z.number().int().positive().describe("Workflow run ID."),
				filter: z
					.enum(["latest", "all"])
					.optional()
					.default("latest")
					.describe(
						"'latest' (default) returns the last attempt's jobs; 'all' returns every attempt.",
					),
				per_page: z.number().int().min(1).max(100).optional().default(30),
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number (1-indexed). Defaults to 1."),
			},
		},
		async ({ owner, repo, run_id, filter, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.actions.listJobsForWorkflowRun({
					owner,
					repo,
					run_id,
					filter,
					per_page,
					page,
				});
				logRateLimit(headers);
				if (data.jobs.length === 0) return text("(no jobs found for this run)");
				const blocks = data.jobs.map((j) => {
					const outcome = outcomeOf(j.status, j.conclusion);
					const steps = (j.steps ?? []).map(
						(s) => `  - ${s.name}: ${outcomeOf(s.status, s.conclusion)}`,
					);
					const stepText = steps.length > 0 ? `\n${steps.join("\n")}` : "\n  - (no steps reported)";
					return `- \`${j.id}\` **${j.name}** — ${outcome}${stepText}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: `Jobs for run ${run_id}`,
					count: data.jobs.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${blocks.join("\n")}`));
			}),
	);
};
