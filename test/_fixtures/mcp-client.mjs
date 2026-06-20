// Shared MCP Streamable HTTP client used by both the manual OAuth harness
// (scripts/e2e/oauth-e2e.mjs) and the CI transport E2E (test/mcp-e2e.test.js).
//
// Each caller injects its own `fetch` — Node global in the harness, the
// `cloudflare:test` `SELF.fetch` (bound) in the CI test. All failures are
// surfaced by throwing; both call sites already convert thrown errors into
// their idiomatic outcome (process exit for the harness, test failure for
// vitest).

// Streamable HTTP responses arrive as either `application/json` or
// `text/event-stream` wrapping a single JSON-RPC frame. The MCP SDK currently
// emits SSE for `initialize` / `tools/*`.
export const parseMcpBody = async (resp) => {
	const ct = resp.headers.get("content-type") ?? "";
	const raw = await resp.text();
	if (ct.includes("application/json")) return JSON.parse(raw);
	for (const block of raw.split(/\r?\n\r?\n/)) {
		for (const line of block.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trimStart();
			if (data.length > 0 && data !== "[DONE]") return JSON.parse(data);
		}
	}
	throw new Error(`unparseable /mcp response (ct=${ct}):\n${raw}`);
};

export const makeMcpClient = ({ fetch: fetchImpl, baseUrl, bearer, path = "/mcp" }) => {
	// Tolerate baseUrl values that include a trailing slash (e.g. MCP_BASE=…:8788/)
	// so callers don't have to remember; `${base}/mcp` would otherwise emit `//mcp`,
	// which some servers and intermediaries route distinctly. `path` lets the PAT
	// E2E target `/pat/mcp` instead of the canonical `/mcp`.
	const mcpUrl = `${baseUrl.replace(/\/+$/, "")}${path}`;
	let sessionId = null;
	let id = 0;
	const call = async (method, params) => {
		id += 1;
		const headers = {
			authorization: `Bearer ${bearer}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		};
		if (sessionId != null) headers["mcp-session-id"] = sessionId;
		const r = await fetchImpl(mcpUrl, {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		});
		const respSession = r.headers.get("mcp-session-id");
		if (respSession != null && sessionId == null) sessionId = respSession;
		if (!r.ok) throw new Error(`${path} ${method} returned ${r.status}: ${await r.text()}`);
		const body = await parseMcpBody(r);
		if (body.error != null)
			throw new Error(`${path} ${method} error: ${JSON.stringify(body.error)}`);
		return body.result;
	};
	const initialize = async ({ clientInfo }) => {
		const result = await call("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo,
		});
		if (sessionId == null) {
			throw new Error("server did not return Mcp-Session-Id on initialize");
		}
		return result;
	};
	return {
		call,
		initialize,
		get sessionId() {
			return sessionId;
		},
	};
};
