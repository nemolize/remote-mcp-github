import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { GitHubHandler } from "./github-handler";
import { registerTools } from "./tools";

// Context produced by the GitHub OAuth flow, encrypted via COOKIE_ENCRYPTION_KEY
// and exposed to the MCP agent as `this.props`.
type Props = {
	login: string;
	name: string;
	email: string;
	accessToken: string;
};

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "remote-mcp-github",
		version: "0.1.0",
	});

	async init(): Promise<void> {
		registerTools(this.server, () => this.props!.accessToken);
	}
}

const corsOptions = {
	origin: "*",
	methods: "GET, POST, OPTIONS",
	headers: "Content-Type, Authorization, mcp-protocol-version",
	exposeHeaders: "mcp-session-id",
	maxAge: 86400,
};

export default new OAuthProvider({
	apiHandlers: {
		"/mcp": MyMCP.serve("/mcp", { corsOptions }),
		"/sse": MyMCP.serveSSE("/sse", { corsOptions }),
	},
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as never,
	tokenEndpoint: "/token",
});
