import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { Octokit } from "octokit";

import { GitHubHandler } from "./github-handler";
import { limitRequestBody } from "./mcp/body-limit";
import { registerTools } from "./tools";
import { MAX_TOOL_INPUT_ELEMENTS } from "./tools/common";
import type { Props } from "./utils";

// eslint-disable-next-line @typescript-eslint/no-deprecated -- migration tracked in #252
export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer(
		{ name: "remote-mcp-github", version: "0.1.0" },
		{ maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS },
	);

	async init(): Promise<void> {
		registerTools(this.server, () => {
			if (this.props == null) {
				throw new Error("OAuth props are not available; agent is not authenticated.");
			}
			return this.createOctokit(this.props.accessToken);
		});
	}

	protected createOctokit(accessToken: string): Octokit {
		return new Octokit({ auth: accessToken });
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
			"/mcp": limitRequestBody(MyMCP.serve("/mcp", { corsOptions })),
			"/sse": limitRequestBody(MyMCP.serveSSE("/sse", { corsOptions })),
		},
		authorizeEndpoint: "/authorize",
		clientRegistrationEndpoint: "/register",
		defaultHandler,
		tokenEndpoint: "/token",
	});

export default buildOAuthProvider({
	fetch: (request, env, ctx) => GitHubHandler.fetch(request, env, ctx),
});
