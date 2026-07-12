import { blake2b } from "@noble/hashes/blake2.js";
import nacl from "tweetnacl";

// GitHub Actions / Codespaces / Dependabot secrets must be encrypted
// client-side with libsodium's sealed-box construction against the repo's
// public key before upload — the API rejects plaintext. libsodium itself
// (libsodium-wrappers) compiles WASM at runtime, which the Workers runtime
// forbids ("Wasm code generation disallowed by embedder"), so the sealed box
// is assembled here from pure-JS primitives instead — the same construction
// the `tweetsodium` package (GitHub's own former docs example) uses:
//
//   sealed = ephemeral_pk(32) || crypto_box(m, nonce, recipient_pk, ephemeral_sk)
//   nonce  = BLAKE2b-192(ephemeral_pk || recipient_pk)

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const toBase64 = (bytes: Uint8Array): string => {
	// Chunked to avoid the argument-count ceiling String.fromCharCode(...bytes)
	// hits on multi-KB payloads (secrets may be up to 48 KB).
	let binary = "";
	const CHUNK = 0x2000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
};

/**
 * Encrypt a secret value for GitHub's secret-write endpoints: a libsodium
 * sealed box of `plaintext` against the repository public key (base64, from
 * the matching `get*PublicKey` endpoint). Returns the base64 `encrypted_value`
 * the create/update-secret endpoint expects.
 */
export const sealSecret = (plaintext: string, publicKeyBase64: string): string => {
	const recipient = fromBase64(publicKeyBase64);
	const message = new TextEncoder().encode(plaintext);
	const ephemeral = nacl.box.keyPair();
	const nonceInput = new Uint8Array(ephemeral.publicKey.length + recipient.length);
	nonceInput.set(ephemeral.publicKey);
	nonceInput.set(recipient, ephemeral.publicKey.length);
	const nonce = blake2b(nonceInput, { dkLen: nacl.box.nonceLength });
	const box = nacl.box(message, nonce, recipient, ephemeral.secretKey);
	const sealed = new Uint8Array(ephemeral.publicKey.length + box.length);
	sealed.set(ephemeral.publicKey);
	sealed.set(box, ephemeral.publicKey.length);
	return toBase64(sealed);
};
