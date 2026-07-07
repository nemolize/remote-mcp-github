import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { makeMcpClient } from "./_fixtures/mcp-client.mjs";

const randomBytes = (len) => {
	const a = new Uint8Array(len);
	crypto.getRandomValues(a);
	return a;
};

const sha256 = async (input) => {
	const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
	return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
};

// Transport-layer E2E that runs in CI. Drives the OAuth flow against the
// test worker (which uses FakeGitHubHandler to auto-grant) and then exercises
// the MCP Streamable HTTP transport. Tool execution against real GitHub is
// out of scope here — that surface is covered by the manual harness in
// scripts/e2e/oauth-e2e.mjs.

const ORIGIN = "http://localhost"; // arbitrary; SELF ignores host
const CALLBACK_URI = `${ORIGIN}/_test/callback`;

const b64url = (bytes) => {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const registerClient = async () => {
	const r = await SELF.fetch(`${ORIGIN}/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			redirect_uris: [CALLBACK_URI],
			client_name: "mcp-e2e",
			token_endpoint_auth_method: "none",
		}),
	});
	expect(r.ok, `/register status ${r.status}`).toBe(true);
	const body = await r.json();
	return body.client_id;
};

const issueBearer = async () => {
	const clientId = await registerClient();
	const verifier = b64url(randomBytes(32));
	const challenge = b64url(await sha256(verifier));
	const state = b64url(randomBytes(16));

	const authUrl =
		`${ORIGIN}/authorize?` +
		new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: CALLBACK_URI,
			scope: "read:user repo",
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();
	const authResp = await SELF.fetch(authUrl, { redirect: "manual" });
	expect(authResp.status).toBe(302);
	const location = authResp.headers.get("location");
	expect(location, "authorize must redirect to client callback").toBeTruthy();
	const callbackUrl = new URL(location);
	expect(`${callbackUrl.origin}${callbackUrl.pathname}`).toBe(CALLBACK_URI);
	expect(callbackUrl.searchParams.get("state")).toBe(state);
	const code = callbackUrl.searchParams.get("code");
	expect(code, "callback must include code").toBeTruthy();

	const tokenResp = await SELF.fetch(`${ORIGIN}/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: CALLBACK_URI,
			client_id: clientId,
			code_verifier: verifier,
		}),
	});
	expect(tokenResp.status).toBe(200);
	const tokenBody = await tokenResp.json();
	expect(typeof tokenBody.access_token).toBe("string");
	return tokenBody.access_token;
};

describe("MCP transport E2E", () => {
	it("publishes OAuth authorization-server metadata", async () => {
		const r = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
		expect(r.status).toBe(200);
		const meta = await r.json();
		expect(meta.token_endpoint).toMatch(/\/token$/);
		expect(meta.authorization_endpoint).toMatch(/\/authorize$/);
		expect(meta.registration_endpoint).toMatch(/\/register$/);
	});

	it("rejects unauthenticated /mcp requests", async () => {
		const r = await SELF.fetch(`${ORIGIN}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		expect(r.status).toBe(401);
	});

	it("completes OAuth + initialize + tools/list end-to-end", async () => {
		const bearer = await issueBearer();
		const mcp = makeMcpClient({
			fetch: SELF.fetch.bind(SELF),
			baseUrl: ORIGIN,
			bearer,
		});

		const init = await mcp.initialize({ clientInfo: { name: "mcp-e2e", version: "0" } });
		expect(mcp.sessionId, "server must return Mcp-Session-Id").toBeTruthy();
		expect(init.serverInfo?.name).toBe("remote-mcp-github");

		const tools = await mcp.call("tools/list", {});
		const names = (tools.tools ?? []).map((t) => t.name);
		// Count floor catches "tools silently dropped from registration"; spot-checks
		// catch "this specific tool stopped registering". The exact inventory lives
		// in the README and would drift here on every new tool — don't enumerate.
		expect(names.length, "tool count regressed").toBeGreaterThanOrEqual(27);
		for (const required of [
			"list_my_repos", // repos read
			"create_repository", // repos write
			"fork_repository", // repos write
			"delete_repository", // repos write
			"search_issues", // issues read
			"add_comment", // issues write
			"list_branches", // branches
			"commit_file", // files
			"create_pull_request", // pulls
			"create_pending_pr_review", // pulls write (pending review lifecycle)
			"add_comment_to_pending_pr_review", // pulls write (pending review lifecycle)
			"submit_pending_pr_review", // pulls write (pending review lifecycle)
			"delete_pending_pr_review", // pulls write (pending review lifecycle)
			"search_code", // search
			"list_workflow_runs", // actions
			"list_gists", // gists read
			"create_gist", // gists write
			"update_gist", // gists write
			"delete_gist", // gists write
		]) {
			expect(names, `tools/list missing ${required}`).toContain(required);
		}
	});
});
