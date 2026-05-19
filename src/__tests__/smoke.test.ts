import { describe, expect, it } from "vitest";

describe("smoke", () => {
	it("runs arithmetic", () => {
		expect(1 + 1).toBe(2);
	});

	it("executes inside the Cloudflare Workers pool", () => {
		// WebSocketPair and caches.default are Workers-runtime-only globals;
		// asserting them ensures we did not silently fall back to a Node pool.
		expect(typeof WebSocketPair).toBe("function");
		expect(typeof caches.default).toBe("object");
	});
});
