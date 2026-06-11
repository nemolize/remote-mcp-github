import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	errorResult,
	logRateLimit,
	logWrite,
	restListHeader,
	text,
	truncate,
	wrapTool,
} from "../mcp/response.js";
import { stripUndefined } from "../utils.js";
import type { OctokitFactory } from "./common.js";
import { MAX_TEXT_FIELD_LENGTH, maxCharsMessage, RepoTarget } from "./common.js";

// GitHub models draft and prerelease as independent boolean flags, so a
// release can be both at once (an unpublished draft of a prerelease).
// Collapse the pair into the single human-facing label a "what's the latest
// release?" reader scans for, keeping both facets visible when they combine.
const releaseState = (draft: boolean, prerelease: boolean): string =>
	draft && prerelease
		? "draft prerelease"
		: draft
			? "draft"
			: prerelease
				? "prerelease"
				: "published";

// The release shape returned by getRelease / createRelease / updateRelease is
// identical, so the detail rendering is shared across the read and write tools
// rather than duplicated per call site.
type ReleaseDetail = {
	id: number;
	tag_name: string;
	name: string | null;
	draft: boolean;
	prerelease: boolean;
	target_commitish: string;
	published_at: string | null;
	created_at: string;
	author: { login: string } | null;
	assets: unknown[];
	html_url: string;
	body?: string | null;
};

const renderReleaseDetail = (owner: string, repo: string, data: ReleaseDetail): string => {
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
	return truncate(`${lines.join("\n")}${notes}`);
};

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
				return text(renderReleaseDetail(owner, repo, data));
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

	server.registerTool(
		"create_release",
		{
			description:
				"Create a GitHub release (and its git tag if it does not exist) from `tag_name`. Use when the user asks to cut / publish a release. Mutates repository state — a non-draft release is immediately public and fires release webhooks. Set `draft: true` to stage it unpublished, `generate_release_notes: true` to auto-build the body from merged PRs since the previous tag. `target_commitish` selects the commit the new tag points at (defaults to the repo's default branch); it is ignored when the tag already exists.",
			inputSchema: {
				...RepoTarget,
				tag_name: z
					.string()
					.min(1)
					.describe("Tag to create or reuse for the release (e.g. 'v1.2.0')."),
				target_commitish: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Commitish (branch / SHA) the tag points at when it must be created. Ignored if the tag already exists. Defaults to the repository's default branch.",
					),
				name: z.string().optional().describe("Release title. Defaults to the tag name on GitHub."),
				body: z
					.string()
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Release body", MAX_TEXT_FIELD_LENGTH))
					.optional()
					.describe("Release notes (Markdown). Omit when using `generate_release_notes`."),
				draft: z
					.boolean()
					.optional()
					.describe("Create as an unpublished draft. Defaults to false (published)."),
				prerelease: z.boolean().optional().describe("Mark as a prerelease. Defaults to false."),
				generate_release_notes: z
					.boolean()
					.optional()
					.describe(
						"Auto-generate the release notes body from merged PRs since the previous tag. Combines with / falls back to `body`.",
					),
			},
		},
		async ({
			owner,
			repo,
			tag_name,
			target_commitish,
			name,
			body,
			draft,
			prerelease,
			generate_release_notes,
		}) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.createRelease(
					stripUndefined({
						owner,
						repo,
						tag_name,
						target_commitish,
						name,
						body,
						draft,
						prerelease,
						generate_release_notes,
					}),
				);
				logRateLimit(headers);
				logWrite({ tool: "create_release", owner, repo, release_id: data.id, tag_name });
				return text(renderReleaseDetail(owner, repo, data));
			}),
	);

	server.registerTool(
		"update_release",
		{
			description:
				"Edit an existing release's fields by `release_id` (from `list_releases`). Use when the user asks to rename a release, edit its notes, publish a draft (`draft: false`), or toggle prerelease. Mutates repository state — publishing a draft makes it public and fires release webhooks. Only the fields you pass are changed; omitted fields are left as-is.",
			inputSchema: {
				...RepoTarget,
				release_id: z
					.number()
					.int()
					.positive()
					.describe("Release ID to edit (from `list_releases`)."),
				tag_name: z.string().min(1).optional().describe("Move the release to a different tag."),
				target_commitish: z
					.string()
					.min(1)
					.optional()
					.describe("Commitish the tag points at. Only takes effect for an unpublished release."),
				name: z.string().optional().describe("New release title."),
				body: z
					.string()
					.max(MAX_TEXT_FIELD_LENGTH, maxCharsMessage("Release body", MAX_TEXT_FIELD_LENGTH))
					.optional()
					.describe("New release notes (Markdown)."),
				draft: z.boolean().optional().describe("Set false to publish a draft, true to unpublish."),
				prerelease: z.boolean().optional().describe("Toggle the prerelease flag."),
			},
		},
		async ({
			owner,
			repo,
			release_id,
			tag_name,
			target_commitish,
			name,
			body,
			draft,
			prerelease,
		}) =>
			wrapTool(async () => {
				const { data, headers } = await client().rest.repos.updateRelease(
					stripUndefined({
						owner,
						repo,
						release_id,
						tag_name,
						target_commitish,
						name,
						body,
						draft,
						prerelease,
					}),
				);
				logRateLimit(headers);
				logWrite({ tool: "update_release", owner, repo, release_id });
				return text(renderReleaseDetail(owner, repo, data));
			}),
	);

	server.registerTool(
		"delete_release",
		{
			description:
				"Delete a release by `release_id` (from `list_releases`). Use when the user asks to remove a release. Mutates repository state and is irreversible. The underlying git tag is left in place — delete it separately if needed.",
			inputSchema: {
				...RepoTarget,
				release_id: z
					.number()
					.int()
					.positive()
					.describe("Release ID to delete (from `list_releases`)."),
			},
		},
		async ({ owner, repo, release_id }) =>
			wrapTool(async () => {
				// deleteRelease answers 204 No Content — there is no release shape left to
				// render, so report the deletion and the tag that remains.
				const { headers } = await client().rest.repos.deleteRelease({ owner, repo, release_id });
				logRateLimit(headers);
				logWrite({ tool: "delete_release", owner, repo, release_id });
				return text(
					`# Release deleted\n\n- release \`${release_id}\` in ${owner}/${repo} deleted\n- its git tag is left in place; delete the tag separately if you also want it removed`,
				);
			}),
	);
};
