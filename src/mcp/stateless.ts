import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLegacyMcpHandler, type WorkerTransportOptions } from "agents/mcp";
import { Octokit } from "octokit";

import { registerTools } from "../tools";
import { MAX_TOOL_INPUT_ELEMENTS, type OctokitFactory } from "../tools/common";
import type { Props } from "../utils";
import type { FetchHandler } from "./body-limit";

export type McpServerFactory = (octokit: OctokitFactory) => McpServer;
export type OctokitBuilder = (accessToken: string) => Octokit;

export const newMcpServer = (): McpServer =>
	new McpServer(
		{ name: "remote-mcp-github", version: "0.1.0" },
		{ maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS },
	);

export const createMcpServer: McpServerFactory = (octokit) => {
	const server = newMcpServer();
	registerTools(server, octokit);
	return server;
};

export const createGitHubOctokit: OctokitBuilder = (accessToken) =>
	new Octokit({ auth: accessToken });

type StatelessOptions = {
	route: string;
	corsOptions: NonNullable<WorkerTransportOptions["corsOptions"]>;
	createServer: McpServerFactory;
	createOctokit: OctokitBuilder;
};

const hasAccessToken = (props: unknown): props is Pick<Props, "accessToken"> =>
	typeof props === "object" &&
	props !== null &&
	"accessToken" in props &&
	typeof props.accessToken === "string";

// Fresh server per request, no session id, no Durable Object rows.
// GET and DELETE are 405: there is no session to stream to or end.
export const statelessMcpHandler = ({
	route,
	corsOptions,
	createServer,
	createOctokit,
}: StatelessOptions): FetchHandler => ({
	fetch: (request, env, ctx) => {
		if (request.method === "GET" || request.method === "DELETE") {
			return new Response("Method Not Allowed", {
				status: 405,
				headers: { Allow: "POST, OPTIONS" },
			});
		}
		const props = ctx.props;
		const server = createServer(() => {
			if (!hasAccessToken(props)) {
				throw new Error("OAuth props are not available; request is not authenticated.");
			}
			return createOctokit(props.accessToken);
		});
		return createLegacyMcpHandler(server, { route, corsOptions })(request, env, ctx);
	},
});
