import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import type { Octokit } from "octokit";

import { GitHubHandler } from "./github-handler";
import { limitRequestBody } from "./mcp/body-limit";
import {
	createGitHubOctokit,
	createMcpServer,
	type McpServerFactory,
	newMcpServer,
	type OctokitBuilder,
	statelessMcpHandler,
} from "./mcp/stateless";
import { registerTools } from "./tools";
import type { Props } from "./utils";

// eslint-disable-next-line @typescript-eslint/no-deprecated -- migration tracked in #252
export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = newMcpServer();

	async init(): Promise<void> {
		registerTools(this.server, () => {
			if (this.props == null) {
				throw new Error("OAuth props are not available; agent is not authenticated.");
			}
			return this.createOctokit(this.props.accessToken);
		});
	}

	protected createOctokit(accessToken: string): Octokit {
		return createGitHubOctokit(accessToken);
	}
}

const corsOptions = {
	origin: "*",
	methods: "GET, POST, OPTIONS",
	headers: "Content-Type, Authorization, mcp-protocol-version",
	exposeHeaders: "mcp-session-id",
	maxAge: 86400,
};

type McpHooks = { createServer?: McpServerFactory; createOctokit?: OctokitBuilder };

// Test seam: swap the auth handler and MCP internals. Only legacy SSE
// (`GET /sse`, `/sse/message`) opens a MyMCP Durable Object.
export const buildOAuthProvider = (
	defaultHandler: ExportedHandler<Env>,
	{ createServer = createMcpServer, createOctokit = createGitHubOctokit }: McpHooks = {},
) => {
	const stateless = (route: string) =>
		limitRequestBody(statelessMcpHandler({ route, corsOptions, createServer, createOctokit }));
	const streamableSse = stateless("/sse");
	const legacySse = limitRequestBody(MyMCP.serveSSE("/sse", { corsOptions }));
	return new OAuthProvider({
		apiHandlers: {
			"/mcp": stateless("/mcp"),
			"/sse": {
				fetch: (request, env, ctx) =>
					request.method === "POST" && new URL(request.url).pathname === "/sse"
						? streamableSse.fetch(request, env, ctx)
						: legacySse.fetch(request, env, ctx),
			},
		},
		authorizeEndpoint: "/authorize",
		clientRegistrationEndpoint: "/register",
		defaultHandler,
		tokenEndpoint: "/token",
	});
};

export default buildOAuthProvider({
	fetch: (request, env, ctx) => GitHubHandler.fetch(request, env, ctx),
});
