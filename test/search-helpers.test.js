import { describe, expect, it } from "vitest";

import { searchHeader } from "../src/tools/search-helpers.js";

describe("searchHeader", () => {
	it("emits the 'more' hint when more reachable pages remain", () => {
		expect(
			searchHeader({
				label: "Search results",
				query: "foo",
				page: 1,
				perPage: 30,
				totalCount: 100,
				shownCount: 30,
			}),
		).toBe("# Search results for `foo` (page 1, showing 30 of 100; pass next `page` for more)");
	});

	it("omits the 'more' hint on the final page", () => {
		expect(
			searchHeader({
				label: "Repo search results",
				query: "bar",
				page: 4,
				perPage: 30,
				totalCount: 100,
				shownCount: 10,
			}),
		).toBe("# Repo search results for `bar` (showing 10 of 100)");
	});

	it("treats undefined page as page 1", () => {
		expect(
			searchHeader({
				label: "Code search results",
				query: "baz",
				page: undefined,
				perPage: 20,
				totalCount: 50,
				shownCount: 20,
			}),
		).toBe("# Code search results for `baz` (page 1, showing 20 of 50; pass next `page` for more)");
	});

	it("caps reachable results at 1000 (page at the cap edge yields no 'more' hint)", () => {
		// pageNum * perPage === 1000 — last reachable page; no more pages beyond.
		expect(
			searchHeader({
				label: "Search results",
				query: "q",
				page: 50,
				perPage: 20,
				totalCount: 5000,
				shownCount: 20,
			}),
		).toBe("# Search results for `q` (showing 20 of 5000)");
	});

	it("still hints 'more' on the page just before the 1000 cap", () => {
		// pageNum * perPage === 980 < 1000 — one more reachable page remains.
		expect(
			searchHeader({
				label: "Search results",
				query: "q",
				page: 49,
				perPage: 20,
				totalCount: 5000,
				shownCount: 20,
			}),
		).toBe("# Search results for `q` (page 49, showing 20 of 5000; pass next `page` for more)");
	});
});
