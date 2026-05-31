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
// File content is bounded by the Workers isolate memory envelope (128 MiB),
// not by a product requirement: a single file flows through UTF-16 storage +
// UTF-8 + base64 + JSON body + fetch bytes, so peak memory is roughly 10x the
// character count. Reserving headroom for the runtime and concurrent requests
// puts the safe ceiling near ~6M chars; 5M leaves margin. Raising this toward
// tens of MiB would risk OOMing the isolate. GitHub's own write ceiling is far
// higher (the Contents API PUT accepts up to ~50-100 MiB), so memory — not
// GitHub — is the binding constraint here.
export const MAX_FILE_CONTENT_LENGTH = 5_000_000;
// Mirrors GitHub's own limit: issue / PR bodies and comments are capped at
// 65,536 characters (the API returns 422 "Body is too long" above that), so
// raising this past ~65k is pointless for those fields. 64k leaves a small
// margin. Commit messages share this constant but have no realistic need for
// more. Memory is irrelevant here (~128 KiB).
export const MAX_TEXT_FIELD_LENGTH = 64_000;
// Item-count cap on the `commit_files` array. Calibrated to GitHub's secondary
// rate limit of 100 concurrent requests (shared REST + GraphQL): the handler
// fires one createBlob per base64 file via Promise.all, so the concurrent peak
// equals the file count. Raising this above 100 would require concurrency
// throttling + points-per-minute pacing (POST = 5 pts, 900/min cap) + 403/429
// backoff, not just a larger number. utf-8 files are inlined into a single
// createTree call, so they don't add per-file requests.
export const MAX_FILES_PER_COMMIT = 100;
/**
 * Aggregate character-count cap on a single multi-file commit, set equal to the
 * per-file cap. `commit_files` accepts up to MAX_FILES_PER_COMMIT files, so
 * without this the combined payload could reach
 * MAX_FILE_CONTENT_LENGTH * MAX_FILES_PER_COMMIT (~500M chars). Capping the sum
 * at the per-file ceiling means a multi-file commit can't peak higher in memory
 * than a single max-size file write — which matters because the 128 MiB isolate
 * is shared across concurrent requests (see MAX_FILE_CONTENT_LENGTH).
 */
export const MAX_TOTAL_COMMIT_CONTENT_LENGTH = 5_000_000;

/** Standard validation message for a character-count cap (`<label> exceeds the <max>-character limit.`). */
export const maxCharsMessage = (label: string, max: number): string =>
	`${label} exceeds the ${max}-character limit.`;
