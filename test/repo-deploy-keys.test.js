import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_RESPONSE_CHARS } from "../src/mcp/response.js";
import { registerRepoDeployKeyTools } from "../src/tools/repo-deploy-keys.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const key = (overrides = {}) => ({
	id: 1,
	title: "ci",
	key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExample",
	read_only: true,
	verified: true,
	created_at: "2026-01-01T00:00:00Z",
	...overrides,
});

const httpError = (message, status) => {
	const err = new Error(message);
	err.status = status;
	return err;
};

const setup = (repos = {}) => {
	const { handlers, server } = captureHandlers();
	const octokit = { rest: { repos } };
	registerRepoDeployKeyTools(server, () => octokit);
	return handlers;
};

const auditLines = (spy) =>
	spy.mock.calls
		.map(([l]) => l)
		.filter((l) => String(l).startsWith("[github-audit] "))
		.map((l) => JSON.parse(l.slice("[github-audit] ".length)));

afterEach(() => {
	vi.restoreAllMocks();
});

describe("list_deploy_keys", () => {
	it("renders id, title, access, verified state and a shortened key", async () => {
		const handlers = setup({
			listDeployKeys: async () => ({
				data: [key(), key({ id: 2, title: "rw", read_only: false, verified: false })],
				headers: {},
			}),
		});
		const body = (
			await invoke(handlers, "list_deploy_keys", { owner: "o", repo: "r", per_page: 30 })
		).content[0].text;
		expect(body).toContain("# Deploy keys of o/r (2)");
		expect(body).toContain("`1` **ci** — read-only, verified");
		expect(body).toContain("`2` **rw** — read/write, unverified");
		expect(body).toContain("`ssh-ed25519 …leExampleExample`");
		expect(body).not.toContain("AAAAC3NzaC1lZDI1NTE5");
	});

	it("tells same-type keys apart by the end of the key, and marks a disabled one", async () => {
		const header = "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBB";
		const handlers = setup({
			listDeployKeys: async () => ({
				data: [
					key({ id: 1, key: `ecdsa-sha2-nistp256 ${header}FirstKeyTailAAAA1111 me@host` }),
					key({
						id: 2,
						key: `ecdsa-sha2-nistp256 ${header}SecondKeyTailBBBB2222`,
						enabled: false,
					}),
				],
				headers: {},
			}),
		});
		const body = (
			await invoke(handlers, "list_deploy_keys", { owner: "o", repo: "r", per_page: 30 })
		).content[0].text;
		expect(body).toContain("`ecdsa-sha2-nistp256 …tKeyTailAAAA1111`");
		expect(body).toContain("`ecdsa-sha2-nistp256 …dKeyTailBBBB2222`");
		expect(body).not.toContain("me@host");
		const [first, second] = body.split("\n").filter((l) => l.startsWith("- "));
		expect(first).not.toContain("disabled");
		expect(second).toContain("verified, disabled, added");
	});

	it("says so when there are no keys, on the first and a later page", async () => {
		const handlers = setup({ listDeployKeys: async () => ({ data: [], headers: {} }) });
		const first = await invoke(handlers, "list_deploy_keys", {
			owner: "o",
			repo: "r",
			per_page: 30,
		});
		expect(first.content[0].text).toBe("(no deploy keys found)");
		const later = await invoke(handlers, "list_deploy_keys", {
			owner: "o",
			repo: "r",
			per_page: 30,
			page: 2,
		});
		expect(later.content[0].text).toBe("(no deploy keys on this page)");
	});

	it("keeps the next-page hint when the list exceeds the response cap", async () => {
		const many = Array.from({ length: 200 }, (_, i) => key({ id: i + 1, title: `key-${i}` }));
		const handlers = setup({
			listDeployKeys: async () => ({ data: many, headers: { link: '<x>; rel="next"' } }),
		});
		const body = (
			await invoke(handlers, "list_deploy_keys", { owner: "o", repo: "r", per_page: 100 })
		).content[0].text;
		expect(body.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
		expect(body).toContain("more available — pass next `page`");
		expect(body).toContain("truncated");
	});

	it("surfaces a GitHub error", async () => {
		const handlers = setup({
			listDeployKeys: async () => {
				throw httpError("Not Found", 404);
			},
		});
		const result = await invoke(handlers, "list_deploy_keys", {
			owner: "o",
			repo: "r",
			per_page: 30,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("HTTP 404");
	});
});

describe("add_deploy_key", () => {
	it("sends read_only as given and audits the created key id", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		let captured;
		const handlers = setup({
			createDeployKey: async (params) => {
				captured = params;
				return { data: key({ id: 7, read_only: false }), headers: {} };
			},
		});
		const result = await invoke(handlers, "add_deploy_key", {
			owner: "o",
			repo: "r",
			key: "ssh-ed25519 AAAA",
			title: "ci",
			read_only: false,
		});
		expect(captured).toEqual({
			owner: "o",
			repo: "r",
			key: "ssh-ed25519 AAAA",
			title: "ci",
			read_only: false,
		});
		expect(result.content[0].text).toContain("# Deploy key added");
		expect(result.content[0].text).toContain("`7` **ci** — read/write");
		expect(auditLines(spy)).toEqual([
			{ tool: "add_deploy_key", owner: "o", repo: "r", deploy_key_id: 7 },
		]);
	});

	it("omits an unset title instead of sending undefined", async () => {
		let captured;
		const handlers = setup({
			createDeployKey: async (params) => {
				captured = params;
				return { data: key(), headers: {} };
			},
		});
		await invoke(handlers, "add_deploy_key", {
			owner: "o",
			repo: "r",
			key: "ssh-ed25519 AAAA",
			read_only: true,
		});
		expect("title" in captured).toBe(false);
		expect(captured.read_only).toBe(true);
	});

	it("surfaces a duplicate-key error with no audit line", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const handlers = setup({
			createDeployKey: async () => {
				throw httpError("key is already in use", 422);
			},
		});
		const result = await invoke(handlers, "add_deploy_key", {
			owner: "o",
			repo: "r",
			key: "ssh-ed25519 AAAA",
			read_only: true,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("HTTP 422");
		expect(auditLines(spy)).toEqual([]);
	});

	it("warns about write access and marks deletion destructive in the descriptions", () => {
		const descriptions = new Map();
		registerRepoDeployKeyTools(
			{ registerTool: (name, config) => descriptions.set(name, config.description) },
			() => ({}),
		);
		expect(descriptions.get("add_deploy_key")).toContain("push access");
		expect(descriptions.get("delete_deploy_key")).toContain("Destructive");
	});
});

describe("delete_deploy_key", () => {
	it("deletes by id and audits it", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		let captured;
		const handlers = setup({
			deleteDeployKey: async (params) => {
				captured = params;
				return { data: undefined, headers: {} };
			},
		});
		const result = await invoke(handlers, "delete_deploy_key", {
			owner: "o",
			repo: "r",
			key_id: 3,
		});
		expect(captured).toEqual({ owner: "o", repo: "r", key_id: 3 });
		expect(result.content[0].text).toContain("# Deploy key deleted");
		expect(auditLines(spy)).toEqual([
			{ tool: "delete_deploy_key", owner: "o", repo: "r", deploy_key_id: 3 },
		]);
	});

	it("surfaces a missing key with no audit line", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const handlers = setup({
			deleteDeployKey: async () => {
				throw httpError("Not Found", 404);
			},
		});
		const result = await invoke(handlers, "delete_deploy_key", {
			owner: "o",
			repo: "r",
			key_id: 3,
		});
		expect(result.isError).toBe(true);
		expect(auditLines(spy)).toEqual([]);
	});
});
