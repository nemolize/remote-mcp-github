import { buildOAuthProvider, MyMCP } from "../../src/index";
import { resolvePatToken } from "../../src/pat-auth";
import { FakeGitHubHandler } from "./fake-github-handler";

// Re-exported so the wrangler.jsonc Durable Object binding (class_name: MyMCP)
// resolves against this entry when vitest overrides `main`.
export { MyMCP };

// Fake PAT resolver: delegates to the production `resolvePatToken` so the gate
// (route + PAT-shape) is single-sourced and can't drift from production. The PAT
// path makes no `GET /user` call even in production, so there is nothing further
// to fake — the only thing that would differ for a real PAT is GitHub itself,
// which the transport E2E never reaches (it asserts the auth → ctx.props → MCP
// session seam, not a live GitHub call).
export default buildOAuthProvider(
	{
		fetch: (request, env, ctx) => FakeGitHubHandler.fetch(request, env, ctx),
	},
	{
		patResolver: ({ token, request }) =>
			Promise.resolve(resolvePatToken({ token, pathname: new URL(request.url).pathname })),
	},
);
