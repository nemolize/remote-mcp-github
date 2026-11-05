import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Octokit } from "octokit";

import { registerTools } from "../tools";
import { MAX_TOOL_INPUT_ELEMENTS, type OctokitFactory } from "../tools/common";

export type OctokitBuilder = (accessToken: string) => Octokit;
export type ServerInstrument = (server: McpServer) => void;

export const newMcpServer = (): McpServer =>
	new McpServer(
		{ name: "remote-mcp-github", version: "0.1.0" },
		{ maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS },
	);

export const createMcpServerWithTools = (
	octokit: OctokitFactory,
	instrument?: ServerInstrument,
): McpServer => {
	const server = newMcpServer();
	instrument?.(server);
	registerTools(server, octokit);
	return server;
};

export const createGitHubOctokit: OctokitBuilder = (accessToken) =>
	new Octokit({ auth: accessToken });
