import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerActionTools } from "./tools/actions.js";
import { registerActionAdminTools } from "./tools/actions-admin.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import { registerBranchTools } from "./tools/branches.js";
import { registerCommitTools } from "./tools/commits.js";
import type { OctokitFactory } from "./tools/common.js";
import { registerCopilotTools } from "./tools/copilot.js";
import { registerDiscussionTools } from "./tools/discussions.js";
import { registerFileTools } from "./tools/files.js";
import { registerGistTools } from "./tools/gists.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerLabelTools } from "./tools/labels.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerPullTools } from "./tools/pulls.js";
import { registerReleaseAssetTools } from "./tools/release-assets.js";
import { registerReleaseTools } from "./tools/releases.js";
import { registerRepoTools } from "./tools/repos.js";
import { registerRulesetTools } from "./tools/rulesets.js";
import { registerSearchTools } from "./tools/search.js";
import { registerSecurityTools } from "./tools/security.js";
import { registerSubIssueTools } from "./tools/sub-issues.js";

// Output-shape convention: list tools render `# <Label>` + bullet-per-row;
// detail tools render `# <Entity>` heading + bulleted metadata. See
// docs/decisions/0003-tool-output-shape-list-vs-detail.md.
export const registerTools = (server: McpServer, client: OctokitFactory): void => {
	registerRepoTools(server, client);
	registerCommitTools(server, client);
	registerIssueTools(server, client);
	registerLabelTools(server, client);
	registerFileTools(server, client);
	registerBranchTools(server, client);
	registerPullTools(server, client);
	registerSearchTools(server, client);
	registerActionTools(server, client);
	registerActionAdminTools(server, client);
	registerReleaseTools(server, client);
	registerReleaseAssetTools(server, client);
	registerSecurityTools(server, client);
	registerRulesetTools(server, client);
	registerGistTools(server, client);
	registerProjectTools(server, client);
	registerDiscussionTools(server, client);
	registerAttachmentTools(server, client);
	registerCopilotTools(server, client);
	registerSubIssueTools(server, client);
};
