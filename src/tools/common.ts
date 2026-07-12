import type { Octokit } from "octokit";
import { z } from "zod";

import {
	cursorMoreHint,
	MAX_RESPONSE_CHARS,
	text,
	type ToolResult,
	truncate,
} from "../mcp/response.js";

export type OctokitFactory = () => Octokit;

export const RepoTarget = {
	owner: z.string().describe("Repository owner (user or organisation login)."),
	repo: z.string().describe("Repository name."),
} as const;

// Shared cursor-pagination shape for every GraphQL list tool (Projects v2,
// Discussions, …) — the REST list tools use page/per_page instead (see
// restListHeader in response.ts).
export type PageInfo = { hasNextPage: boolean; endCursor: string | null };

/** A GraphQL connection page: total count, cursor info, and its nodes. */
export type Page<T> = {
	totalCount: number;
	pageInfo: PageInfo;
	nodes: Array<T | null>;
};

export const PaginationSchema = {
	per_page: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.default(30)
		.describe("Results per page (1-100)."),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Opaque pagination cursor from a previous page's endCursor. Omit for the first page.",
		),
} as const;

const CURSOR_INSTRUCTION = (endCursor: string | null): string =>
	`Re-invoke with \`cursor: "${endCursor}"\` to fetch the next page.`;

/**
 * Render a cursor-paginated list body: truncate within a budget that reserves
 * room for the cursor hint so a large page can never drop the `cursor` (the
 * #50 discipline — see cursorMoreHint's own docstring).
 */
export const paginatedList = (
	header: string,
	lines: string[],
	page: { totalCount: number; pageInfo: PageInfo },
): ToolResult => {
	const more = cursorMoreHint({
		shown: lines.length,
		total: page.totalCount,
		hasMore: page.pageInfo.hasNextPage && page.pageInfo.endCursor != null,
		nextPageInstruction: CURSOR_INSTRUCTION(page.pageInfo.endCursor),
	});
	const body = truncate(`${header}\n\n${lines.join("\n")}`, MAX_RESPONSE_CHARS - more.length);
	return text(`${body}${more}`);
};

export const SameRepoBranchPattern = /^[A-Za-z0-9._/-]+$/;
export const CrossRepoHeadPattern = /^[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+$/;

/**
 * Input size caps applied to write-tool payloads as defence-in-depth. The
 * Cloudflare Workers platform already rejects request bodies over 100 MiB, but
 * a runaway model could still pass a multi-megabyte payload well under that
 * limit and burn Worker CPU/memory; these caps reject such payloads fast with a
 * clear validation error instead.
 */
// Character-count caps on individual string fields.
// Per-file content cap. This is a logical bound, not the memory backstop — the
// platform body limit (above) is what actually guards the isolate. Sized to
// stay well within the Workers isolate memory budget once the content is
// expanded through base64 / JSON encoding on the way to GitHub, with headroom
// for the runtime and concurrent requests. It is not a GitHub mirror: GitHub's
// own write limit is far higher.
export const MAX_FILE_CONTENT_LENGTH = 5_000_000;
// Mirrors GitHub's own limit: issue / PR bodies and comments are capped at
// 65,536 characters (the API returns 422 "Body is too long" above that), so
// raising this past ~65k is pointless for those fields. 64k leaves a small
// margin. Commit messages share this constant but have no realistic need for
// more. Memory is irrelevant here (~128 KiB).
export const MAX_TEXT_FIELD_LENGTH = 64_000;
// Item-count cap on the `commit_files` array. The handler fires one createBlob
// per base64 file via Promise.all, so the concurrent request peak equals the
// file count. 100 sits at GitHub's shared concurrent-request ceiling, leaving
// no margin, so raising it would need request throttling + backoff, not just a
// larger number. utf-8 files are inlined into one createTree call and add no
// per-file requests.
export const MAX_FILES_PER_COMMIT = 100;
/**
 * Aggregate character-count cap on a single multi-file commit, set equal to the
 * per-file cap so the multi-file path is no looser a logical bound than a
 * single-file write. `commit_files` accepts up to MAX_FILES_PER_COMMIT files,
 * so without this the combined payload could pass per-file validation while the
 * sum is far larger. Like the per-file cap, this is a logical bound enforced in
 * the handler — not the memory backstop, which is the platform body limit.
 */
export const MAX_TOTAL_COMMIT_CONTENT_LENGTH = 5_000_000;

/** Standard validation message for a character-count cap (`<label> exceeds the <max>-character limit.`). */
export const maxCharsMessage = (label: string, max: number): string =>
	`${label} exceeds the ${max}-character limit.`;

// `workflow_id` accepts either a filename (`ci.yml`) or a numeric ID, matching
// GitHub's own polymorphism (shared by the Actions run tools and the Actions
// admin tools). The per-use-site `.describe()` carries the field documentation.
export const WorkflowId = z.union([z.number().int().positive(), z.string().min(1)]);

// Byte counts span bytes to gigabytes (artifacts, caches); a binary-prefixed
// rendering keeps list lines readable at every scale (raw byte counts are
// unreadable past ~1 MiB).
export const formatBytes = (bytes: number): string => {
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
