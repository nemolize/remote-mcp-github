import { buildOAuthProvider, MyMCP } from "../../src/index";
import { isPatRoute, looksLikePat } from "../../src/pat-auth";
import { FakeGitHubHandler } from "./fake-github-handler";

// Re-exported so the wrangler.jsonc Durable Object binding (class_name: MyMCP)
// resolves against this entry when vitest overrides `main`.
export { MyMCP };

// Fake PAT resolver: mirrors the production gate (only accept on /pat/* and a
// PAT-shaped Bearer) but returns sentinel props instead of calling GitHub's
// `GET /user`, so the transport E2E exercises the resolveExternalToken → ctx.props
// → MCP session seam without standing up real GitHub.
export default buildOAuthProvider(
	{
		fetch: (request, env, ctx) => FakeGitHubHandler.fetch(request, env, ctx),
	},
	{
		patResolver: ({ token, request }) => {
			const pathname = new URL(request.url).pathname;
			if (!isPatRoute(pathname) || !looksLikePat(token)) return Promise.resolve(null);
			return Promise.resolve({
				props: { accessToken: token, login: "", name: "", email: "" },
			});
		},
	},
);
