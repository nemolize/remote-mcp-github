#!/usr/bin/env node
// Manual OAuth E2E harness for the remote-mcp-github server.
//
// Boots no service of its own. Expects `pnpm dev` to already be running and
// drives the full OAuth 2.1 + PKCE dance against it, then exercises a few
// read tools over the Streamable HTTP MCP transport and asserts on the
// rendered Markdown.
//
// The only manual step is approving the GitHub OAuth consent in the browser
// window opened by step [3]; everything else is scripted. CI does not run
// this harness — it is a developer convenience.
//
// Env (all optional; defaults target this repo so the maintainer can run it
// with no setup):
//   MCP_BASE        base URL of the running server (default http://localhost:8788)
//   CALLBACK_PORT   localhost port that catches ?code=... (default 9876)
//   EXPECTED_OWNER  owner used for get_repo (default nemolize)
//   EXPECTED_REPO   repo  used for get_repo (default remote-mcp-github)
//   EXPECTED_LOGIN  login asserted on get_authenticated_user (default nemolize)
//   TIMEOUT_MS      how long to wait for the OAuth callback (default 300000)

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const die = (msg) => {
	console.error(`✗ ${msg}`);
	process.exit(1);
};

const intEnv = (name, fallback, { min, max } = {}) => {
	const raw = process.env[name];
	if (raw == null || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n)) die(`${name}=${raw} is not an integer`);
	if (min != null && n < min) die(`${name}=${n} must be >= ${min}`);
	if (max != null && n > max) die(`${name}=${n} must be <= ${max}`);
	return n;
};

const MCP_BASE = process.env.MCP_BASE ?? "http://localhost:8788";
const CALLBACK_PORT = intEnv("CALLBACK_PORT", 9876, { min: 1, max: 65535 });
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;
const EXPECTED_OWNER = process.env.EXPECTED_OWNER ?? "nemolize";
const EXPECTED_REPO = process.env.EXPECTED_REPO ?? "remote-mcp-github";
const EXPECTED_LOGIN = process.env.EXPECTED_LOGIN ?? "nemolize";
const TIMEOUT_MS = intEnv("TIMEOUT_MS", 300_000, { min: 1 });

const b64url = (buf) =>
	Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const expectLine = (haystack, needle) => {
	if (!haystack.split("\n").includes(needle)) {
		die(`Expected line not found:\n  ${needle}\n--- got ---\n${haystack}`);
	}
};

const expectIncludes = (haystack, needle) => {
	if (!haystack.includes(needle)) {
		die(`Expected substring not found:\n  ${needle}\n--- got ---\n${haystack}`);
	}
};

const probeServer = async () => {
	const url = `${MCP_BASE}/.well-known/oauth-authorization-server`;
	const r = await fetch(url).catch((e) => {
		die(`cannot reach ${MCP_BASE} — is \`pnpm dev\` running? (${e.message})`);
	});
	if (!r.ok) die(`${url} returned ${r.status}`);
};

const registerClient = async () => {
	const r = await fetch(`${MCP_BASE}/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			redirect_uris: [CALLBACK_URL],
			client_name: "remote-mcp-github smoke harness",
			token_endpoint_auth_method: "none",
		}),
	});
	if (!r.ok) die(`/register returned ${r.status}: ${await r.text()}`);
	const body = await r.json();
	if (typeof body.client_id !== "string") {
		die(`/register response missing client_id: ${JSON.stringify(body)}`);
	}
	return body.client_id;
};

const waitForCode = (expectedState) =>
	new Promise((resolve, reject) => {
		let timer;
		const finish = (fn, value) => {
			clearTimeout(timer);
			server.close();
			fn(value);
		};
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", CALLBACK_URL);
			if (url.pathname !== "/callback") {
				res.writeHead(404).end("not found");
				return;
			}
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			if (state !== expectedState) {
				res.writeHead(400).end("state mismatch");
				finish(reject, new Error(`state mismatch: got ${state}, expected ${expectedState}`));
				return;
			}
			if (code == null) {
				const err = url.searchParams.get("error") ?? "(no code, no error)";
				res.writeHead(400).end(`error: ${err}`);
				finish(reject, new Error(`OAuth error: ${err}`));
				return;
			}
			res
				.writeHead(200, { "content-type": "text/html; charset=utf-8" })
				.end("<h1>OK</h1><p>You can close this tab.</p>");
			finish(resolve, code);
		});
		server.on("error", (err) => finish(reject, err));
		timer = setTimeout(
			() => finish(reject, new Error(`timed out after ${TIMEOUT_MS}ms waiting for OAuth callback`)),
			TIMEOUT_MS,
		);
		server.listen(CALLBACK_PORT);
	});

const exchangeToken = async ({ code, clientId, verifier }) => {
	const r = await fetch(`${MCP_BASE}/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: CALLBACK_URL,
			client_id: clientId,
			code_verifier: verifier,
		}),
	});
	if (!r.ok) die(`/token returned ${r.status}: ${await r.text()}`);
	const body = await r.json();
	if (typeof body.access_token !== "string") {
		die(`/token response missing access_token: ${JSON.stringify(body)}`);
	}
	return body.access_token;
};

