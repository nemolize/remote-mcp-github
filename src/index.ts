import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";

import { GitHubHandler } from "./github-handler";
import { registerTools } from "./tools";
import type { Props } from "./utils";

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "remote-mcp-github",
		version: "0.1.0",
	});

	async init(): Promise<void> {
		registerTools(this.server, () => {
			if (this.props == null) {
				throw new Error("OAuth props are not available; agent is not authenticated.");
			}
			return this.props.accessToken;
		});
	}
}

const corsOptions = {
	origin: "*",
	methods: "GET, POST, OPTIONS",
	headers: "Content-Type, Authorization, mcp-protocol-version",
	exposeHeaders: "mcp-session-id",
	maxAge: 86400,
};

// Factory so tests can swap in a fake auth handler while keeping the rest of
// the OAuth/MCP wiring identical to production.
export const buildOAuthProvider = (defaultHandler: ExportedHandler<Env>) =>
	new OAuthProvider({
		apiHandlers: {
			"/mcp": MyMCP.serve("/mcp", { corsOptions }),
			"/sse": MyMCP.serveSSE("/sse", { corsOptions }),
		},
		authorizeEndpoint: "/authorize",
		clientRegistrationEndpoint: "/register",
		defaultHandler,
		tokenEndpoint: "/token",
	});

export default buildOAuthProvider({
	fetch: (request, env, ctx) => GitHubHandler.fetch(request, env, ctx),
});
