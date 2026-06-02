import type { Octokit } from "octokit";
import { z } from "zod";

export type OctokitFactory = () => Octokit;

export const RepoTarget = {
	owner: z.string().describe("Repository owner (user or organisation login)."),
	repo: z.string().describe("Repository name."),
} as const;

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