// The Streamable HTTP transport may answer with either application/json or
// text/event-stream. Both wrap a single JSON-RPC message we care about.
const parseMcpBody = async (r) => {
	const ct = r.headers.get("content-type") ?? "";
	const raw = await r.text();
	if (ct.includes("application/json")) return JSON.parse(raw);
	for (const block of raw.split(/\r?\n\r?\n/)) {
		for (const line of block.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trimStart();
			if (data.length > 0 && data !== "[DONE]") return JSON.parse(data);
		}
	}
	die(`/mcp response was neither JSON nor a parseable SSE frame:\n${raw}`);
};

const makeMcpClient = (bearer) => {
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
		const r = await fetch(`${MCP_BASE}/mcp`, {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		});
		const respSession = r.headers.get("mcp-session-id");
		if (respSession != null && sessionId == null) sessionId = respSession;
		if (!r.ok) die(`/mcp ${method} returned ${r.status}: ${await r.text()}`);
		const body = await parseMcpBody(r);
		if (body.error != null) die(`/mcp ${method} error: ${JSON.stringify(body.error)}`);
		return body.result;
	};
	const initialize = async () => {
		await call("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "remote-mcp-github-smoke", version: "0" },
		});
		if (sessionId == null) die("server did not return Mcp-Session-Id on initialize");
	};
	return { call, initialize };
};

const toolText = (result) => {
	const piece = result?.content?.find((c) => c.type === "text")?.text;
	if (typeof piece !== "string") {
		die(`tool result missing text content: ${JSON.stringify(result)}`);
	}
	return piece;
};

const main = async () => {
	console.log(`[1/7] probing ${MCP_BASE}`);
	await probeServer();

	console.log("[2/7] dynamic client registration");
	const clientId = await registerClient();

	const state = b64url(randomBytes(16));
	const verifier = b64url(randomBytes(32));
	const challenge = b64url(createHash("sha256").update(verifier).digest());
	const authUrl =
		`${MCP_BASE}/authorize?` +
		new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: CALLBACK_URL,
			scope: "read:user repo",
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();
	console.log(`[3/7] open in a browser already signed in to GitHub:\n  ${authUrl}`);
	console.log(`      waiting for callback on ${CALLBACK_URL} (timeout ${TIMEOUT_MS}ms)`);

	const code = await waitForCode(state);

	console.log("[4/7] exchanging code at /token");
	const bearer = await exchangeToken({ code, clientId, verifier });

	const mcp = makeMcpClient(bearer);
	console.log("[5/7] initialize");
	await mcp.initialize();

	console.log("[6/7] tools/list");
	const tools = await mcp.call("tools/list", {});
	const names = (tools.tools ?? []).map((t) => t.name);
	for (const required of ["get_repo", "get_authenticated_user", "search_repositories"]) {
		if (!names.includes(required)) die(`tools/list missing ${required}`);
	}

	console.log("[7/7] tools/call assertions");

	const meText = toolText(
		await mcp.call("tools/call", { name: "get_authenticated_user", arguments: {} }),
	);
	expectLine(meText, `# @${EXPECTED_LOGIN}`);

	const repoText = toolText(
		await mcp.call("tools/call", {
			name: "get_repo",
			arguments: { owner: EXPECTED_OWNER, repo: EXPECTED_REPO },
		}),
	);
	expectIncludes(repoText, `# ${EXPECTED_OWNER}/${EXPECTED_REPO}`);

	// `user:<login>` plus the repo name is specific enough to pin the target
	// repo even though it is unstarred; a bare repo name would drown it in
	// thousands of forks.
	const searchText = toolText(
		await mcp.call("tools/call", {
			name: "search_repositories",
			arguments: { query: `${EXPECTED_REPO} user:${EXPECTED_OWNER}` },
		}),
	);
	expectIncludes(searchText, `**${EXPECTED_OWNER}/${EXPECTED_REPO}**`);

	console.log("✓ all assertions passed");
};

main().catch((e) => {
	console.error(`✗ ${e.stack ?? e.message}`);
	process.exit(1);
});
