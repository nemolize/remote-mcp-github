import { describe, expect, it } from "vitest";

import { registerCommitTools } from "../src/tools/commits.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const stubOctokit = (overrides) => ({
	rest: {
		repos: {
			listCommits: async () => ({ data: [], headers: {} }),
			getCommit: async () => ({ data: {}, headers: {} }),
			compareCommitsWithBasehead: async () => ({ data: {}, headers: {} }),
			...overrides,
		},
	},
});

describe("registerCommitTools", () => {
	it("list_commits renders short SHA, subject, author, and date", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			listCommits: async () => ({
				data: [
					{
						sha: "abcdef1234567890",
						commit: {
							message: "feat: add thing\n\nlong body that should be dropped",
							author: { name: "Git Author", date: "2026-01-02T03:04:05Z" },
						},
						author: { login: "alice" },
					},
				],
				headers: {},
			}),
		});
		registerCommitTools(server, () => octokit);

		const result = await invoke(handlers, "list_commits", { owner: "o", repo: "r" });
		const body = result.content[0].text;
		expect(body).toContain("# Commits (1)");
		expect(body).toContain("`abcdef1` feat: add thing — alice, 2026-01-02T03:04:05Z");
		// Multi-line body is dropped from the list view.
		expect(body).not.toContain("long body");
		expect(result.isError).toBeUndefined();
	});

	it("list_commits falls back to git author name when no GitHub login is linked", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			listCommits: async () => ({
				data: [
					{
						sha: "1234567abcdef",
						commit: {
							message: "chore: tidy",
							author: { name: "Unlinked Author", date: "2026-02-02T00:00:00Z" },
						},
						author: null,
					},
				],
				headers: {},
			}),
		});
		registerCommitTools(server, () => octokit);

		const result = await invoke(handlers, "list_commits", { owner: "o", repo: "r" });
		expect(result.content[0].text).toContain("— Unlinked Author, 2026-02-02T00:00:00Z");
	});

	it("list_commits shows a pagination hint when a next link is present", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			listCommits: async () => ({
				data: [
					{
						sha: "deadbeefcafe",
						commit: { message: "x", author: { name: "n", date: "2026-01-01T00:00:00Z" } },
						author: { login: "a" },
					},
				],
				headers: { link: '<https://api.github.com/...?page=2>; rel="next"' },
			}),
		});
		registerCommitTools(server, () => octokit);

		const result = await invoke(handlers, "list_commits", { owner: "o", repo: "r", page: 1 });
		expect(result.content[0].text).toContain("page 1, 1 shown; more available");
	});

	it("list_commits reports an empty history", async () => {
		const { handlers, server } = captureHandlers();
		registerCommitTools(server, () => stubOctokit({}));

		const result = await invoke(handlers, "list_commits", { owner: "o", repo: "r" });
		expect(result.content[0].text).toBe("(no commits found)");
	});

	it("get_commit renders header, parents, file stats, and diff", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			getCommit: async () => ({
				data: {
					sha: "feedface0000",
					commit: {
						message: "fix: bug\n\ndetails",
						author: { name: "Dev", date: "2026-03-03T00:00:00Z" },
					},
					author: { login: "dev" },
					parents: [{ sha: "0000111aaaa" }, { sha: "2222333bbbb" }],
					stats: { additions: 10, deletions: 2 },
					files: [
						{
							filename: "src/a.ts",
							status: "modified",
							additions: 8,
							deletions: 2,
							patch: "@@ -1 +1 @@\n-old\n+new",
						},
						{
							filename: "new/b.ts",
							previous_filename: "old/b.ts",
							status: "renamed",
							additions: 2,
							deletions: 0,
						},
					],
					html_url: "https://example.test/commit/feedface",
				},
				headers: {},
			}),
		});
		registerCommitTools(server, () => octokit);

		const result = await invoke(handlers, "get_commit", { owner: "o", repo: "r", ref: "feedface" });
		const body = result.content[0].text;
		expect(body).toContain("# Commit `feedfac` in o/r");
		expect(body).toContain("> fix: bug");
		expect(body).toContain("- author: dev, 2026-03-03T00:00:00Z");
		expect(body).toContain("- parents: `0000111`, `2222333`");
		expect(body).toContain("2 files changed, +10/-2");
		expect(body).toContain("- `modified` +8/-2 `src/a.ts`");
		expect(body).toContain("- `renamed` +2/-0 `old/b.ts → new/b.ts`");
		expect(body).toContain("## Diff");
		expect(body).toContain("### src/a.ts");
		expect(body).toContain("+new");
	});

	it("get_commit omits the Diff section when no file carries a patch", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			getCommit: async () => ({
				data: {
					sha: "abc1234def",
					commit: { message: "merge", author: { name: "n", date: "2026-01-01T00:00:00Z" } },
					author: null,
					parents: [],
					stats: { additions: 0, deletions: 0 },
					files: [],
					html_url: "https://example.test/c",
				},
				headers: {},
			}),
		});
		registerCommitTools(server, () => octokit);

		const result = await invoke(handlers, "get_commit", { owner: "o", repo: "r", ref: "abc1234" });
		const body = result.content[0].text;
		expect(body).toContain("- parents: (none)");
		expect(body).toContain("(no file changes)");
		expect(body).not.toContain("## Diff");
	});

	it("compare_commits renders ahead/behind, merge base, and files", async () => {
		const { handlers, server } = captureHandlers();
		let captured;
		const octokit = stubOctokit({
			compareCommitsWithBasehead: async (params) => {
				captured = params;
				return {
					data: {
						status: "ahead",
						ahead_by: 3,
						behind_by: 0,
						total_commits: 3,
						merge_base_commit: { sha: "mergebase999" },
						files: [{ filename: "x.ts", status: "added", additions: 5, deletions: 0 }],
						html_url: "https://example.test/compare",
					},
					headers: {},
				};
			},
		});
		registerCommitTools(server, () => octokit);

		const result = await invoke(handlers, "compare_commits", {
			owner: "o",
			repo: "r",
			base: "main",
			head: "feature",
		});
		const body = result.content[0].text;
		expect(captured.basehead).toBe("main...feature");
		expect(body).toContain("# Compare `main...feature` in o/r");
		expect(body).toContain("- status: ahead (ahead 3, behind 0)");
		expect(body).toContain("- merge base: `mergeba`");
		expect(body).toContain("- 3 commits");
		expect(body).toContain("- `added` +5/-0 `x.ts`");
	});

	it("compare_commits handles a file-less response (large ranges omit files)", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			compareCommitsWithBasehead: async () => ({
				data: {
					status: "diverged",
					ahead_by: 100,
					behind_by: 50,
					total_commits: 100,
					merge_base_commit: { sha: "base0000" },
					files: undefined,
					html_url: "https://example.test/compare",
				},
				headers: {},
			}),
		});
		registerCommitTools(server, () => octokit);

		const result = await invoke(handlers, "compare_commits", {
			owner: "o",
			repo: "r",
			base: "a",
			head: "b",
		});
		const body = result.content[0].text;
		expect(body).toContain("(no file changes)");
		expect(body).not.toContain("## Diff");
	});

	it("list_commits forwards filter params to Octokit", async () => {
		const { handlers, server } = captureHandlers();
		let captured;
		const octokit = stubOctokit({
			listCommits: async (params) => {
				captured = params;
				return { data: [], headers: {} };
			},
		});
		registerCommitTools(server, () => octokit);

		await invoke(handlers, "list_commits", {
			owner: "o",
			repo: "r",
			sha: "release",
			path: "src/x.ts",
			author: "alice",
			since: "2026-01-01T00:00:00Z",
			until: "2026-02-01T00:00:00Z",
			per_page: 50,
			page: 2,
		});
		expect(captured).toMatchObject({
			owner: "o",
			repo: "r",
			sha: "release",
			path: "src/x.ts",
			author: "alice",
			since: "2026-01-01T00:00:00Z",
			until: "2026-02-01T00:00:00Z",
			per_page: 50,
			page: 2,
		});
	});

	it("compare_commits renders (none) when merge_base_commit is absent (unrelated histories)", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			compareCommitsWithBasehead: async () => ({
				data: {
					status: "diverged",
					ahead_by: 5,
					behind_by: 5,
					total_commits: 10,
					merge_base_commit: undefined,
					files: [],
					html_url: "https://example.test/compare",
				},
				headers: {},
			}),
		});
		registerCommitTools(server, () => octokit);

		const result = await invoke(handlers, "compare_commits", {
			owner: "o",
			repo: "r",
			base: "a",
			head: "b",
		});
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("- merge base: `(none)`");
	});

	it("get_commit warns when GitHub caps the file list at 300 entries", async () => {
		const { handlers, server } = captureHandlers();
		const files = Array.from({ length: 300 }, (_, i) => ({
			filename: `f${i}.ts`,
			status: "modified",
			additions: 1,
			deletions: 0,
		}));
		const octokit = stubOctokit({
			getCommit: async () => ({
				data: {
					sha: "capped00abc",
					commit: { message: "big", author: { name: "n", date: "2026-01-01T00:00:00Z" } },
					author: null,
					parents: [],
					stats: { additions: 300, deletions: 0 },
					files,
					html_url: "https://example.test/c",
				},
				headers: {},
			}),
		});
		registerCommitTools(server, () => octokit);

		const result = await invoke(handlers, "get_commit", { owner: "o", repo: "r", ref: "capped" });
		// The note sits in the header, so it survives truncation even though the
		// 300-entry file list overflows the response cap.
		expect(result.content[0].text).toContain("GitHub caps the file list at 300 entries");
	});

	it("compare_commits warns when GitHub caps the file list at 300 entries", async () => {
		const { handlers, server } = captureHandlers();
		const files = Array.from({ length: 300 }, (_, i) => ({
			filename: `f${i}.ts`,
			status: "modified",
			additions: 1,
			deletions: 0,
		}));
		const octokit = stubOctokit({
			compareCommitsWithBasehead: async () => ({
				data: {
					status: "ahead",
					ahead_by: 300,
					behind_by: 0,
					total_commits: 300,
					merge_base_commit: { sha: "base0000" },
					files,
					html_url: "https://example.test/compare",
				},
				headers: {},
			}),
		});
		registerCommitTools(server, () => octokit);

		const result = await invoke(handlers, "compare_commits", {
			owner: "o",
			repo: "r",
			base: "a",
			head: "b",
		});
		expect(result.content[0].text).toContain("GitHub caps the file list at 300 entries");
	});

	it("get_commit surfaces Octokit errors via wrapTool (isError = true)", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			getCommit: async () => {
				const err = new Error("No commit found for SHA");
				err.status = 404;
				throw err;
			},
		});
		registerCommitTools(server, () => octokit);

		const result = await invoke(handlers, "get_commit", { owner: "o", repo: "r", ref: "nope" });
		expect(result.isError).toBe(true);
		const body = result.content[0].text;
		expect(body).toContain("No commit found for SHA");
		expect(body).toContain("HTTP 404");
	});
});
