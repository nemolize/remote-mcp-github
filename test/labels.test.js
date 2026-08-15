import { describe, expect, it, vi } from "vitest";

import { MAX_RESPONSE_CHARS } from "../src/mcp/response.js";
import { registerLabelTools } from "../src/tools/labels.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const label = (overrides = {}) => ({
	name: "bug",
	color: "d73a4a",
	description: "Something isn't working",
	...overrides,
});

const stubOctokit = (overrides = {}) => ({
	rest: {
		issues: {
			createLabel: async () => ({ data: label(), headers: {} }),
			updateLabel: async () => ({ data: label(), headers: {} }),
			deleteLabel: async () => ({ data: {}, headers: {} }),
			listLabelsForRepo: async () => ({ data: [], headers: {} }),
			...overrides,
		},
	},
	// clone_labels walks pages via paginate.iterator so it can observe every
	// response's rate-limit headers, not just the last mutation's.
	paginate: Object.assign(async (endpoint, params) => (await endpoint(params)).data, {
		iterator: (endpoint, params) => ({
			async *[Symbol.asyncIterator]() {
				yield await endpoint(params);
			},
		}),
	}),
});

const repo = { owner: "o", repo: "r" };

// clone_labels paginates both repos through the same endpoint, so a clone stub
// must answer per repo: `src` is the source, `r` the destination.
const cloneLabels = (source, destination = []) => ({
	listLabelsForRepo: async ({ repo: name }) => ({
		data: name === "src" ? source : destination,
		headers: {},
	}),
});

