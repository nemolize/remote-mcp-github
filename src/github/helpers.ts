import type { Octokit } from "octokit";
import { z } from "zod";

import { errorResult, logRateLimit, type ToolResult } from "../mcp/response.js";
import { isHttpStatus } from "../utils.js";

export const ContentEncodingSchema = z
	.enum(["utf-8", "base64"])
	.describe(
		"Encoding of `content`. 'utf-8' (default) for text; 'base64' for binary or pre-encoded bytes.",
	);

export const FileModeSchema = z
	.enum(["100644", "100755", "120000"])
	.describe("Git file mode. 100644=regular, 100755=executable, 120000=symlink.");

export const encodeBase64Utf8 = (text: string): string => {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
};

export const resolveDefaultBranch = async (
	octo: Octokit,
	owner: string,
	repo: string,
): Promise<string> => {
	const { data, headers } = await octo.rest.repos.get({ owner, repo });
	logRateLimit(headers);
	return data.default_branch;
};

export const getBranchHeadSha = async (
	octo: Octokit,
	owner: string,
	repo: string,
	branch: string,
): Promise<string> => {
	const { data, headers } = await octo.rest.git.getRef({
		owner,
		repo,
		ref: `heads/${branch}`,
	});
	logRateLimit(headers);
	return data.object.sha;
};

// Only `non-file` carries a payload (the actual content type from GitHub) so
// callers can include it in their error message; the other variants are
// fully determined by `kind` alone.
export type ResolvedFileSha =
	| { kind: "found"; sha: string }
	| { kind: "missing" }
	| { kind: "directory" }
	| { kind: "non-file"; type: string };

export const resolveFileSha = async (
	octo: Octokit,
	owner: string,
	repo: string,
	path: string,
	branch: string,
): Promise<ResolvedFileSha> => {
	try {
		const existing = await octo.rest.repos.getContent({ owner, repo, path, ref: branch });
		logRateLimit(existing.headers);
		if (Array.isArray(existing.data)) return { kind: "directory" };
		if (existing.data.type !== "file") return { kind: "non-file", type: existing.data.type };
		return { kind: "found", sha: existing.data.sha };
	} catch (e: unknown) {
		if (isHttpStatus(e, 404)) return { kind: "missing" };
		throw e;
	}
};

// Builds the error response for the two `ResolvedFileSha` variants that always
// reject a file-mutation tool (directory paths and non-file blobs). Each caller
// passes its own tool name and verb so the message stays caller-specific.
export const fileShaError = (
	resolved: Extract<ResolvedFileSha, { kind: "directory" | "non-file" }>,
	toolName: string,
	verb: string,
	path: string,
): ToolResult => {
	if (resolved.kind === "directory") {
		return errorResult(
			`Path \`${path}\` resolves to a directory; ${toolName} targets a single regular file.`,
		);
	}
	return errorResult(
		`Path \`${path}\` is a ${resolved.type}, not a regular file; refusing to ${verb} via ${toolName}.`,
	);
};
