import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MAX_MCP_MESSAGE_BYTES } from "../src/mcp/body-limit.js";
import { MAX_BASE64_LENGTH } from "../src/tools/attachments.js";
import {
	MAX_FILES_PER_COMMIT,
	MAX_REVIEW_COMMENTS,
	MAX_TOOL_INPUT_ELEMENTS,
} from "../src/tools/common.js";
import { makeMcpClient, parseMcpBody } from "./_fixtures/mcp-client.mjs";

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
			"lock_issue", // issues write (lifecycle)
			"transfer_issue", // issues write (lifecycle)
			"delete_issue", // issues write (lifecycle)
			"develop_issue", // issues write (lifecycle)
			"update_issue_comment", // issues write (comment edit)
			"update_pr_review_comment", // pulls write (review comment edit)
			"list_pr_review_thread_comments", // pulls read (thread comments discovery)
			"list_branches", // branches
			"commit_file", // files
			"create_pull_request", // pulls
			"create_pending_pr_review", // pulls write (pending review lifecycle)
			"add_comment_to_pending_pr_review", // pulls write (pending review lifecycle)
			"submit_pending_pr_review", // pulls write (pending review lifecycle)
			"delete_pending_pr_review", // pulls write (pending review lifecycle)
			"search_code", // search
			"search_users", // search
			"search_orgs", // search
			"search_pull_requests", // search
			"list_workflow_runs", // actions
			"list_actions_secrets", // actions admin read
			"set_actions_secret", // actions admin write
			"delete_actions_secret", // actions admin write
			"list_actions_variables", // actions admin read
			"get_actions_variable", // actions admin read
			"set_actions_variable", // actions admin write
			"delete_actions_variable", // actions admin write
			"list_actions_caches", // actions admin read
			"delete_actions_cache", // actions admin write
			"enable_workflow", // actions admin write
			"disable_workflow", // actions admin write
			"get_secret_scanning_alert", // security scanning
			"get_code_scanning_alert", // security scanning
			"get_dependabot_alert", // security scanning
			"list_gists", // gists read
			"create_gist", // gists write
			"update_gist", // gists write
			"delete_gist", // gists write
			"list_projects", // projects read
			"get_project", // projects read
			"list_project_items", // projects read
			"list_project_fields", // projects read
			"add_project_item", // projects write
			"remove_project_item", // projects write
			"update_project_item_field", // projects write
			"create_project_draft_item", // projects write
			"create_project", // projects write
			"update_project", // projects write
			"delete_project", // projects write
			"copy_project", // projects write
			"link_project_to_repository", // projects write
			"unlink_project_from_repository", // projects write
			"create_project_field", // projects write
			"delete_project_field", // projects write
			"archive_project_item", // projects write
			"list_discussions", // discussions read
			"list_discussion_categories", // discussions read
			"get_discussion", // discussions read
			"get_discussion_comments", // discussions read
			"create_label", // labels write (definition CRUD)
			"clone_labels", // labels write (cross-repo clone)
			"upload_attachment", // attachments write
		]) {
			expect(names, `tools/list missing ${required}`).toContain(required);
		}
	});
});

