import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { isPatRoute, looksLikePat, patProps, resolvePatToken } from "../src/pat-auth.js";
import { makeMcpClient } from "./_fixtures/mcp-client.mjs";

// Transport-layer E2E for the GitHub-PAT Bearer auth path (issue #128 / ADR-0004).
// The test worker (test/_fixtures/test-worker.ts) injects a fake `patResolver`
// that mirrors the production gate but returns sentinel props instead of calling
// GitHub's `GET /user`, so this exercises the resolveExternalToken → ctx.props →
// MCP session seam without standing up real GitHub. Whether an actual tool call
// reaches GitHub with the PAT is the handler-capture live tier's job (see
// .claude/rules/tool-e2e-handler-capture.md), not this transport test.

const ORIGIN = "http://localhost"; // arbitrary; SELF ignores host
const FAKE_PAT = "ghp_faketokenforpatauthtest0000000000";

describe("PAT auth — unit (resolvePatToken gating)", () => {
	it("accepts a PAT-shaped Bearer on a /pat/* route", () => {
		expect(resolvePatToken({ token: FAKE_PAT, pathname: "/pat/mcp" })).toEqual({
			props: patProps(FAKE_PAT),
		});
		expect(resolvePatToken({ token: "github_pat_abc", pathname: "/pat/sse" })).not.toBeNull();
	});

	it("rejects (null) a PAT on the canonical /mcp route", () => {
		expect(resolvePatToken({ token: FAKE_PAT, pathname: "/mcp" })).toBeNull();
	});

	it("rejects (null) a non-PAT-shaped or empty Bearer even on /pat/*", () => {
		expect(resolvePatToken({ token: "gho_oauthtoken", pathname: "/pat/mcp" })).toBeNull();
		expect(resolvePatToken({ token: "", pathname: "/pat/mcp" })).toBeNull();
	});

	it("isPatRoute / looksLikePat helpers", () => {
		expect(isPatRoute("/pat")).toBe(true);
		expect(isPatRoute("/pat/mcp")).toBe(true);
		expect(isPatRoute("/mcp")).toBe(false);
		expect(isPatRoute("/patio/mcp")).toBe(false); // must not prefix-match a sibling
		expect(looksLikePat("ghp_x")).toBe(true);
		expect(looksLikePat("github_pat_x")).toBe(true);
		expect(looksLikePat("gho_x")).toBe(false);
	});
});

describe("PAT auth — transport E2E", () => {
	it("authenticates a PAT Bearer on /pat/mcp with no OAuth dance", async () => {
		const mcp = makeMcpClient({
			fetch: SELF.fetch.bind(SELF),
			baseUrl: ORIGIN,
			bearer: FAKE_PAT,
			path: "/pat/mcp",
		});

		// No /register + /authorize + /token flow — the PAT is accepted directly.
		const init = await mcp.initialize({ clientInfo: { name: "pat-e2e", version: "0" } });
		expect(mcp.sessionId, "server must return Mcp-Session-Id").toBeTruthy();
		expect(init.serverInfo?.name).toBe("remote-mcp-github");

		// tools/list proves the authenticated MCP session is live (the PAT props
		// were injected and the agent initialised). It does not itself call GitHub.
		const tools = await mcp.call("tools/list", {});
		const names = (tools.tools ?? []).map((t) => t.name);
		expect(names, "PAT session missing a known tool").toContain("list_my_repos");
	});

	it("rejects the same PAT Bearer on the canonical /mcp (resolver gates on /pat/*)", async () => {
		const r = await SELF.fetch(`${ORIGIN}/mcp`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${FAKE_PAT}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		expect(r.status).toBe(401);
	});

	it("rejects a non-PAT-shaped Bearer on /pat/mcp", async () => {
		const r = await SELF.fetch(`${ORIGIN}/pat/mcp`, {
			method: "POST",
			headers: {
				authorization: "Bearer gho_notapattoken",
				"content-type": "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		expect(r.status).toBe(401);
	});

	it("rejects an empty Bearer on /pat/mcp", async () => {
		const r = await SELF.fetch(`${ORIGIN}/pat/mcp`, {
			method: "POST",
			headers: {
				authorization: "Bearer ",
				"content-type": "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		expect(r.status).toBe(401);
	});
});
