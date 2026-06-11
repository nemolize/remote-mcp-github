import { describe, expect, it } from "vitest";

import { registerReleaseTools } from "../src/tools/releases.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const stubOctokit = (overrides) => ({
	rest: {
		repos: {
			listReleases: async () => ({ data: [], headers: {} }),
			getRelease: async () => ({ data: {}, headers: {} }),
			getReleaseByTag: async () => ({ data: {}, headers: {} }),
			getLatestRelease: async () => ({ data: {}, headers: {} }),
			listTags: async () => ({ data: [], headers: {} }),
			...overrides,
		},
	},
});

const sampleRelease = (overrides = {}) => ({
	id: 4242,
	tag_name: "v1.2.0",
	name: "Spring release",
	draft: false,
	prerelease: false,
	target_commitish: "main",
	published_at: "2026-06-01T00:00:00Z",
	created_at: "2026-05-30T00:00:00Z",
	author: { login: "alice" },
	assets: [],
	html_url: "https://github.com/o/r/releases/tag/v1.2.0",
	body: "Highlights of the release.",
	...overrides,
});

describe("registerReleaseTools", () => {
	it("list_releases renders ID, name, tag, state, date, author", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			listReleases: async () => ({ data: [sampleRelease()], headers: {} }),
		});
		registerReleaseTools(server, () => octokit);

		const result = await invoke(handlers, "list_releases", { owner: "o", repo: "r" });
		const body = result.content[0].text;
		expect(body).toContain("# Releases (1)");
		expect(body).toContain(
			"`4242` **Spring release** (`v1.2.0`) — published, 2026-06-01T00:00:00Z, by alice",
		);
		expect(result.isError).toBeUndefined();
	});

	it("list_releases labels drafts and prereleases, falling back to the tag for an unnamed release", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			listReleases: async () => ({
				data: [
					sampleRelease({ id: 1, draft: true, name: null, published_at: null }),
					sampleRelease({ id: 2, prerelease: true, tag_name: "v2.0.0-rc.1" }),
					sampleRelease({ id: 3, draft: true, prerelease: true, published_at: null }),
				],
				headers: {},
			}),
		});
		registerReleaseTools(server, () => octokit);

		const result = await invoke(handlers, "list_releases", { owner: "o", repo: "r" });
		const body = result.content[0].text;
		expect(body).toContain("`1` **v1.2.0** (`v1.2.0`) — draft, unpublished, by alice");
		expect(body).toContain("`2` **Spring release** (`v2.0.0-rc.1`) — prerelease");
		expect(body).toContain("`3` **Spring release** (`v1.2.0`) — draft prerelease, unpublished");
	});

	it("list_releases shows a pagination hint when a next link is present", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			listReleases: async () => ({
				data: [sampleRelease()],
				headers: { link: '<https://api.github.com/...?page=2>; rel="next"' },
			}),
		});
		registerReleaseTools(server, () => octokit);

		const result = await invoke(handlers, "list_releases", { owner: "o", repo: "r", page: 1 });
		expect(result.content[0].text).toContain("page 1, 1 shown; more available");
	});

	it("list_releases reports an empty result", async () => {
		const { handlers, server } = captureHandlers();
		registerReleaseTools(server, () => stubOctokit({}));

		const result = await invoke(handlers, "list_releases", { owner: "o", repo: "r" });
		expect(result.content[0].text).toBe("(no releases found)");
	});

	it("get_release looks up by release_id and renders detail + notes", async () => {
		const { handlers, server } = captureHandlers();
		let captured;
		const octokit = stubOctokit({
			getRelease: async (params) => {
				captured = params;
				return { data: sampleRelease(), headers: {} };
			},
		});
		registerReleaseTools(server, () => octokit);

		const result = await invoke(handlers, "get_release", {
			owner: "o",
			repo: "r",
			release_id: 4242,
		});
		expect(captured).toMatchObject({ owner: "o", repo: "r", release_id: 4242 });
		const body = result.content[0].text;
		expect(body).toContain("# Release `4242` in o/r");
		expect(body).toContain("> Spring release — published");
		expect(body).toContain("- tag: `v1.2.0` (target `main`)");
		expect(body).toContain("- author: alice");
		expect(body).toContain("- assets: 0");
		expect(body).toContain("## Notes\n\nHighlights of the release.");
	});

	it("get_release looks up by tag when tag is given", async () => {
		const { handlers, server } = captureHandlers();
		let captured;
		const octokit = stubOctokit({
			getReleaseByTag: async (params) => {
				captured = params;
				return { data: sampleRelease(), headers: {} };
			},
		});
		registerReleaseTools(server, () => octokit);

		await invoke(handlers, "get_release", { owner: "o", repo: "r", tag: "v1.2.0" });
		expect(captured).toMatchObject({ owner: "o", repo: "r", tag: "v1.2.0" });
	});

	it("get_release falls back to the latest release when neither release_id nor tag is given", async () => {
		const { handlers, server } = captureHandlers();
		let latestCalled = false;
		const octokit = stubOctokit({
			getLatestRelease: async () => {
				latestCalled = true;
				return { data: sampleRelease(), headers: {} };
			},
		});
		registerReleaseTools(server, () => octokit);

		await invoke(handlers, "get_release", { owner: "o", repo: "r" });
		expect(latestCalled).toBe(true);
	});

	it("get_release rejects release_id and tag together", async () => {
		const { handlers, server } = captureHandlers();
		registerReleaseTools(server, () => stubOctokit({}));

		const result = await invoke(handlers, "get_release", {
			owner: "o",
			repo: "r",
			release_id: 1,
			tag: "v1.0.0",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("either `release_id` or `tag`, not both");
	});

	it("get_release omits the Notes section when the body is empty", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			getRelease: async () => ({ data: sampleRelease({ body: null }), headers: {} }),
		});
		registerReleaseTools(server, () => octokit);

		const result = await invoke(handlers, "get_release", {
			owner: "o",
			repo: "r",
			release_id: 4242,
		});
		expect(result.content[0].text).not.toContain("## Notes");
	});

	it("list_tags renders tag name and short SHA", async () => {
		const { handlers, server } = captureHandlers();
		const octokit = stubOctokit({
			listTags: async () => ({
				data: [
					{ name: "v1.2.0", commit: { sha: "abcdef1234567890" } },
					{ name: "v1.1.0", commit: { sha: "feedface00001111" } },
				],
				headers: {},
			}),
		});
		registerReleaseTools(server, () => octokit);

		const result = await invoke(handlers, "list_tags", { owner: "o", repo: "r" });
		const body = result.content[0].text;
		expect(body).toContain("# Tags (2)");
		expect(body).toContain("- `v1.2.0` @ `abcdef1`");
		expect(body).toContain("- `v1.1.0` @ `feedfac`");
		expect(result.isError).toBeUndefined();
	});

	it("list_tags reports an empty result", async () => {
		const { handlers, server } = captureHandlers();
		registerReleaseTools(server, () => stubOctokit({}));

		const result = await invoke(handlers, "list_tags", { owner: "o", repo: "r" });
		expect(result.content[0].text).toBe("(no tags found)");
	});
});
