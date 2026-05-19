import { describe, expect, it } from "vitest";

describe("smoke", () => {
	it("runs arithmetic", () => {
		expect(1 + 1).toBe(2);
	});

	it("executes inside the Cloudflare Workers pool", () => {
		const id = crypto.randomUUID();
		expect(typeof id).toBe("string");
		expect(id).toMatch(/^[0-9a-f-]+$/);
	});
});
