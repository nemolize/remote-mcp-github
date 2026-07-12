import { blake2b } from "@noble/hashes/blake2.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { sealSecret } from "../src/sealed-box.js";
import { registerActionAdminTools } from "../src/tools/actions-admin.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const stubOctokit = (overrides = {}) => ({
	rest: {
		actions: {
			listRepoSecrets: async () => ({ data: { total_count: 0, secrets: [] }, headers: {} }),
			getRepoPublicKey: async () => ({
				data: { key_id: "key-1", key: "" },
				headers: {},
			}),
			createOrUpdateRepoSecret: async () => ({ data: {}, headers: {}, status: 201 }),
			deleteRepoSecret: async () => ({ data: {}, headers: {} }),
			listRepoVariables: async () => ({ data: { total_count: 0, variables: [] }, headers: {} }),
			getRepoVariable: async () => ({ data: {}, headers: {} }),
			createRepoVariable: async () => ({ data: {}, headers: {} }),
			updateRepoVariable: async () => ({ data: {}, headers: {} }),
			getActionsCacheList: async () => ({
				data: { total_count: 0, actions_caches: [] },
				headers: {},
			}),
			deleteActionsCacheById: async () => ({ data: {}, headers: {} }),
			deleteActionsCacheByKey: async () => ({
				data: { total_count: 0, actions_caches: [] },
				headers: {},
			}),
			enableWorkflow: async () => ({ data: {}, headers: {} }),
			disableWorkflow: async () => ({ data: {}, headers: {} }),
			...overrides,
		},
	},
});

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

// Reference sealed-box open (the libsodium construction), so the test proves
// the sealed payload decrypts with the recipient's private key — not merely
// that sealSecret produced base64 of the right length.
const sealOpen = (sealedB64, keyPair) => {
	const sealed = Uint8Array.from(atob(sealedB64), (c) => c.charCodeAt(0));
	const epk = sealed.subarray(0, 32);
	const box = sealed.subarray(32);
	const nonceInput = new Uint8Array(64);
	nonceInput.set(epk);
	nonceInput.set(keyPair.publicKey, 32);
	const nonce = blake2b(nonceInput, { dkLen: nacl.box.nonceLength });
	const opened = nacl.box.open(box, nonce, epk, keyPair.secretKey);
	return opened == null ? null : new TextDecoder().decode(opened);
};

describe("sealSecret", () => {
	it("produces a sealed box the recipient key can open", () => {
		const kp = nacl.box.keyPair();
		const sealed = sealSecret("hunter2", toBase64(kp.publicKey));
		expect(sealOpen(sealed, kp)).toBe("hunter2");
	});

	it("handles multi-KB values (base64 chunking)", () => {
		const kp = nacl.box.keyPair();
		const value = "x".repeat(40_000);
		const sealed = sealSecret(value, toBase64(kp.publicKey));
		expect(sealOpen(sealed, kp)).toBe(value);
	});
});

