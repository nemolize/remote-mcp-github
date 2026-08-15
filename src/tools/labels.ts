import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorResult, logRateLimit, logWrite, text, truncate, wrapTool } from "../mcp/response.js";
import { isHttpStatus, stripUndefined } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";

// Label *definition* CRUD, distinct from the issue-side tools that merely apply
// existing labels (`add_labels`, `update_issue`). The `list_labels` read
// companion lives in issues.ts alongside those.

const HEX_COLOR = /^#?[0-9a-fA-F]{6}$/;

const ColorSchema = z
	.string()
	.regex(HEX_COLOR, "Colour must be a 6-digit hex value (e.g. `f29513` or `#f29513`).")
	.describe("6-digit hex colour, with or without a leading `#` (e.g. `f29513`).");

// GitHub stores colours as 6 hex digits with no leading `#`; callers commonly
// pass `#rrggbb`, so strip it (and lower-case) before the API call.
const normalizeColor = (color: string): string => color.replace(/^#/, "").toLowerCase();

// GitHub collides label names case-insensitively, so an index keyed on the raw
// name reads `Bug` as absent beside `bug` and the create then 422s.
const labelKey = (name: string): string => name.toLowerCase();

// GitHub returns 422 for several distinct conditions on `createLabel` (name
// collision, validation failure, abuse detection). Only the collision means
// "already there, safe to skip/overwrite" — the rest must abort the clone, so
// match the error code rather than the bare status.
const isAlreadyExists = (err: unknown): boolean => {
	if (!isHttpStatus(err, 422)) return false;
	if (err == null || typeof err !== "object" || !("response" in err)) return false;
	const response: unknown = err.response;
	if (response == null || typeof response !== "object" || !("data" in response)) return false;
	const data: unknown = response.data;
	if (data == null || typeof data !== "object" || !("errors" in data)) return false;
	const errors: unknown = data.errors;
	if (!Array.isArray(errors)) return false;
	return errors.some(
		(e: unknown) =>
			e != null && typeof e === "object" && "code" in e && e.code === "already_exists",
	);
};

const labelLine = (l: { name: string; color: string; description?: string | null }): string => {
	const desc = l.description != null && l.description.length > 0 ? ` — ${l.description}` : "";
	return `- **${l.name}** (#${l.color})${desc}`;
};

export const registerLabelTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"create_label",
		{
			description:
				"Create a new label *definition* in a repository (the label itself, not attaching it to an issue). Use when the user asks to add/define a new repo label. `add_labels` / `update_issue` apply existing labels to issues; this creates the label. Returns the created label's name, colour, and description.",
			inputSchema: {
				...RepoTarget,
				name: z.string().min(1).describe("Label name (unique within the repo)."),
				color: ColorSchema.optional().describe(
					"6-digit hex colour, with or without a leading `#`. GitHub assigns a random colour if omitted.",
				),
				description: z
					.string()
					.max(100, "Label description must be 100 characters or fewer.")
					.optional()
					.describe("Short label description (max 100 chars)."),
			},
		},
		async ({ owner, repo, name, color, description }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.issues.createLabel(
					stripUndefined({
						owner,
						repo,
						name,
						color: color != null ? normalizeColor(color) : undefined,
						description,
					}),
				);
				logRateLimit(headers);
				logWrite({ tool: "create_label", owner, repo, label_name: data.name });
				return text(`# Label created\n\n${labelLine(data)}`);
			}),
	);

	server.registerTool(
		"update_label",
		{
			description:
				"Update an existing label definition — rename it and/or change its colour or description. Identify the label by its current `name`; pass `new_name` to rename. At least one of `new_name` / `color` / `description` must be provided. Returns the label's new name, colour, and description.",
			inputSchema: {
				...RepoTarget,
				name: z.string().min(1).describe("Current label name (identifies the label to update)."),
				new_name: z.string().min(1).optional().describe("New label name (to rename)."),
				color: ColorSchema.optional(),
				description: z
					.string()
					.max(100, "Label description must be 100 characters or fewer.")
					.optional()
					.describe("New label description (max 100 chars)."),
			},
		},
		async ({ owner, repo, name, new_name, color, description }) =>
			wrapTool(async () => {
				if (new_name === undefined && color === undefined && description === undefined) {
					return errorResult(
						"Nothing to update: pass at least one of `new_name`, `color`, or `description`.",
					);
				}
				const { data, headers } = await client().rest.issues.updateLabel(
					stripUndefined({
						owner,
						repo,
						name,
						new_name,
						color: color != null ? normalizeColor(color) : undefined,
						description,
					}),
				);
				logRateLimit(headers);
				// Log the input `name` (the label acted on), not `data.name` — a rename
				// changes data.name, which would lose which label was targeted.
				logWrite({ tool: "update_label", owner, repo, label_name: name });
				return text(`# Label updated\n\n${labelLine(data)}`);
			}),
	);

	server.registerTool(
		"delete_label",
		{
			description:
				"Delete a label definition from a repository. Removes the label everywhere it is applied. Use when the user asks to delete/remove a repo label (not to unlabel a single issue — that is `remove_label`). Returns a confirmation.",
			inputSchema: {
				...RepoTarget,
				name: z.string().min(1).describe("Label name to delete."),
			},
		},
		async ({ owner, repo, name }) =>
			wrapTool(async () => {
				const { headers } = await client().rest.issues.deleteLabel({ owner, repo, name });
				logRateLimit(headers);
				logWrite({ tool: "delete_label", owner, repo, label_name: name });
				return text(`# Label deleted\n\n- removed \`${name}\` from ${owner}/${repo}`);
			}),
	);

	server.registerTool(
		"clone_labels",
		{
			description:
				"Copy label definitions from a source repository into a destination repository (the `gh label clone` counterpart). By default labels whose name already exists in the destination are skipped; pass `overwrite: true` to update their colour/description to match the source — a destination label that already matches is skipped either way. Returns a per-label summary of created / updated / skipped. If a non-conflict API error interrupts the run (e.g. a rate limit, or the Cloudflare Workers per-request subrequest cap on a very large label set), the partial progress made so far is still reported and audited.",
			inputSchema: {
				owner: z.string().describe("Destination repository owner (receives the copied labels)."),
				repo: z.string().describe("Destination repository name (receives the copied labels)."),
				source_owner: z.string().min(1).describe("Owner of the repository to copy labels from."),
				source_repo: z.string().min(1).describe("Name of the repository to copy labels from."),
				overwrite: z
					.boolean()
					.optional()
					.describe(
						"When a destination label of the same name already exists, update it to match the source instead of skipping. Defaults to false (skip).",
					),
			},
		},
		async ({ owner, repo, source_owner, source_repo, overwrite }) =>
			wrapTool(async () => {
				const octo = client();
				const source = await octo.paginate(octo.rest.issues.listLabelsForRepo, {
					owner: source_owner,
					repo: source_repo,
					per_page: 100,
				});
				// Prefetching the destination makes collision detection an in-memory
				// diff, so the subrequest budget buys writes rather than 422s. Skipped
				// for an empty source: there is nothing to diff against.
				const destination =
					source.length > 0
						? await octo.paginate(octo.rest.issues.listLabelsForRepo, {
								owner,
								repo,
								per_page: 100,
							})
						: [];
				const existing = new Map(destination.map((l) => [labelKey(l.name), l]));

				const created: string[] = [];
				const updated: string[] = [];
				const skipped: string[] = [];
				// Any failure mid-loop (rate limit, 5xx, or the Workers subrequest cap on
				// a large set) leaves earlier mutations applied. Capture it and still
				// emit the audit line + partial summary rather than throwing away what
				// already landed.
				let aborted: string | null = null;
				let lastHeaders: Record<string, string | number | undefined> | undefined;
				// Send `description: ""` (not undefined) for a null-description source so
				// the destination's stale description is cleared — GitHub only clears it
				// on an explicit empty string.
				const overwriteLabel = async (name: string, label: (typeof source)[number]) => {
					const { headers } = await octo.rest.issues.updateLabel({
						owner,
						repo,
						name,
						...(label.color != null ? { color: label.color } : {}),
						description: label.description ?? "",
					});
					lastHeaders = headers;
					updated.push(label.name);
				};
				for (const label of source) {
					const present = existing.get(labelKey(label.name));
					if (present != null) {
						if (
							overwrite !== true ||
							(present.color === label.color &&
								(present.description ?? "") === (label.description ?? ""))
						) {
							skipped.push(label.name);
							continue;
						}
						try {
							// Address the destination by its own name: a case-insensitive
							// match means the source's spelling need not resolve there.
							await overwriteLabel(present.name, label);
						} catch (err: unknown) {
							aborted = err instanceof Error ? err.message : String(err);
							break;
						}
						continue;
					}
					try {
						const { headers } = await octo.rest.issues.createLabel(
							stripUndefined({
								owner,
								repo,
								name: label.name,
								color: label.color,
								description: label.description ?? undefined,
							}),
						);
						lastHeaders = headers;
						created.push(label.name);
						continue;
					} catch (err: unknown) {
						// A label that appeared between the prefetch and this write.
						if (!isAlreadyExists(err)) {
							aborted = err instanceof Error ? err.message : String(err);
							break;
						}
					}
					if (overwrite !== true) {
						skipped.push(label.name);
						continue;
					}
					try {
						await overwriteLabel(label.name, label);
					} catch (err: unknown) {
						aborted = err instanceof Error ? err.message : String(err);
						break;
					}
				}
				if (lastHeaders != null) logRateLimit(lastHeaders);
				logWrite({
					tool: "clone_labels",
					owner,
					repo,
					source_owner,
					source_repo,
					label_count: created.length + updated.length,
				});

				// An interruption that applied nothing is a failed clone, not a partial
				// one — return an error so the caller can't read it as a completed copy.
				if (aborted != null && created.length === 0 && updated.length === 0) {
					return errorResult(`Cloning labels failed before any label was applied: ${aborted}`);
				}

				if (source.length === 0) {
					return text(
						`# Labels cloned\n\n- source ${source_owner}/${source_repo} has no labels to copy`,
					);
				}
				const fmt = (names: string[]) =>
					names.length > 0 ? names.map((n) => `\`${n}\``).join(", ") : "(none)";
				// Counts and the abort warning come first, unbounded name lists last:
				// `truncate` keeps the head, so a large clone drops names rather than the
				// summary that says how many landed and whether the copy finished.
				const lines = [
					`# Labels cloned`,
					``,
					...(aborted != null
						? [
								`⚠ stopped before finishing: ${aborted}. The counts below reflect what was applied before the error.`,
								``,
							]
						: []),
					`- from ${source_owner}/${source_repo} into ${owner}/${repo}`,
					`- created: ${created.length}`,
					`- updated: ${updated.length}`,
					`- skipped: ${skipped.length}`,
					``,
					`created: ${fmt(created)}`,
					`updated: ${fmt(updated)}`,
					`skipped: ${fmt(skipped)}`,
				];
				return text(truncate(lines.join("\n")));
			}),
	);
};
