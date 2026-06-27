import { describe, expect, it } from "vitest";

import {
	cursorMoreHint,
	MAX_RESPONSE_CHARS,
	previewLine,
	restListHeader,
	truncate,
	truncateTail,
} from "../src/mcp/response.js";

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

describe("truncateTail", () => {
	it("returns the input unchanged when it is within the cap", () => {
		const text = "x".repeat(MAX_RESPONSE_CHARS);
		expect(truncateTail(text)).toBe(text);
	});

	it("keeps the tail and drops the head when the input overflows", () => {
		const head = "H".repeat(MAX_RESPONSE_CHARS);
		const text = `${head}TAIL_MARKER`;
		const result = truncateTail(text);
		expect(result.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
		expect(result).toContain("TAIL_MARKER");
		expect(result).not.toContain(head);
		expect(result).toContain("leading characters omitted");
	});

	it("prefixes the notice (dropped region is the head)", () => {
		const text = "y".repeat(2000);
		const result = truncateTail(text, 500);
		expect(result.startsWith("... (truncated;")).toBe(true);
		expect(result.length).toBeLessThanOrEqual(500);
	});

	it("embeds the caller-supplied follow-up instruction", () => {
		const text = "z".repeat(2000);
		const result = truncateTail(text, 500, "Open the run on GitHub.");
		expect(result).toContain("Open the run on GitHub.");
	});

	it("still honours maxChars when it is smaller than the notice itself", () => {
		const result = truncateTail("z".repeat(100), 10);
		expect(result.length).toBeLessThanOrEqual(10);
	});
});

describe("restListHeader", () => {
	it("collapses to '# Title (count)' when there is no next page", () => {
		expect(restListHeader({ title: "Commits", count: 3, page: 1, hasMore: false })).toBe(
			"# Commits (3)",
		);
	});

	it("folds the page/per_page hint into the parenthetical when more pages remain", () => {
		expect(restListHeader({ title: "Commits", count: 30, page: 2, hasMore: true })).toBe(
			"# Commits (page 2, 30 shown; more available — pass next `page` or raise `per_page` up to 100)",
		);
	});

	it("treats an undefined page as page 1", () => {
		expect(restListHeader({ title: "Repositories", count: 5, hasMore: true })).toBe(
			"# Repositories (page 1, 5 shown; more available — pass next `page` or raise `per_page` up to 100)",
		);
	});
});

describe("previewLine", () => {
	it("collapses every whitespace run (newlines, tabs, multiple spaces) into a single space", () => {
		expect(previewLine("a\n\nb\tc   d")).toBe("a b c d");
	});

	it("returns '' for null, undefined, empty, and whitespace-only bodies", () => {
		expect(previewLine(null)).toBe("");
		expect(previewLine(undefined)).toBe("");
		expect(previewLine("")).toBe("");
		expect(previewLine("   \n\t ")).toBe("");
	});

	it("caps overflow with a single-character ellipsis using the default 200-char max", () => {
		const body = "x".repeat(250);
		const result = previewLine(body);
		// 200 sliced chars + 1 ellipsis char = 201 total.
		expect(result.length).toBe(201);
		expect(result.endsWith("…")).toBe(true);
		expect(result.slice(0, 200)).toBe("x".repeat(200));
	});

	it("honours a custom max so callers can keep their own cap (e.g. pulls snippets at 120)", () => {
		const body = "y".repeat(200);
		const result = previewLine(body, 120);
		expect(result).toBe(`${"y".repeat(120)}…`);
	});

	it("returns the input as-is at exactly max chars (no ellipsis at the boundary)", () => {
		const body = "z".repeat(200);
		expect(previewLine(body)).toBe(body);
	});
});

describe("cursorMoreHint", () => {
	it("returns an empty string when there is no next page", () => {
		expect(
			cursorMoreHint({ shown: 5, total: 5, hasMore: false, nextPageInstruction: "ignored" }),
		).toBe("");
	});

	it("builds a trailing suffix with shown/total and the cursor instruction when more remain", () => {
		expect(
			cursorMoreHint({
				shown: 1,
				total: 10,
				hasMore: true,
				nextPageInstruction: 'Re-invoke with `after: "C"` to fetch the next page.',
			}),
		).toBe(
			'\n\n(1 of 10 shown; more results exist. Re-invoke with `after: "C"` to fetch the next page.)',
		);
	});
});
