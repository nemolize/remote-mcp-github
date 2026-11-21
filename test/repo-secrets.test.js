import { blake2b } from "@noble/hashes/blake2.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { MAX_VALUE_BYTES } from "../src/tools/common.js";
import { registerRepoSecretTools } from "../src/tools/repo-secrets.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const FAMILIES = [
	{
		namespace: "codespaces",
		label: "Codespaces",
		list: "list_codespaces_secrets",
		set: "set_codespaces_secret",
		delete: "delete_codespaces_secret",
		other: "dependabot",
	},
	{
		namespace: "dependabot",
		label: "Dependabot",
		list: "list_dependabot_secrets",
		set: "set_dependabot_secret",
		delete: "delete_dependabot_secret",
		other: "codespaces",
	},
];

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

const sealOpen = (sealedB64, keyPair) => {
	const sealed = Uint8Array.from(atob(sealedB64), (c) => c.charCodeAt(0));
	const epk = sealed.subarray(0, 32);
	const nonceInput = new Uint8Array(64);
	nonceInput.set(epk);
	nonceInput.set(keyPair.publicKey, 32);
	const nonce = blake2b(nonceInput, { dkLen: nacl.box.nonceLength });
	const opened = nacl.box.open(sealed.subarray(32), nonce, epk, keyPair.secretKey);
	return opened == null ? null : new TextDecoder().decode(opened);
};

const unexpected = (name) => async () => {
	throw new Error(`unexpected call: ${name}`);
};

const stubOctokit = (namespace, overrides = {}) => {
	const guarded = (ns) => ({
		listRepoSecrets: unexpected(`${ns}.listRepoSecrets`),
		getRepoPublicKey: unexpected(`${ns}.getRepoPublicKey`),
		createOrUpdateRepoSecret: unexpected(`${ns}.createOrUpdateRepoSecret`),
		deleteRepoSecret: unexpected(`${ns}.deleteRepoSecret`),
	});
	return {
		rest: {
			codespaces: guarded("codespaces"),
			dependabot: guarded("dependabot"),
			[namespace]: { ...guarded(namespace), ...overrides },
		},
	};
};

const captureSchemas = () => {
	const schemas = new Map();
	const server = {
		registerTool: (name, config) => {
			schemas.set(name, z.object(config.inputSchema));
		},
	};
	return { schemas, server };
};

