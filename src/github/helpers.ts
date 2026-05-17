import type { Octokit } from "octokit";
import { logRateLimit } from "../mcp/response.js";

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
