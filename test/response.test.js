import { describe, expect, it } from "vitest";

import { MAX_RESPONSE_CHARS, truncate } from "../src/mcp/response.js";

describe("truncate", () => {
	it("returns the input unchanged when it is within the cap", () => {
		const text = "x".repeat(MAX_RESPONSE_CHARS);
		expect(truncate(text)).toBe(text);
	});

	it("returns a string within maxChars (notice included) when the input overflows", () => {
		const text = "x".repeat(MAX_RESPONSE_CHARS + 5000);
		const result = truncate(text);
		// The whole point of the #52 fix: the notice is counted against the cap,
		// so a caller appending a trailing hint within its own budget stays bounded.
		expect(result.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
		expect(result).toContain("truncated;");
	});

	it("honours a custom maxChars so a caller can reserve room for a trailing hint", () => {
		const hint = '\n\n(re-invoke with after: "CURSOR")';
		const text = "y".repeat(2000);
		const budget = 500;
		const body = truncate(text, budget);
		expect(body.length).toBeLessThanOrEqual(budget);
		// body + hint must stay within the full cap, which is what pulls.ts relies on.
		expect((body + hint).length).toBeLessThanOrEqual(budget + hint.length);
	});

	it("reports a non-negative omitted count in the notice", () => {
		const text = "z".repeat(MAX_RESPONSE_CHARS + 1);
		const result = truncate(text);
		const match = result.match(/truncated; (\d+) more characters/);
		expect(match).not.toBeNull();
		expect(Number(match[1])).toBeGreaterThan(0);
	});

	it("still honours maxChars when it is smaller than the notice itself", () => {
		const result = truncate("z".repeat(100), 10);
		// sliceLen floors at 0, so the notice alone would overflow; the hard cap
		// keeps the result within maxChars for even this degenerate budget.
		expect(result.length).toBeLessThanOrEqual(10);
	});
});
