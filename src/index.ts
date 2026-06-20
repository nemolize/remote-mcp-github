import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";

import { GitHubHandler } from "./github-handler";
import { PAT_ROUTE_PREFIX, resolvePatToken } from "./pat-auth";
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

// Resolver for the PAT (GitHub Personal Access Token) Bearer auth path, wired as
// OAuthProvider's `resolveExternalToken`. It fires only on a KV-miss (a Bearer the
// provider did not issue) and accepts the token only on the `/pat/*` route.
// Injectable so tests can supply a fake without standing up real GitHub.
// See docs/decisions/0004-pat-bearer-auth-for-non-oauth-clients.md.
export type PatResolver = (input: {
	token: string;
	request: Request;
	env: Env;
}) => Promise<{ props: Props } | null>;

const defaultPatResolver: PatResolver = ({ token, request }) =>
	Promise.resolve(resolvePatToken({ token, pathname: new URL(request.url).pathname }));

interface BuildOAuthProviderOptions {
	// Overridable PAT resolver (tests inject a fake to avoid live GitHub).
	patResolver?: PatResolver;
}

// Factory so tests can swap in a fake auth handler while keeping the rest of
// the OAuth/MCP wiring identical to production.
//
// The PAT path is always mounted and symmetric with the OAuth path (anyone may
// connect, acting only as their own GitHub identity) — see ADR-0004. Any access
// restriction would have to be cross-cutting (OAuth + PAT) and is deferred to
// issue #129.
export const buildOAuthProvider = (
	defaultHandler: ExportedHandler<Env>,
	{ patResolver = defaultPatResolver }: BuildOAuthProviderOptions = {},
) =>
	new OAuthProvider({
		apiHandlers: {
			"/mcp": MyMCP.serve("/mcp", { corsOptions }),
			"/sse": MyMCP.serveSSE("/sse", { corsOptions }),
			// The PAT mounts share the identical MyMCP handler (and corsOptions);
			// only the auth route differs (the PAT resolver accepts only on /pat/*).
			[`${PAT_ROUTE_PREFIX}/mcp`]: MyMCP.serve(`${PAT_ROUTE_PREFIX}/mcp`, { corsOptions }),
			[`${PAT_ROUTE_PREFIX}/sse`]: MyMCP.serveSSE(`${PAT_ROUTE_PREFIX}/sse`, { corsOptions }),
		},
		authorizeEndpoint: "/authorize",
		clientRegistrationEndpoint: "/register",
		defaultHandler,
		resolveExternalToken: patResolver,
		tokenEndpoint: "/token",
	});

export default buildOAuthProvider({
	fetch: (request, env, ctx) => GitHubHandler.fetch(request, env, ctx),
});
