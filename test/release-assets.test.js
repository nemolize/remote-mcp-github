import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_ATTACHMENT_BYTES } from "../src/tools/attachments.js";
import { registerReleaseAssetTools } from "../src/tools/release-assets.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const asset = (overrides = {}) => ({
	id: 77,
	name: "app.zip",
	size: 3,
	content_type: "application/zip",
	state: "uploaded",
	download_count: 2,
	browser_download_url: "https://github.com/o/r/releases/download/v1/app.zip",
	...overrides,
});

const stub = (overrides) => ({
	rest: {
		repos: {
			listReleaseAssets: async () => ({ data: [], headers: {} }),
			uploadReleaseAsset: async () => ({ data: asset(), headers: {} }),
			getReleaseAsset: async () => ({ status: 302, data: null, headers: {} }),
			...overrides,
		},
	},
});

const setup = (overrides) => {
	const { handlers, server } = captureHandlers();
	registerReleaseAssetTools(server, () => stub(overrides));
	return handlers;
};

const upload = (handlers, extra = {}) =>
	invoke(handlers, "upload_release_asset", {
		owner: "o",
		repo: "r",
		release_id: 5,
		name: "app.zip",
		content_base64: "AAEC",
		...extra,
	});

const httpError = (status, data) => Object.assign(new Error("x"), { status, response: { data } });

const auditLines = (spy) =>
	spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[github-audit]"));

afterEach(() => vi.restoreAllMocks());

describe("list_release_assets", () => {
	it("renders ID, name, size, type, state and downloads", async () => {
		const handlers = setup({ listReleaseAssets: async () => ({ data: [asset()], headers: {} }) });
		const result = await invoke(handlers, "list_release_assets", {
			owner: "o",
			repo: "r",
			release_id: 5,
		});
		const body = result.content[0].text;
		expect(body).toContain("# Assets of release 5 (1)");
		expect(body).toContain("`77` **app.zip** — 3 bytes, application/zip, uploaded, 2 downloads");
	});

	it("shows starter assets with their state and a next-page hint", async () => {
		const handlers = setup({
			listReleaseAssets: async () => ({
				data: [asset({ state: "starter" })],
				headers: { link: '<https://api.github.com/x?page=2>; rel="next"' },
			}),
		});
		const result = await invoke(handlers, "list_release_assets", {
			owner: "o",
			repo: "r",
			release_id: 5,
			page: 1,
		});
		const body = result.content[0].text;
		expect(body).toContain("starter");
		expect(body).toContain("page 1, 1 shown; more available");
	});

	it("distinguishes an empty release from an empty later page", async () => {
		const handlers = setup({});
		const first = await invoke(handlers, "list_release_assets", {
			owner: "o",
			repo: "r",
			release_id: 5,
		});
		const later = await invoke(handlers, "list_release_assets", {
			owner: "o",
			repo: "r",
			release_id: 5,
			page: 3,
		});
		expect(first.content[0].text).toBe("(no assets found)");
		expect(later.content[0].text).toBe("(no assets on this page)");
	});

	it("keeps the pagination header when the list exceeds the response cap", async () => {
		const many = Array.from({ length: 100 }, (_, i) => asset({ id: i + 1, name: "n".repeat(200) }));
		const handlers = setup({
			listReleaseAssets: async () => ({
				data: many,
				headers: { link: '<https://api.github.com/x?page=2>; rel="next"' },
			}),
		});
		const result = await invoke(handlers, "list_release_assets", {
			owner: "o",
			repo: "r",
			release_id: 5,
		});
		expect(result.content[0].text.startsWith("# Assets of release 5 (page 1")).toBe(true);
	});
});

