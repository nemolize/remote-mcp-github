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
 * Input size caps (character counts) applied to write-tool payloads as
 * defence-in-depth. The Cloudflare Workers platform already rejects request
 * bodies over 100 MiB, but a runaway model could still pass a multi-megabyte
 * string well under that limit and burn Worker CPU/memory; these caps reject
 * such payloads fast with a clear validation error instead.
 */
export const MAX_FILE_CONTENT_LENGTH = 1_000_000;
export const MAX_TEXT_FIELD_LENGTH = 64_000;
export const MAX_FILES_PER_COMMIT = 100;
