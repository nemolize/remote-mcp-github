import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	logRateLimit,
	MAX_RESPONSE_CHARS,
	restListHeader,
	text,
	truncate,
	truncateTail,
	wrapTool,
} from "../mcp/response.js";
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
// The per-use-site `.describe()` carries the field documentation (its sole use
// re-describes it), so none is set here.
const WorkflowId = z.union([z.number().int().positive(), z.string().min(1)]);

// Artifact sizes span bytes to gigabytes; a binary-prefixed rendering keeps the
// list line readable at every scale (raw byte counts are unreadable past ~1 MiB).
const formatBytes = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
};

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
					// The full set GitHub's `status` query param accepts — a union of
					// lifecycle states and conclusions. Kept complete so a query for
					// any valid outcome (e.g. `timed_out`, `action_required`) is not
					// rejected by schema validation before reaching GitHub.
					.enum([
						"queued",
						"in_progress",
						"completed",
						"waiting",
						"requested",
						"pending",
						"success",
						"failure",
						"neutral",
						"cancelled",
						"skipped",
						"stale",
						"timed_out",
						"action_required",
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
				const { data, headers } = await client().rest.actions.listJobsForWorkflowRun(
					stripUndefined({
						owner,
						repo,
						run_id,
						filter,
						per_page,
						page,
					}),
				);
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

	server.registerTool(
		"list_workflows",
		{
			description:
				"List the workflows defined in a repository (one line per workflow: ID, name, state, path). Use to discover what CI/CD pipelines exist and to find a `workflow_id` to filter `list_workflow_runs` or to dispatch. Returns the workflow file path so the definition can be read with `get_file_contents`.",
			inputSchema: {
				...RepoTarget,
				per_page: z.number().int().min(1).max(100).optional().default(30),
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number (1-indexed). Defaults to 1."),
			},
		},
		async ({ owner, repo, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.actions.listRepoWorkflows(
					stripUndefined({ owner, repo, per_page, page }),
				);
				logRateLimit(headers);
				if (data.workflows.length === 0) return text("(no workflows found)");
				const lines = data.workflows.map(
					(w) => `- \`${w.id}\` **${w.name}** — ${w.state} (\`${w.path}\`)`,
				);
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: "Workflows",
					count: data.workflows.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"get_job_logs",
		{
			description:
				"Fetch the plain-text logs of a single workflow-run job — the 'why did it fail?' lookup once `list_workflow_run_jobs` has pinpointed the failed job by ID. Returns the job log tail-truncated to the response cap (CI failures surface at the end). May require elevated repository permissions: GitHub can return 403 'Must have admin rights' for accounts without sufficient access (a permission level, not an OAuth scope). Logs for an old run attempt may have expired; GitHub then returns 410 Gone.",
			inputSchema: {
				...RepoTarget,
				job_id: z.number().int().positive().describe("Job ID (from `list_workflow_run_jobs`)."),
			},
		},
		async ({ owner, repo, job_id }) =>
			wrapTool(async () => {
				// GitHub responds 302 to a short-lived log URL; Octokit follows the
				// redirect and returns the log body as text. Typed as `unknown` here
				// because the rest-endpoint types model the pre-redirect 302 (no body)
				// rather than the followed text response.
				const { data, headers } = await client().rest.actions.downloadJobLogsForWorkflowRun({
					owner,
					repo,
					job_id,
				});
				logRateLimit(headers);
				const logText = typeof data === "string" ? data : String(data);
				if (logText.length === 0) return text(`(no logs for job ${job_id})`);
				const header = `# Logs for job ${job_id} in ${owner}/${repo}\n\n`;
				// Keep the header outside the truncated region (it's not part of the
				// log) and reserve its length from the cap so header + tail stays
				// within MAX_RESPONSE_CHARS. The follow-up instruction is log-specific:
				// this tool already targets one job and can't paginate, so point the
				// reader at the run's other jobs / the run page rather than "paginate".
				return text(
					`${header}${truncateTail(
						logText,
						MAX_RESPONSE_CHARS - header.length,
						"Inspect a more specific job, or open the run on GitHub, to see earlier output.",
					)}`,
				);
			}),
	);

	server.registerTool(
		"list_workflow_run_artifacts",
		{
			description:
				"List the artifacts produced by a workflow run (one line per artifact: ID, name, size, expiry). Use when the user asks what a build produced or wants a build output. Returns each artifact's ID for `get_artifact`. Artifacts are zip archives; this tool reports metadata only and never downloads or unpacks them.",
			inputSchema: {
				...RepoTarget,
				run_id: z.number().int().positive().describe("Workflow run ID."),
				name: z
					.string()
					.optional()
					.describe(
						"Only artifacts with exactly this name (the name set by `actions/upload-artifact`).",
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
		async ({ owner, repo, run_id, name, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.actions.listWorkflowRunArtifacts(
					stripUndefined({ owner, repo, run_id, name, per_page, page }),
				);
				logRateLimit(headers);
				if (data.artifacts.length === 0) return text("(no artifacts found for this run)");
				const lines = data.artifacts.map((a) => {
					const expiry = a.expired ? "expired" : `expires ${a.expires_at ?? "(unknown)"}`;
					return `- \`${a.id}\` **${a.name}** — ${formatBytes(a.size_in_bytes)}, ${expiry}, created ${a.created_at ?? "(unknown)"}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: `Artifacts for run ${run_id}`,
					count: data.artifacts.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"get_artifact",
		{
			description:
				"Fetch a single artifact's metadata: name, size, expiry, the producing workflow run, and the archive download URL. Use after `list_workflow_run_artifacts` to inspect one artifact by ID. The artifact is a zip archive — this tool returns its metadata and download URL only (no download / unzip); fetching the URL requires an authenticated GitHub API request.",
			inputSchema: {
				...RepoTarget,
				artifact_id: z
					.number()
					.int()
					.positive()
					.describe("Artifact ID (from `list_workflow_run_artifacts`)."),
			},
		},
		async ({ owner, repo, artifact_id }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.actions.getArtifact({
					owner,
					repo,
					artifact_id,
				});
				logRateLimit(headers);
				const expiry = data.expired ? "expired" : `expires ${data.expires_at ?? "(unknown)"}`;
				// `workflow_run` and its `id` are both optional in the API schema — guard
				// the id too so a partial block renders "(unknown)" rather than a literal
				// `undefined` (head_branch / head_sha already have their own fallbacks).
				const run = data.workflow_run;
				const runLine =
					run?.id != null
						? `- from run: \`${run.id}\` (branch \`${run.head_branch ?? "?"}\` @ \`${run.head_sha?.slice(0, 7) ?? "?"}\`)`
						: "- from run: (unknown)";
				const lines = [
					`# Artifact \`${data.id}\` in ${owner}/${repo}`,
					"",
					`> ${data.name} — ${formatBytes(data.size_in_bytes)} (zip)`,
					"",
					`- ${expiry}`,
					`- created: ${data.created_at ?? "(unknown)"}`,
					`- updated: ${data.updated_at ?? "(unknown)"}`,
					runLine,
					`- download (authenticated API request): ${data.archive_download_url}`,
				];
				return text(truncate(lines.join("\n")));
			}),
	);
};
