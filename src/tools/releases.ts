import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	errorResult,
	logRateLimit,
	restListHeader,
	text,
	truncate,
	wrapTool,
} from "../mcp/response.js";
import { stripUndefined } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { RepoTarget } from "./common.js";

// A release is exactly one of draft / prerelease / published — GitHub models
// the first two as boolean flags on top of the published state, so collapse
// the pair into the single human-facing label a "what's the latest release?"
// reader scans for.
const releaseState = (draft: boolean, prerelease: boolean): string =>
	draft ? "draft" : prerelease ? "prerelease" : "published";

export const registerReleaseTools = (server: McpServer, client: OctokitFactory): void => {
	server.registerTool(
		"list_releases",
		{
			description:
				"List a repository's releases, newest first (one line per release: ID, name, tag, draft / prerelease / published state, publish date, author). Use when the user asks what releases exist, what shipped recently, or to find a `release_id` / tag for `get_release`. Drafts are included only when the token has push access.",
			inputSchema: {
				...RepoTarget,
				per_page: z.number().int().min(1).max(100).optional().default(20),
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
				const { data, headers } = await client().rest.repos.listReleases(
					stripUndefined({ owner, repo, per_page, page }),
				);
				logRateLimit(headers);
				if (data.length === 0) return text("(no releases found)");
				const lines = data.map((r) => {
					const state = releaseState(r.draft, r.prerelease);
					const name = r.name != null && r.name.length > 0 ? r.name : r.tag_name;
					const when = r.published_at ?? "unpublished";
					const author = r.author?.login ?? "(unknown)";
					return `- \`${r.id}\` **${name}** (\`${r.tag_name}\`) — ${state}, ${when}, by ${author}`;
				});
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: "Releases",
					count: data.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);

	server.registerTool(
		"get_release",
		{
			description:
				"Fetch a single release's detail — name, tag, draft / prerelease / published state, target commitish, timestamps, author, asset count, URL, and the release notes body (truncated at the response cap). Look up by `release_id`, by `tag`, or pass neither for the latest release. Note: the latest-release lookup follows GitHub semantics and never returns drafts or prereleases — use `release_id` or `tag` for those.",
			inputSchema: {
				...RepoTarget,
				release_id: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Release ID (from `list_releases`). Mutually exclusive with `tag`."),
				tag: z
					.string()
					.min(1)
					.optional()
					.describe("Tag name (e.g. 'v1.2.0'). Mutually exclusive with `release_id`."),
			},
		},
		async ({ owner, repo, release_id, tag }) =>
			wrapTool(async () => {
				if (release_id != null && tag != null) {
					return errorResult("Pass either `release_id` or `tag`, not both.");
				}
				// Three distinct endpoints behind one lookup: by ID, by tag, or the
				// repo's latest release. All return the same release shape.
				const { data, headers } =
					release_id != null
						? await client().rest.repos.getRelease({ owner, repo, release_id })
						: tag != null
							? await client().rest.repos.getReleaseByTag({ owner, repo, tag })
							: await client().rest.repos.getLatestRelease({ owner, repo });
				logRateLimit(headers);
				const state = releaseState(data.draft, data.prerelease);
				const name = data.name != null && data.name.length > 0 ? data.name : data.tag_name;
				const lines = [
					`# Release \`${data.id}\` in ${owner}/${repo}`,
					"",
					`> ${name} — ${state}`,
					"",
					`- tag: \`${data.tag_name}\` (target \`${data.target_commitish}\`)`,
					`- published: ${data.published_at ?? "(unpublished)"}`,
					`- created: ${data.created_at}`,
					`- author: ${data.author?.login ?? "(unknown)"}`,
					`- assets: ${data.assets.length}`,
					`- ${data.html_url}`,
				];
				const body = data.body;
				const notes = body != null && body.length > 0 ? `\n\n## Notes\n\n${body}` : "";
				return text(truncate(`${lines.join("\n")}${notes}`));
			}),
	);

	server.registerTool(
		"list_tags",
		{
			description:
				"List a repository's git tags (one line per tag: name, commit SHA). Use when the user asks what tags exist or wants a tag's commit. Tags are ordered as GitHub returns them (roughly reverse creation order). For release metadata attached to a tag, use `get_release` with the tag name instead.",
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
				const { data, headers } = await client().rest.repos.listTags(
					stripUndefined({ owner, repo, per_page, page }),
				);
				logRateLimit(headers);
				if (data.length === 0) return text("(no tags found)");
				const lines = data.map((t) => `- \`${t.name}\` @ \`${t.commit.sha.slice(0, 7)}\``);
				const hasMore = (headers.link ?? "").includes('rel="next"');
				const header = restListHeader({
					title: "Tags",
					count: data.length,
					page,
					hasMore,
				});
				return text(truncate(`${header}\n\n${lines.join("\n")}`));
			}),
	);
};
