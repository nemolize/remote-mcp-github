import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Octokit } from "octokit";

import { registerBranchTools } from "./tools/branches.js";
import { registerFileTools } from "./tools/files.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerPullTools } from "./tools/pulls.js";
import { registerRepoTools } from "./tools/repos.js";
import { registerSearchTools } from "./tools/search.js";

export const registerTools = (server: McpServer, getAccessToken: () => string): void => {
	const client = (): Octokit => new Octokit({ auth: getAccessToken() });
	registerRepoTools(server, client);
	registerIssueTools(server, client);
	registerFileTools(server, client);
	registerBranchTools(server, client);
	registerPullTools(server, client);
	registerSearchTools(server, client);
};
