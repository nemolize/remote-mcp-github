import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Octokit } from "octokit";

import { registerActionTools } from "./tools/actions.js";
import { registerBranchTools } from "./tools/branches.js";
import { registerCommitTools } from "./tools/commits.js";
import { registerFileTools } from "./tools/files.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerPullTools } from "./tools/pulls.js";
import { registerRepoTools } from "./tools/repos.js";
import { registerSearchTools } from "./tools/search.js";

// Output-shape convention: list tools render `# <Label>` + bullet-per-row;
// detail tools render `# <Entity>` heading + bulleted metadata. See
// docs/decisions/0003-tool-output-shape-list-vs-detail.md.
export const registerTools = (server: McpServer, getAccessToken: () => string): void => {
	const client = (): Octokit => new Octokit({ auth: getAccessToken() });
	registerRepoTools(server, client);
	registerCommitTools(server, client);
	registerIssueTools(server, client);
	registerFileTools(server, client);
	registerBranchTools(server, client);
	registerPullTools(server, client);
	registerSearchTools(server, client);
	registerActionTools(server, client);
};
