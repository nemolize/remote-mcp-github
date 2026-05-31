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
export const MAX_FILE_CONTENT_LENGTH = 1_000_000;
export const MAX_TEXT_FIELD_LENGTH = 64_000;
// Item-count cap on the `commit_files` array.
export const MAX_FILES_PER_COMMIT = 100;
/**
 * Aggregate character-count cap on a single multi-file commit. The per-file cap
 * bounds one file, but `commit_files` accepts up to MAX_FILES_PER_COMMIT files,
 * so without this the combined payload could reach
 * MAX_FILE_CONTENT_LENGTH * MAX_FILES_PER_COMMIT (~100M chars). This bounds the
 * sum well below that while still allowing legitimate multi-file commits.
 */
export const MAX_TOTAL_COMMIT_CONTENT_LENGTH = 10_000_000;

/** Standard validation message for a character-count cap (`<label> exceeds the <max>-character limit.`). */
export const maxCharsMessage = (label: string, max: number): string =>
	`${label} exceeds the ${max}-character limit.`;
