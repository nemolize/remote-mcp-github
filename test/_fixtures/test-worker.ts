import { buildOAuthProvider, MyMCP } from "../../src/index";
import { FakeGitHubHandler } from "./fake-github-handler";

// Re-exported so the wrangler.jsonc Durable Object binding (class_name: MyMCP)
// resolves against this entry when vitest overrides `main`.
export { MyMCP };

export default buildOAuthProvider({
	fetch: (request, env, ctx) => FakeGitHubHandler.fetch(request, env, ctx),
});
