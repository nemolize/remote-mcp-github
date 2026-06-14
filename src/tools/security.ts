import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logRateLimit, restListHeader, text, truncate, wrapTool } from "../mcp/response.js";
import { stripUndefined } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";

// Security-scanning alerts (secret / code / Dependabot) are read-only here:
// these tools surface findings so an LLM can answer "are there open leaks /
// vulnerabilities in this repo?". Remediation happens via PRs / Dependabot, not
// a write tool in this module.
//
// IMPORTANT — secret values never leave this module. The secret-scanning alert
// shape carries the raw detected secret in `secret` (and a sample in
// `secret_type_display_name` context); rendering it would echo a live
// credential into the model's context. The renderers below deliberately surface
// only the secret *type* and metadata, never `secret` itself.

// All three alert types render the same lead — `` `#<number>` **<state>** `` —
// before their type-specific metadata. Centralise it so a future format tweak
// (and the missing-state fallback) stays uniform across the three renderers
// rather than drifting per call site.
const alertLead = (number: number | undefined, state: string | null | undefined): string =>
	`- \`#${number ?? "?"}\` **${state ?? "(unknown)"}**`;

export const registerSecurityTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"list_secret_scanning_alerts",
		{
			description:
				"List a repository's secret-scanning alerts (one line per alert: number, state, secret type, resolution, updated date). Use when the user asks whether the repo has leaked secrets / credentials. Read-only. Never returns the raw secret value — only its type and metadata. Filter by `state` (`open` / `resolved`). Requires a token with `repo` (or `security_events`) scope and admin access to the repository; 403s cleanly otherwise.",
			inputSchema: {
				...RepoTarget,
				state: z
					.enum(["open", "resolved"])
					.optional()
					.describe("Filter by alert state. Omit for all states."),
				per_page: z.number().int().min(1).max(100).optional().default(20),
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number (1-indexed). Defaults to 1."),
			},
		},
		async ({ owner, repo, state, per_page, page }) =>
			wrapTool(async () => {
				// `hide_secret: true` makes GitHub omit the raw secret from the
				// response entirely, so the live credential never even reaches Worker
				// memory — defence-in-depth on top of the renderer never emitting it.
				const { data, headers } = await client().rest.secretScanning.listAlertsForRepo(
					stripUndefined({ owner, repo, state, per_page, page, hide_secret: true }),
				);
				logRateLimit(headers);
				if (data.length === 0) return text("(no secret-scanning alerts found)");
				const lines = data.map((a) => {
					// `secret_type_display_name` is the human-friendly label; never `secret`.
					const type = a.secret_type_display_name ?? a.secret_type ?? "(unknown type)";
					const resolution = a.state === "resolved" ? ` (${a.resolution ?? "resolved"})` : "";
					const when = a.updated_at ?? a.created_at ?? "(unknown date)";
					return `${alertLead(a.number, a.state)}${resolution} — ${type}, ${when}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: "Secret-scanning alerts",
					count: data.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"list_code_scanning_alerts",
		{
			description:
				"List a repository's code-scanning alerts (one line per alert: number, state, rule ID + severity, tool, most-recent location path:line). Use when the user asks about static-analysis / CodeQL findings. Read-only. Filter by `state` (`open` / `dismissed` / `fixed`), `severity`, or `tool_name`. Requires a token with `repo` (or `security_events`) scope; 403s cleanly otherwise.",
			inputSchema: {
				...RepoTarget,
				state: z
					.enum(["open", "dismissed", "fixed"])
					.optional()
					.describe("Filter by alert state. Omit for all states."),
				severity: z
					.enum(["critical", "high", "medium", "low", "warning", "note", "error"])
					.optional()
					.describe("Filter by rule severity. Omit for all severities."),
				tool_name: z
					.string()
					.min(1)
					.optional()
					.describe("Filter by the analysis tool name (e.g. 'CodeQL')."),
				per_page: z.number().int().min(1).max(100).optional().default(20),
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number (1-indexed). Defaults to 1."),
			},
		},
		async ({ owner, repo, state, severity, tool_name, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.codeScanning.listAlertsForRepo(
					stripUndefined({ owner, repo, state, severity, tool_name, per_page, page }),
				);
				logRateLimit(headers);
				if (data.length === 0) return text("(no code-scanning alerts found)");
				const lines = data.map((a) => {
					const rule = a.rule.id ?? a.rule.name ?? "(unknown rule)";
					// Prefer the security severity (low/medium/high/critical) where the rule
					// carries it; fall back to the generic severity (note/warning/error).
					const sev = a.rule.security_severity_level ?? a.rule.severity ?? "(no severity)";
					const tool = a.tool.name ?? "(unknown tool)";
					const loc = a.most_recent_instance?.location;
					const where =
						loc?.path != null
							? `, ${loc.path}${loc.start_line != null ? `:${loc.start_line}` : ""}`
							: "";
					return `${alertLead(a.number, a.state)} — \`${rule}\` (${sev}), ${tool}${where}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: "Code-scanning alerts",
					count: data.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"list_dependabot_alerts",
		{
			description:
				"List a repository's Dependabot alerts (one line per alert: number, state, package ecosystem + name, severity, advisory GHSA / summary). Use when the user asks about vulnerable dependencies. Read-only. Filter by `state` (`open` / `dismissed` / `fixed` / `auto_dismissed`) or `severity`. Requires a token with `repo` (or `security_events`) scope; 403s cleanly otherwise.",
			inputSchema: {
				...RepoTarget,
				state: z
					.enum(["open", "dismissed", "fixed", "auto_dismissed"])
					.optional()
					.describe("Filter by alert state. Omit for all states."),
				severity: z
					.enum(["low", "medium", "high", "critical"])
					.optional()
					.describe("Filter by advisory severity. Omit for all severities."),
				per_page: z.number().int().min(1).max(100).optional().default(20),
				page: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Page number (1-indexed). Defaults to 1."),
			},
		},
		async ({ owner, repo, state, severity, per_page, page }) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.dependabot.listAlertsForRepo(
					stripUndefined({ owner, repo, state, severity, per_page, page }),
				);
				logRateLimit(headers);
				if (data.length === 0) return text("(no Dependabot alerts found)");
				const lines = data.map((a) => {
					const pkg = a.dependency?.package;
					const pkgLabel =
						pkg?.name != null
							? `${pkg.ecosystem != null ? `${pkg.ecosystem}:` : ""}${pkg.name}`
							: "(unknown package)";
					const sev = a.security_advisory?.severity ?? "(no severity)";
					const ghsa = a.security_advisory?.ghsa_id ?? "(no GHSA)";
					const summary = a.security_advisory?.summary ?? "";
					return `${alertLead(a.number, a.state)} — ${pkgLabel} (${sev}), \`${ghsa}\`${summary.length > 0 ? ` — ${summary}` : ""}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: "Dependabot alerts",
					count: data.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);
};