describe("MCP input bounds over the transport", () => {
	const connect = async () => {
		const bearer = await issueBearer();
		const mcp = makeMcpClient({ fetch: SELF.fetch.bind(SELF), baseUrl: ORIGIN, bearer });
		await mcp.initialize({ clientInfo: { name: "mcp-e2e", version: "0" } });
		const handlerCalls = async () =>
			JSON.parse(
				(await mcp.call("tools/call", { name: "_test_handler_calls", arguments: {} })).content[0]
					.text,
			);
		const callTool = (name, args) => mcp.call("tools/call", { name, arguments: args });
		const post = (path, body, headers = {}) =>
			SELF.fetch(`${ORIGIN}${path}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${bearer}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"mcp-session-id": mcp.sessionId,
					...headers,
				},
				body,
			});
		return { callTool, handlerCalls, post };
	};

	const paddedToolCall = (bytes) => {
		const envelope = (title) =>
			JSON.stringify({
				jsonrpc: "2.0",
				id: 99,
				method: "tools/call",
				params: { name: "create_issue", arguments: { owner: "o", repo: "r", title } },
			});
		const body = envelope("x".repeat(bytes - envelope("").length));
		expect(body.length).toBe(bytes);
		return body;
	};

	const streamOf = (text) =>
		new ReadableStream({
			start(controller) {
				const bytes = new TextEncoder().encode(text);
				for (let i = 0; i < bytes.length; i += 64 * 1024)
					controller.enqueue(bytes.slice(i, i + 64 * 1024));
				controller.close();
			},
		});

	it("rejects a call over the element budget before the tool handler runs", async () => {
		const { callTool, handlerCalls } = await connect();
		const args = { owner: "o", repo: "r", title: "t" };
		const overBudgetByOne = MAX_TOOL_INPUT_ELEMENTS + 1 - (Object.keys(args).length + 1);
		const result = await callTool("create_issue", {
			...args,
			labels: Array.from({ length: overBudgetByOne }, (_, i) => `l${i}`),
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(
			`more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`,
		);
		expect((await handlerCalls()).create_issue).toBeUndefined();
	});

	it("rejects a malformed collection before the tool handler runs", async () => {
		const { callTool, handlerCalls } = await connect();
		const result = await callTool("create_issue", {
			owner: "o",
			repo: "r",
			title: "t",
			labels: [1, 2, 3],
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Input validation error");
		expect((await handlerCalls()).create_issue).toBeUndefined();
	});

	it.each([
		["an accurate Content-Length", (body) => body, {}],
		["no Content-Length (chunked)", streamOf, {}],
		["an understated Content-Length", streamOf, { "content-length": "10" }],
	])("answers 413 to an oversized /mcp body with %s", async (_label, toBody, headers) => {
		const { handlerCalls, post } = await connect();
		const r = await post("/mcp", toBody(paddedToolCall(MAX_MCP_MESSAGE_BYTES + 1)), headers);
		expect(r.status).toBe(413);
		expect((await handlerCalls()).create_issue).toBeUndefined();
	});

	it.each([
		["an accurate Content-Length", (body) => body, {}],
		["no Content-Length (chunked)", streamOf, {}],
		["an understated Content-Length", streamOf, { "content-length": "10" }],
	])("answers 413 to an oversized /sse/message body with %s", async (_label, toBody, headers) => {
		const { post } = await connect();
		const tooBig = await post(
			"/sse/message?sessionId=unknown",
			toBody(paddedToolCall(MAX_MCP_MESSAGE_BYTES + 1)),
			headers,
		);
		expect(tooBig.status).toBe(413);
		// The same unknown session within the limit reaches agents' handler instead.
		const withinLimit = await post(
			"/sse/message?sessionId=unknown",
			toBody(paddedToolCall(1024)),
			headers,
		);
		expect(withinLimit.status).not.toBe(413);
	});

	it("forwards a body of exactly the limit to the MCP handler", async () => {
		const { post } = await connect();
		const r = await post("/mcp", streamOf(paddedToolCall(MAX_MCP_MESSAGE_BYTES)));
		expect(r.status).toBe(200);
		const body = await parseMcpBody(r);
		expect(body.id).toBe(99);
	});

	it("lets the largest supported payloads reach their handlers", async () => {
		const { callTool, handlerCalls } = await connect();
		const commit = await callTool("commit_files", {
			owner: "o",
			repo: "r",
			branch: "main",
			message: "m",
			files: Array.from({ length: MAX_FILES_PER_COMMIT }, (_, i) => ({
				path: `f${i}.txt`,
				content: "x",
				encoding: "utf-8",
				mode: "100644",
			})),
		});
		const upload = await callTool("upload_attachment", {
			owner: "o",
			repo: "r",
			filename: "a.png",
			content_base64: "A".repeat(MAX_BASE64_LENGTH),
		});
		const review = await callTool("create_pr_review", {
			owner: "o",
			repo: "r",
			pull_number: 1,
			event: "COMMENT",
			body: "b",
			comments: Array.from({ length: MAX_REVIEW_COMMENTS }, (_, i) => ({
				path: `f${i}.ts`,
				body: "b",
				line: 2,
				side: "RIGHT",
				start_line: 1,
				start_side: "RIGHT",
			})),
		});
		for (const result of [commit, upload, review]) {
			expect(result.content[0].text).toContain("offline test stub");
		}
		expect(await handlerCalls()).toMatchObject({
			commit_files: 1,
			upload_attachment: 1,
			create_pr_review: 1,
		});
		const tokens = await callTool("_test_octokit_tokens", {});
		expect(JSON.parse(tokens.content[0].text)).toContain("fake-github-token");
	});
});