describe("registerLabelTools", () => {
	describe("create_label", () => {
		it("renders the created label", async () => {
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () => stubOctokit());

			const result = await invoke(handlers, "create_label", { ...repo, name: "bug" });
			const body = result.content[0].text;
			expect(body).toContain("# Label created");
			expect(body).toContain("**bug** (#d73a4a) — Something isn't working");
			expect(result.isError).toBeUndefined();
		});

		it("normalizes a leading `#` and upper-case in the colour before the API call", async () => {
			const createLabel = vi.fn(async () => ({ data: label(), headers: {} }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () => stubOctokit({ createLabel }));

			await invoke(handlers, "create_label", { ...repo, name: "bug", color: "#F29513" });
			expect(createLabel).toHaveBeenCalledWith(
				expect.objectContaining({ color: "f29513", name: "bug" }),
			);
		});

		it("omits colour from the request when not provided", async () => {
			const createLabel = vi.fn(async () => ({ data: label(), headers: {} }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () => stubOctokit({ createLabel }));

			await invoke(handlers, "create_label", { ...repo, name: "bug" });
			const arg = createLabel.mock.calls[0][0];
			expect(arg).not.toHaveProperty("color");
		});
	});

	describe("update_label", () => {
		it("renames and re-renders the label", async () => {
			const updateLabel = vi.fn(async () => ({
				data: label({ name: "defect" }),
				headers: {},
			}));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () => stubOctokit({ updateLabel }));

			const result = await invoke(handlers, "update_label", {
				...repo,
				name: "bug",
				new_name: "defect",
			});
			expect(updateLabel).toHaveBeenCalledWith(
				expect.objectContaining({ name: "bug", new_name: "defect" }),
			);
			expect(result.content[0].text).toContain("# Label updated");
			expect(result.content[0].text).toContain("**defect**");
		});

		it("returns an error when no field to change is given", async () => {
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () => stubOctokit());

			const result = await invoke(handlers, "update_label", { ...repo, name: "bug" });
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("at least one of");
		});
	});

	describe("delete_label", () => {
		it("confirms the deletion", async () => {
			const deleteLabel = vi.fn(async () => ({ data: {}, headers: {} }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () => stubOctokit({ deleteLabel }));

			const result = await invoke(handlers, "delete_label", { ...repo, name: "bug" });
			expect(deleteLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "bug" }));
			expect(result.content[0].text).toContain("removed `bug` from o/r");
		});
	});

	describe("clone_labels", () => {
		// GitHub's name-collision 422 carries an `already_exists` error code; other
		// 422s (validation, abuse) do not, and the tool must not treat them as a skip.
		const conflict = () =>
			Object.assign(new Error("Validation Failed"), {
				status: 422,
				response: {
					data: { errors: [{ resource: "Label", code: "already_exists", field: "name" }] },
				},
			});
		const otherUnprocessable = () =>
			Object.assign(new Error("Validation Failed"), {
				status: 422,
				response: { data: { errors: [{ resource: "Label", code: "invalid", field: "color" }] } },
			});

		it("reports the no-op case without reading the destination", async () => {
			const listLabelsForRepo = vi.fn(async ({ repo: name }) => {
				if (name !== "src") throw new Error(`destination should not be read (got ${name})`);
				return { data: [], headers: {} };
			});
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () => stubOctokit({ listLabelsForRepo }));

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			expect(result.content[0].text).toContain("has no labels to copy");
			// Nothing to diff against, so the destination page is a subrequest spent
			// for nothing — and with no write, there is no audit line to emit.
			expect(listLabelsForRepo).toHaveBeenCalledTimes(1);
			expect(logSpy.mock.calls.flat().join("\n")).not.toContain("github-audit");
			logSpy.mockRestore();
		});

		it("creates non-conflicting labels and skips existing ones by default", async () => {
			const createLabel = vi.fn(async () => ({ data: label({ name: "new" }), headers: {} }));
			const updateLabel = vi.fn();
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					updateLabel,
					...cloneLabels(
						[
							{ name: "new", color: "aaaaaa", description: null },
							{ name: "existing", color: "bbbbbb", description: "d" },
						],
						[{ name: "existing", color: "cccccc", description: "old" }],
					),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			expect(updateLabel).not.toHaveBeenCalled();
			// The label already in the destination costs no subrequest at all — the
			// diff decides it, so createLabel is never attempted for it.
			expect(createLabel).toHaveBeenCalledTimes(1);
			expect(createLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "new" }));
			const body = result.content[0].text;
			expect(body).toContain("created: 1");
			expect(body).toContain("created: `new`");
			expect(body).toContain("skipped: 1");
			expect(body).toContain("skipped: `existing`");
			expect(body).toContain("updated: 0");
		});

		it("matches destination names case-insensitively, as GitHub does", async () => {
			const createLabel = vi.fn();
			const updateLabel = vi.fn(async () => ({ data: label(), headers: {} }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					updateLabel,
					...cloneLabels(
						[{ name: "Bug", color: "aaaaaa", description: "d" }],
						[{ name: "bug", color: "bbbbbb", description: "d" }],
					),
				}),
			);

			await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
				overwrite: true,
			});
			// GitHub collides `Bug` with `bug`, so a create would 422; and the update
			// must address the destination's own spelling, not the source's.
			expect(createLabel).not.toHaveBeenCalled();
			expect(updateLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "bug" }));
		});

		it("skips an already-matching destination label even with overwrite", async () => {
			const createLabel = vi.fn();
			const updateLabel = vi.fn();
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					updateLabel,
					...cloneLabels(
						[{ name: "same", color: "aaaaaa", description: "d" }],
						[{ name: "same", color: "aaaaaa", description: "d" }],
					),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
				overwrite: true,
			});
			expect(updateLabel).not.toHaveBeenCalled();
			expect(createLabel).not.toHaveBeenCalled();
			expect(result.content[0].text).toContain("skipped: `same`");
		});

		it("treats a null source description as equal to an empty destination one", async () => {
			const createLabel = vi.fn();
			const updateLabel = vi.fn();
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					updateLabel,
					...cloneLabels(
						[{ name: "same", color: "aaaaaa", description: null }],
						[{ name: "same", color: "aaaaaa", description: "" }],
					),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
				overwrite: true,
			});
			// An update here would send description: "" and change nothing, spending a
			// subrequest to write the state the destination already holds. Watching
			// updateLabel alone would pass on a stray create, so pin both to zero.
			expect(updateLabel).not.toHaveBeenCalled();
			expect(createLabel).not.toHaveBeenCalled();
			expect(result.content[0].text).toContain("skipped: `same`");
		});

		it("still skips on a race-created label when overwrite is off", async () => {
			const createLabel = vi.fn().mockRejectedValue(conflict());
			const updateLabel = vi.fn();
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					updateLabel,
					...cloneLabels([{ name: "racy", color: "aaaaaa", description: null }]),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			// Absent from the prefetch but present by the time of the write: the
			// already_exists guard has to stay for exactly this window.
			expect(updateLabel).not.toHaveBeenCalled();
			expect(result.content[0].text).toContain("skipped: `racy`");
		});

		it("overwrites a race-created label when overwrite is on", async () => {
			const createLabel = vi.fn().mockRejectedValue(conflict());
			const updateLabel = vi.fn(async () => ({ data: label(), headers: {} }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					updateLabel,
					...cloneLabels([{ name: "racy", color: "aaaaaa", description: "d" }]),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
				overwrite: true,
			});
			expect(updateLabel).toHaveBeenCalledWith(
				expect.objectContaining({ name: "racy", color: "aaaaaa", description: "d" }),
			);
			expect(result.content[0].text).toContain("updated: `racy`");
		});

		it("creates a label the prefetch saw but that vanished before the update", async () => {
			const createLabel = vi.fn(async () => ({ data: label({ name: "gone" }), headers: {} }));
			const updateLabel = vi
				.fn()
				.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					updateLabel,
					...cloneLabels(
						[{ name: "gone", color: "aaaaaa", description: "d" }],
						[{ name: "gone", color: "bbbbbb", description: "stale" }],
					),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
				overwrite: true,
			});
			// Deleted between the read and the write: the snapshot is stale, not the
			// request, so the label should still land rather than abort the clone.
			expect(createLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "gone" }));
			// Exactly one hop each way — a second update or create would mean the
			// label got counted twice or the swap looped.
			expect(createLabel).toHaveBeenCalledTimes(1);
			expect(updateLabel).toHaveBeenCalledTimes(1);
			const body = result.content[0].text;
			expect(body).toContain("- created: 1");
			expect(body).toContain("- updated: 0");
			expect(body).toContain("- skipped: 0");
			expect(body).toContain("created: `gone`");
			expect(body).not.toContain("stopped before finishing");
		});

		it("stops after one hop when the label keeps flipping underneath", async () => {
			// Deleted, re-created, deleted again: the swap must abort rather than
			// bounce 404 ↔ already_exists for as long as the racer keeps going.
			const createLabel = vi.fn().mockRejectedValue(conflict());
			const updateLabel = vi
				.fn()
				.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					updateLabel,
					...cloneLabels(
						[{ name: "flip", color: "aaaaaa", description: "d" }],
						[{ name: "flip", color: "bbbbbb", description: "stale" }],
					),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
				overwrite: true,
			});
			expect(createLabel).toHaveBeenCalledTimes(1);
			expect(updateLabel).toHaveBeenCalledTimes(2);
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("Not Found");
		});

		it("reports the rate limit from a tolerated failure, not just a fatal one", async () => {
			// An already_exists collision does not stop the loop, but it is still the
			// newest quota reading — the last successful page's is older.
			const createLabel = vi.fn().mockRejectedValue(
				Object.assign(new Error("Validation Failed"), {
					status: 422,
					response: {
						data: { errors: [{ resource: "Label", code: "already_exists", field: "name" }] },
						headers: { "x-ratelimit-remaining": "7", "x-ratelimit-limit": "5000" },
					},
				}),
			);
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					listLabelsForRepo: async ({ repo: name }) => ({
						data: name === "src" ? [{ name: "racy", color: "aaaaaa", description: null }] : [],
						headers: { "x-ratelimit-remaining": "99", "x-ratelimit-limit": "5000" },
					}),
				}),
			);

			await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			expect(logSpy.mock.calls.flat().join("\n")).toContain("[github-ratelimit] 7/5000");
			logSpy.mockRestore();
		});

		it("keeps the observed quota when the failing response carries none", async () => {
			// An edge 5xx has headers but no budget; letting that bag win would wipe
			// out the reading the successful page already gave us.
			const createLabel = vi.fn().mockRejectedValue(
				Object.assign(new Error("Bad Gateway"), {
					status: 502,
					response: { headers: { "content-type": "text/html" } },
				}),
			);
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					listLabelsForRepo: async ({ repo: name }) => ({
						data: name === "src" ? [{ name: "a", color: "aaaaaa", description: null }] : [],
						headers: { "x-ratelimit-remaining": "55", "x-ratelimit-limit": "5000" },
					}),
				}),
			);

			await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			expect(logSpy.mock.calls.flat().join("\n")).toContain("[github-ratelimit] 55/5000");
			logSpy.mockRestore();
		});

		it("reports the rate limit from a read when no write happened", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					listLabelsForRepo: async ({ repo: name }) => ({
						data: [{ name: "same", color: "aaaaaa", description: "d" }],
						headers:
							name === "src" ? {} : { "x-ratelimit-remaining": "42", "x-ratelimit-limit": "5000" },
					}),
				}),
			);

			await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			// An all-skipped run performs no mutation, but the reads still consumed
			// quota — reporting only a successful write's headers would say nothing.
			const logged = logSpy.mock.calls.flat().join("\n");
			expect(logged).toContain("[github-ratelimit] 42/5000");
			expect(logged).not.toContain("github-audit");
			logSpy.mockRestore();
		});

		it("reports the rate limit from the response that caused the abort", async () => {
			const createLabel = vi
				.fn()
				.mockResolvedValueOnce({
					data: label({ name: "ok" }),
					headers: { "x-ratelimit-remaining": "9", "x-ratelimit-limit": "5000" },
				})
				.mockRejectedValueOnce(
					Object.assign(new Error("rate limited"), {
						status: 403,
						response: { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "5000" } },
					}),
				);
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					...cloneLabels([
						{ name: "ok", color: "aaaaaa", description: null },
						{ name: "boom", color: "bbbbbb", description: null },
					]),
				}),
			);

			await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			// The failing request carries the budget that caused the failure; the last
			// success's headers would report a quota that no longer exists.
			expect(logSpy.mock.calls.flat().join("\n")).toContain("[github-ratelimit] 0/5000");
			logSpy.mockRestore();
		});

		it("propagates a non-conflict error from the destination read", async () => {
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					listLabelsForRepo: async ({ repo: name }) => {
						if (name === "src") {
							return { data: [{ name: "a", color: "aaaaaa", description: null }], headers: {} };
						}
						throw Object.assign(new Error("boom"), { status: 500 });
					},
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			expect(result.isError).toBe(true);
		});

		it("reports the rate limit when a read is what failed", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					listLabelsForRepo: async () => {
						throw Object.assign(new Error("rate limited"), {
							status: 403,
							response: {
								headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "5000" },
							},
						});
					},
				}),
			);

			await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			// A failed read exits through wrapTool, skipping the logRateLimit at the
			// end of the handler — so a rate-limited prefetch would report nothing.
			expect(logSpy.mock.calls.flat().join("\n")).toContain("[github-ratelimit] 0/5000");
			logSpy.mockRestore();
		});

		it("overwrites existing labels when overwrite is true", async () => {
			const createLabel = vi.fn();
			const updateLabel = vi.fn(async () => ({ data: label(), headers: {} }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					updateLabel,
					...cloneLabels(
						[{ name: "existing", color: "bbbbbb", description: "d" }],
						[{ name: "existing", color: "cccccc", description: "old" }],
					),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
				overwrite: true,
			});
			expect(updateLabel).toHaveBeenCalledWith(
				expect.objectContaining({ name: "existing", color: "bbbbbb", description: "d" }),
			);
			expect(result.content[0].text).toContain("updated: `existing`");
		});

		it("clears the destination description when the source label has none (overwrite)", async () => {
			const createLabel = vi.fn();
			const updateLabel = vi.fn(async () => ({ data: label(), headers: {} }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					updateLabel,
					...cloneLabels(
						[{ name: "existing", color: "bbbbbb", description: null }],
						[{ name: "existing", color: "bbbbbb", description: "stale" }],
					),
				}),
			);

			await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
				overwrite: true,
			});
			// A null-description source must send description: "" so GitHub clears the
			// destination's stale description (undefined would leave it unchanged).
			expect(updateLabel).toHaveBeenCalledWith(expect.objectContaining({ description: "" }));
		});

		it("reports partial progress and does not throw on a mid-loop non-conflict error", async () => {
			const createLabel = vi
				.fn()
				.mockResolvedValueOnce({ data: label({ name: "ok" }), headers: {} })
				.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 403 }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					...cloneLabels([
						{ name: "ok", color: "aaaaaa", description: null },
						{ name: "boom", color: "bbbbbb", description: null },
					]),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			// The first label landed before the 403 aborted the loop; the tool must
			// surface that partial progress instead of discarding it via a throw.
			expect(result.isError).toBeUndefined();
			const body = result.content[0].text;
			expect(body).toContain("created: `ok`");
			expect(body).toContain("stopped before finishing");
			expect(body).toContain("rate limited");
		});

		it("returns an error when the interruption applied nothing at all", async () => {
			const createLabel = vi
				.fn()
				.mockRejectedValue(Object.assign(new Error("rate limited"), { status: 403 }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					...cloneLabels([{ name: "boom", color: "aaaaaa", description: null }]),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			// Nothing landed, so this is a failed clone rather than a partial one — a
			// success-shaped result would read as a completed copy to the caller.
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("rate limited");
		});

		it("keeps the counts ahead of the unbounded name lists so truncation drops names first", async () => {
			const createLabel = vi.fn(async () => ({ data: label(), headers: {} }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					...cloneLabels([{ name: "a", color: "aaaaaa", description: null }]),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			const body = result.content[0].text;
			expect(body.indexOf("- skipped: 0")).toBeLessThan(body.indexOf("created: `a`"));
		});

		it("keeps the counts when the name lists push the response past the cap", async () => {
			// Ordering alone passes under the cap even with `truncate` removed; only a
			// response that actually exceeds MAX_RESPONSE_CHARS exercises the cut.
			const many = Array.from({ length: 400 }, (_, i) => ({
				name: `label-with-a-fairly-long-name-${i}`,
				color: "aaaaaa",
				description: null,
			}));
			const createLabel = vi.fn(async () => ({ data: label(), headers: {} }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () => stubOctokit({ createLabel, ...cloneLabels(many) }));

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			const body = result.content[0].text;
			expect(body.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
			expect(body).toContain("truncated");
			expect(body).toContain("- created: 400");
			expect(body).toContain("- skipped: 0");
			// The tail of the name list is what the cut is allowed to take.
			expect(body).not.toContain("label-with-a-fairly-long-name-399");
		});

		it("keeps the counts when a long abort message precedes them", async () => {
			// The warning is rendered ahead of the counts, so an unbounded error body
			// would push them past the cut — the message is capped at its source.
			const createLabel = vi
				.fn()
				.mockResolvedValueOnce({ data: label({ name: "ok" }), headers: {} })
				.mockRejectedValueOnce(Object.assign(new Error("x".repeat(20000)), { status: 500 }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					...cloneLabels([
						{ name: "ok", color: "aaaaaa", description: null },
						{ name: "boom", color: "bbbbbb", description: null },
					]),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			const body = result.content[0].text;
			expect(body).toContain("stopped before finishing");
			expect(body).toContain("- created: 1");
			expect(body).toContain("- skipped: 0");
		});

		it("aborts on a 422 that is not a name collision instead of counting it as skipped", async () => {
			const createLabel = vi
				.fn()
				.mockResolvedValueOnce({ data: label({ name: "ok" }), headers: {} })
				.mockRejectedValueOnce(otherUnprocessable());
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					...cloneLabels([
						{ name: "ok", color: "aaaaaa", description: null },
						{ name: "bad", color: "zzzzzz", description: null },
					]),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			const body = result.content[0].text;
			expect(body).toContain("stopped before finishing");
			expect(body).toContain("skipped: 0");
		});

		it("reports partial progress when the overwrite update fails mid-loop", async () => {
			const createLabel = vi.fn();
			const updateLabel = vi
				.fn()
				.mockResolvedValueOnce({ data: label({ name: "first" }), headers: {} })
				.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 403 }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					updateLabel,
					...cloneLabels(
						[
							{ name: "first", color: "aaaaaa", description: null },
							{ name: "second", color: "bbbbbb", description: null },
						],
						[
							{ name: "first", color: "111111", description: "stale" },
							{ name: "second", color: "222222", description: "stale" },
						],
					),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
				overwrite: true,
			});
			// A failure on the overwrite path must abort like a failed create — surfacing
			// what already landed rather than escaping as an unhandled throw.
			expect(result.isError).toBeUndefined();
			const body = result.content[0].text;
			expect(body).toContain("updated: `first`");
			expect(body).toContain("stopped before finishing");
			expect(body).toContain("rate limited");
		});

		it("puts the interruption warning before the per-label lists so truncation cannot drop it", async () => {
			const createLabel = vi
				.fn()
				.mockResolvedValueOnce({ data: label({ name: "ok" }), headers: {} })
				.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 403 }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					...cloneLabels([
						{ name: "ok", color: "aaaaaa", description: null },
						{ name: "boom", color: "bbbbbb", description: null },
					]),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			const body = result.content[0].text;
			expect(body.indexOf("stopped before finishing")).toBeLessThan(body.indexOf("created: 1"));
		});

		it("propagates a non-conflict error from the source read", async () => {
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					listLabelsForRepo: async () => {
						throw Object.assign(new Error("boom"), { status: 500 });
					},
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			expect(result.isError).toBe(true);
		});
	});
});