describe.each(FAMILIES)("$label repository secret tools", (fam) => {
	it("registers list / set / delete", () => {
		const { handlers, server } = captureHandlers();
		registerRepoSecretTools(server, () => stubOctokit(fam.namespace));
		for (const name of [fam.list, fam.set, fam.delete]) expect(handlers.has(name)).toBe(true);
	});

	it("list renders names and timestamps, never values", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(fam.namespace, {
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
		registerRepoSecretTools(server, () => octokit);
		const result = await invoke(handlers, fam.list, { owner: "o", repo: "r", per_page: 30 });
		const body = result.content[0].text;
		expect(body).toContain(`# ${fam.label} secrets (1)`);
		expect(body).toContain(
			"**DEPLOY_TOKEN** — created 2026-01-01T00:00:00Z, updated 2026-02-01T00:00:00Z",
		);
	});

	it("list reports an empty family", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(fam.namespace, {
			listRepoSecrets: async () => ({ data: { total_count: 0, secrets: [] }, headers: {} }),
		});
		registerRepoSecretTools(server, () => octokit);
		const result = await invoke(handlers, fam.list, { owner: "o", repo: "r", per_page: 30 });
		expect(result.content[0].text).toBe(`(no ${fam.label} secrets found)`);
	});

	it("set seals with this family's own public key and never echoes the value", async () => {
		const kp = nacl.box.keyPair();
		let put = null;
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(fam.namespace, {
			getRepoPublicKey: async () => ({
				data: { key_id: "key-1", key: toBase64(kp.publicKey) },
				headers: {},
			}),
			createOrUpdateRepoSecret: async (params) => {
				put = params;
				return { data: {}, headers: {}, status: 201 };
			},
		});
		registerRepoSecretTools(server, () => octokit);
		const result = await invoke(handlers, fam.set, {
			owner: "o",
			repo: "r",
			secret_name: "MY_SECRET",
			value: "plain-text-value",
		});
		const body = result.content[0].text;
		expect(result.isError).toBeUndefined();
		expect(body).toContain(`# ${fam.label} secret created`);
		expect(body).toContain("`MY_SECRET` in o/r created");
		expect(body).not.toContain("plain-text-value");
		expect(put.key_id).toBe("key-1");
		expect(put.encrypted_value).not.toContain("plain-text-value");
		expect(sealOpen(put.encrypted_value, kp)).toBe("plain-text-value");
	});

	it("set never touches the other family's namespace", async () => {
		const kp = nacl.box.keyPair();
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(fam.namespace, {
			getRepoPublicKey: async () => ({
				data: { key_id: "k", key: toBase64(kp.publicKey) },
				headers: {},
			}),
			createOrUpdateRepoSecret: async () => ({ data: {}, headers: {}, status: 204 }),
		});
		registerRepoSecretTools(server, () => octokit);
		const result = await invoke(handlers, fam.set, {
			owner: "o",
			repo: "r",
			secret_name: "MY_SECRET",
			value: "v",
		});
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("`MY_SECRET` in o/r updated");
	});

	it("set surfaces a public-key failure without writing", async () => {
		let wrote = false;
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(fam.namespace, {
			getRepoPublicKey: async () => {
				throw Object.assign(new Error("Not Found"), { status: 404 });
			},
			createOrUpdateRepoSecret: async () => {
				wrote = true;
				return { data: {}, headers: {}, status: 201 };
			},
		});
		registerRepoSecretTools(server, () => octokit);
		const result = await invoke(handlers, fam.set, {
			owner: "o",
			repo: "r",
			secret_name: "MY_SECRET",
			value: "v",
		});
		expect(result.isError).toBe(true);
		expect(wrote).toBe(false);
	});

	it("delete removes by name", async () => {
		let deleted = null;
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit(fam.namespace, {
			deleteRepoSecret: async (params) => {
				deleted = params;
				return { data: {}, headers: {} };
			},
		});
		registerRepoSecretTools(server, () => octokit);
		const result = await invoke(handlers, fam.delete, {
			owner: "o",
			repo: "r",
			secret_name: "OLD_SECRET",
		});
		expect(deleted).toEqual({ owner: "o", repo: "r", secret_name: "OLD_SECRET" });
		expect(result.content[0].text).toContain(`# ${fam.label} secret deleted`);
	});

	it("rejects bad names and values over the byte cap at the schema", () => {
		const { schemas, server } = captureSchemas();
		registerRepoSecretTools(server, () => stubOctokit(fam.namespace));
		const base = { owner: "o", repo: "r" };
		const set = (secret_name, value) =>
			schemas.get(fam.set).safeParse({ ...base, secret_name, value });
		expect(set("OK_NAME", "a".repeat(MAX_VALUE_BYTES)).success).toBe(true);
		expect(set("OK_NAME", "a".repeat(MAX_VALUE_BYTES + 1)).success).toBe(false);
		expect(set("OK_NAME", "あ".repeat(MAX_VALUE_BYTES / 3 + 1)).success).toBe(false);
		expect(set("MY-SECRET", "v").success).toBe(false);
		expect(set("1ABC", "v").success).toBe(false);
		expect(set("GITHUB_TOKEN", "v").success).toBe(false);
		expect(schemas.get(fam.delete).safeParse({ ...base, secret_name: "GITHUB_X" }).success).toBe(
			false,
		);
	});
});

describe("repository secret tool wiring", () => {
	it("two families seal for distinct recipients when both are set in one session", async () => {
		const codespacesKey = nacl.box.keyPair();
		const dependabotKey = nacl.box.keyPair();
		const puts = {};
		const octokit = {
			rest: {
				codespaces: {
					getRepoPublicKey: async () => ({
						data: { key_id: "cs", key: toBase64(codespacesKey.publicKey) },
						headers: {},
					}),
					createOrUpdateRepoSecret: async (p) => {
						puts.codespaces = p;
						return { data: {}, headers: {}, status: 201 };
					},
				},
				dependabot: {
					getRepoPublicKey: async () => ({
						data: { key_id: "db", key: toBase64(dependabotKey.publicKey) },
						headers: {},
					}),
					createOrUpdateRepoSecret: async (p) => {
						puts.dependabot = p;
						return { data: {}, headers: {}, status: 201 };
					},
				},
			},
		};
		const { handlers, server } = captureHandlers();
		registerRepoSecretTools(server, () => octokit);
		const args = { owner: "o", repo: "r", secret_name: "S", value: "v" };
		await invoke(handlers, "set_codespaces_secret", args);
		await invoke(handlers, "set_dependabot_secret", args);
		expect(puts.codespaces.key_id).toBe("cs");
		expect(sealOpen(puts.codespaces.encrypted_value, codespacesKey)).toBe("v");
		expect(sealOpen(puts.codespaces.encrypted_value, dependabotKey)).toBeNull();
		expect(puts.dependabot.key_id).toBe("db");
		expect(sealOpen(puts.dependabot.encrypted_value, dependabotKey)).toBe("v");
		expect(sealOpen(puts.dependabot.encrypted_value, codespacesKey)).toBeNull();
	});
});