describe("upload_release_asset", () => {
	it("sends the exact bytes, content type, name and label with retries disabled", async () => {
		let captured;
		const handlers = setup({
			uploadReleaseAsset: async (params) => {
				captured = params;
				return { data: asset(), headers: {} };
			},
		});
		const result = await upload(handlers, { name: "a b#1.zip", label: "My & label" });
		expect(captured.name).toBe("a b#1.zip");
		expect(captured.label).toBe("My & label");
		expect(captured.release_id).toBe(5);
		expect([...captured.data]).toEqual([0, 1, 2]);
		expect(captured.headers["content-type"]).toBe("application/zip");
		expect(captured.request).toEqual({ retries: 0 });
		expect(result.content[0].text).toContain("`77` **app.zip**");
	});

	it("prefers an explicit content_type, falls back to octet-stream", async () => {
		const seen = [];
		const handlers = setup({
			uploadReleaseAsset: async (p) => {
				seen.push(p.headers["content-type"]);
				return { data: asset(), headers: {} };
			},
		});
		await upload(handlers, { content_type: "text/x-custom" });
		await upload(handlers, { name: "noext" });
		expect(seen).toEqual(["text/x-custom", "application/octet-stream"]);
	});

	it("omits label when not given", async () => {
		let captured;
		const handlers = setup({
			uploadReleaseAsset: async (p) => {
				captured = p;
				return { data: asset(), headers: {} };
			},
		});
		await upload(handlers);
		expect("label" in captured).toBe(false);
	});

	it("rejects invalid base64, empty and oversized content before any request", async () => {
		const calls = vi.fn(async () => ({ data: asset(), headers: {} }));
		const handlers = setup({ uploadReleaseAsset: calls });
		const bad = await upload(handlers, { content_base64: "!!" });
		const empty = await upload(handlers, { content_base64: "=" });
		const huge = await upload(handlers, {
			content_base64: btoa("a".repeat(MAX_ATTACHMENT_BYTES + 1)),
		});
		expect(bad.isError).toBe(true);
		expect(empty.isError).toBe(true);
		expect(huge.isError).toBe(true);
		expect(calls).not.toHaveBeenCalled();
	});

	it("reports a duplicate name on 422 already_exists with one POST and no audit line", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const calls = vi.fn(async () => {
			throw httpError(422, { errors: [{ resource: "ReleaseAsset", code: "already_exists" }] });
		});
		const handlers = setup({ uploadReleaseAsset: calls });
		const result = await upload(handlers);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("already has an asset named `app.zip`");
		expect(result.content[0].text).toContain("starter");
		expect(calls).toHaveBeenCalledTimes(1);
		expect(auditLines(logSpy)).toHaveLength(0);
	});

	it("points at list_release_assets on 502 with one POST and no audit line", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const calls = vi.fn(async () => {
			throw httpError(502, {});
		});
		const handlers = setup({ uploadReleaseAsset: calls });
		const result = await upload(handlers);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("list_release_assets");
		expect(calls).toHaveBeenCalledTimes(1);
		expect(auditLines(logSpy)).toHaveLength(0);
	});

	it("points at list_release_assets on any 5xx, not only 502", async () => {
		const handlers = setup({
			uploadReleaseAsset: async () => {
				throw httpError(503, {});
			},
		});
		const result = await upload(handlers);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("starter");
	});

	it("keeps a backtick-bearing name inside its code span in the messages", async () => {
		const handlers = setup({
			uploadReleaseAsset: async () => {
				throw httpError(422, { errors: [{ code: "already_exists" }] });
			},
		});
		const result = await upload(handlers, { name: "a`b.zip" });
		expect(result.content[0].text).toContain("``a`b.zip``");
	});

	it("does not treat other 422s as a duplicate", async () => {
		const handlers = setup({
			uploadReleaseAsset: async () => {
				throw httpError(422, { errors: [{ code: "invalid" }] });
			},
		});
		const result = await upload(handlers);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).not.toContain("already has an asset");
	});

	it("writes one audit line on success without content or secrets", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const handlers = setup({});
		await upload(handlers);
		const lines = auditLines(logSpy);
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0].replace("[github-audit] ", ""));
		expect(entry).toEqual({
			tool: "upload_release_asset",
			owner: "o",
			repo: "r",
			release_id: 5,
			asset_id: 77,
			filename: "app.zip",
			byte_count: 3,
		});
	});
});

describe("download_release_asset", () => {
	it("returns the Location URL without following the redirect", async () => {
		let captured;
		const handlers = setup({
			getReleaseAsset: async (params) => {
				captured = params;
				return {
					status: 302,
					data: null,
					headers: { location: "https://objects.example/app.zip?sig=1" },
				};
			},
		});
		const result = await invoke(handlers, "download_release_asset", {
			owner: "o",
			repo: "r",
			asset_id: 77,
		});
		expect(captured.headers.accept).toBe("application/octet-stream");
		expect(captured.request).toEqual({ redirect: "manual", parseSuccessResponseBody: false });
		expect(result.content[0].text).toContain("https://objects.example/app.zip?sig=1");
		expect(result.isError).toBeUndefined();
	});

	it("cancels a direct 200 body stream without reading it and reports no URL", async () => {
		const stream = new Response("file bytes").body;
		const cancel = vi.spyOn(stream, "cancel");
		const handlers = setup({
			getReleaseAsset: async () => ({ status: 200, data: stream, headers: {} }),
		});
		const result = await invoke(handlers, "download_release_asset", {
			owner: "o",
			repo: "r",
			asset_id: 77,
		});
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(stream.locked).toBe(false);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("HTTP 200");
	});

	it("errors explicitly when a redirect carries no Location", async () => {
		const handlers = setup({});
		const result = await invoke(handlers, "download_release_asset", {
			owner: "o",
			repo: "r",
			asset_id: 77,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("No download URL returned");
	});

	it("emits no audit line", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const handlers = setup({
			getReleaseAsset: async () => ({
				status: 302,
				data: null,
				headers: { location: "https://x/y" },
			}),
		});
		await invoke(handlers, "download_release_asset", { owner: "o", repo: "r", asset_id: 1 });
		expect(auditLines(logSpy)).toHaveLength(0);
	});
});
