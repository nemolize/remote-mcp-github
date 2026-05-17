import type { Octokit } from "octokit";
import { z } from "zod";
import { logRateLimit } from "../mcp/response.js";

export const ContentEncodingSchema = z
	.enum(["utf-8", "base64"])
	.describe(
		"Encoding of `content`. 'utf-8' (default) for text; 'base64' for binary or pre-encoded bytes.",
	);

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