describe("registerActionAdminTools", () => {
	it("list_actions_secrets renders names and timestamps, never values", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			listRepoSecrets: async () => ({
				data: {
					total_count: 1,
					secrets: [
						{
							name: "DEPLOY_TOKEN",
							created_at: "2026-01-01T00:00:00Z",
							updated_at: "2026-02-01T00:00:00Z",
						},
					],
				},
				headers: {},
			}),
		});
		registerActionAdminTools(server, () => octokit);
		const result = await invoke(handlers, "list_actions_secrets", { owner: "o", repo: "r" });
		const body = result.content[0].text;
		expect(body).toContain("# Actions secrets (1)");
		expect(body).toContain(
			"**DEPLOY_TOKEN** — created 2026-01-01T00:00:00Z, updated 2026-02-01T00:00:00Z",
		);
	});

	it("set_actions_secret encrypts against the repo public key and never echoes the value", async () => {
		const kp = nacl.box.keyPair();
		let putBody = null;
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			getRepoPublicKey: async () => ({
				data: { key_id: "key-1", key: toBase64(kp.publicKey) },
				headers: {},
			}),
			createOrUpdateRepoSecret: async (params) => {
				putBody = params;
				return { data: {}, headers: {}, status: 201 };
			},
		});
		registerActionAdminTools(server, () => octokit);
		const result = await invoke(handlers, "set_actions_secret", {
			owner: "o",
			repo: "r",
			secret_name: "MY_SECRET",
			value: "plain-text-value",
		});
		const body = result.content[0].text;
		expect(result.isError).toBeUndefined();
		expect(body).toContain("`MY_SECRET` in o/r created");
		// The plaintext must appear nowhere: not in the response, not on the wire.
		expect(body).not.toContain("plain-text-value");
		expect(putBody.key_id).toBe("key-1");
		expect(putBody.encrypted_value).not.toContain("plain-text-value");
		expect(sealOpen(putBody.encrypted_value, kp)).toBe("plain-text-value");
	});

	it("set_actions_secret reports 'updated' on a 204 response", async () => {
		const kp = nacl.box.keyPair();
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			getRepoPublicKey: async () => ({
				data: { key_id: "key-1", key: toBase64(kp.publicKey) },
				headers: {},
			}),
			createOrUpdateRepoSecret: async () => ({ data: {}, headers: {}, status: 204 }),
		});
		registerActionAdminTools(server, () => octokit);
		const result = await invoke(handlers, "set_actions_secret", {
			owner: "o",
			repo: "r",
			secret_name: "MY_SECRET",
			value: "v",
		});
		expect(result.content[0].text).toContain("`MY_SECRET` in o/r updated");
	});

	it("list_actions_variables renders name and value", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			listRepoVariables: async () => ({
				data: {
					total_count: 1,
					variables: [
						{
							name: "NODE_VERSION",
							value: "22",
							created_at: "2026-01-01T00:00:00Z",
							updated_at: "2026-02-01T00:00:00Z",
						},
					],
				},
				headers: {},
			}),
		});
		registerActionAdminTools(server, () => octokit);
		const result = await invoke(handlers, "list_actions_variables", { owner: "o", repo: "r" });
		expect(result.content[0].text).toContain(
			"**NODE_VERSION** = `22` — updated 2026-02-01T00:00:00Z",
		);
	});

	it("get_actions_variable renders the value and timestamps", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			getRepoVariable: async () => ({
				data: {
					name: "NODE_VERSION",
					value: "22",
					created_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-02-01T00:00:00Z",
				},
				headers: {},
			}),
		});
		registerActionAdminTools(server, () => octokit);
		const result = await invoke(handlers, "get_actions_variable", {
			owner: "o",
			repo: "r",
			name: "NODE_VERSION",
		});
		const body = result.content[0].text;
		expect(body).toContain("# Actions variable `NODE_VERSION` in o/r");
		expect(body).toContain("> value: `22`");
	});

	it("set_actions_variable creates when the name is new", async () => {
		const { handlers, server } = captureHandlers();
		let created = null;
		const octokit = stubOctokit({
			createRepoVariable: async (params) => {
				created = params;
				return { data: {}, headers: {} };
			},
		});
		registerActionAdminTools(server, () => octokit);
		const result = await invoke(handlers, "set_actions_variable", {
			owner: "o",
			repo: "r",
			name: "NODE_VERSION",
			value: "22",
		});
		expect(result.content[0].text).toContain("`NODE_VERSION` in o/r created");
		expect(created).toMatchObject({ owner: "o", repo: "r", name: "NODE_VERSION", value: "22" });
	});

	it("set_actions_variable falls back to update on 409 Conflict", async () => {
		const { handlers, server } = captureHandlers();
		let updated = null;
		const octokit = stubOctokit({
			createRepoVariable: async () => {
				throw Object.assign(new Error("already exists"), { status: 409 });
			},
			updateRepoVariable: async (params) => {
				updated = params;
				return { data: {}, headers: {} };
			},
		});
		registerActionAdminTools(server, () => octokit);
		const result = await invoke(handlers, "set_actions_variable", {
			owner: "o",
			repo: "r",
			name: "NODE_VERSION",
			value: "24",
		});
		expect(result.content[0].text).toContain("`NODE_VERSION` in o/r updated");
		expect(updated).toMatchObject({ name: "NODE_VERSION", value: "24" });
	});

	it("set_actions_variable surfaces non-409 create errors", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			createRepoVariable: async () => {
				throw Object.assign(new Error("Forbidden"), { status: 403 });
			},
		});
		registerActionAdminTools(server, () => octokit);
		const result = await invoke(handlers, "set_actions_variable", {
			owner: "o",
			repo: "r",
			name: "NODE_VERSION",
			value: "24",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("HTTP 403");
	});

	it("list_actions_caches renders ID, key, size, ref", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			getActionsCacheList: async () => ({
				data: {
					total_count: 1,
					actions_caches: [
						{
							id: 42,
							key: "pnpm-store-abc",
							ref: "refs/heads/main",
							size_in_bytes: 104857600,
							last_accessed_at: "2026-06-01T00:00:00Z",
						},
					],
				},
				headers: {},
			}),
		});
		registerActionAdminTools(server, () => octokit);
		const result = await invoke(handlers, "list_actions_caches", { owner: "o", repo: "r" });
		expect(result.content[0].text).toContain(
			"`42` **pnpm-store-abc** — 100.0 MiB on `refs/heads/main`, last accessed 2026-06-01T00:00:00Z",
		);
	});

	it("delete_actions_cache rejects when both cache_id and key are given", async () => {
		const { handlers, server } = captureHandlers();
		registerActionAdminTools(server, () => stubOctokit());
		const result = await invoke(handlers, "delete_actions_cache", {
			owner: "o",
			repo: "r",
			cache_id: 42,
			key: "k",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("exactly one of");
	});

	it("delete_actions_cache rejects when neither cache_id nor key is given", async () => {
		const { handlers, server } = captureHandlers();
		registerActionAdminTools(server, () => stubOctokit());
		const result = await invoke(handlers, "delete_actions_cache", { owner: "o", repo: "r" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("exactly one of");
	});

	it("delete_actions_cache by key reports the deleted count", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			deleteActionsCacheByKey: async () => ({
				data: { total_count: 2, actions_caches: [{}, {}] },
				headers: {},
			}),
		});
		registerActionAdminTools(server, () => octokit);
		const result = await invoke(handlers, "delete_actions_cache", {
			owner: "o",
			repo: "r",
			key: "pnpm-store-abc",
		});
		expect(result.content[0].text).toContain("2 cache(s) with key `pnpm-store-abc`");
	});

	it("enable_workflow / disable_workflow forward filename workflow IDs", async () => {
		const seen = [];
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			enableWorkflow: async (params) => {
				seen.push(["enable", params.workflow_id]);
				return { data: {}, headers: {} };
			},
			disableWorkflow: async (params) => {
				seen.push(["disable", params.workflow_id]);
				return { data: {}, headers: {} };
			},
		});
		registerActionAdminTools(server, () => octokit);
		const enabled = await invoke(handlers, "enable_workflow", {
			owner: "o",
			repo: "r",
			workflow_id: "ci.yml",
		});
		const disabled = await invoke(handlers, "disable_workflow", {
			owner: "o",
			repo: "r",
			workflow_id: 123,
		});
		expect(enabled.content[0].text).toContain("# Workflow enabled");
		expect(disabled.content[0].text).toContain("# Workflow disabled");
		expect(seen).toEqual([
			["enable", "ci.yml"],
			["disable", 123],
		]);
	});
});
