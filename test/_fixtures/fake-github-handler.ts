import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";

import type { Props } from "../../src/utils";

// Drop-in replacement for the production GitHubHandler that auto-grants the
// authorization request without redirecting through GitHub. Production code
// is untouched; the test worker entry (test/_fixtures/test-worker.ts) wires
// this handler in via the buildOAuthProvider factory.
//
// The injected `accessToken` is a sentinel — the current E2E only asserts on
// transport and tool registration, so the sentinel never reaches GitHub.
const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const props: Props = {
		accessToken: "fake-github-token",
		email: "test@example.com",
		login: "testuser",
		name: "Test User",
	};
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: { label: "test user" },
		props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: "testuser",
	});
	return c.redirect(redirectTo);
});

export { app as FakeGitHubHandler };
