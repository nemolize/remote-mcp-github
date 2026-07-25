import { describe, expect, it, vi } from "vitest";

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
	paginate: async (endpoint, params) => (await endpoint(params)).data,
});

const repo = { owner: "o", repo: "r" };

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

		it("reports the no-op case when the source has no labels", async () => {
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () => stubOctokit());

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			expect(result.content[0].text).toContain("has no labels to copy");
		});

		it("creates non-conflicting labels and skips existing ones by default", async () => {
			const createLabel = vi
				.fn()
				.mockResolvedValueOnce({ data: label({ name: "new" }), headers: {} })
				.mockRejectedValueOnce(conflict());
			const updateLabel = vi.fn();
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					updateLabel,
					listLabelsForRepo: async () => ({
						data: [
							{ name: "new", color: "aaaaaa", description: null },
							{ name: "existing", color: "bbbbbb", description: "d" },
						],
						headers: {},
					}),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			expect(updateLabel).not.toHaveBeenCalled();
			const body = result.content[0].text;
			expect(body).toContain("created (1): `new`");
			expect(body).toContain("skipped (1): `existing`");
			expect(body).toContain("updated (0): (none)");
		});

		it("overwrites existing labels when overwrite is true", async () => {
			const createLabel = vi.fn().mockRejectedValue(conflict());
			const updateLabel = vi.fn(async () => ({ data: label(), headers: {} }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					updateLabel,
					listLabelsForRepo: async () => ({
						data: [{ name: "existing", color: "bbbbbb", description: "d" }],
						headers: {},
					}),
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
			expect(result.content[0].text).toContain("updated (1): `existing`");
		});

		it("clears the destination description when the source label has none (overwrite)", async () => {
			const createLabel = vi.fn().mockRejectedValue(conflict());
			const updateLabel = vi.fn(async () => ({ data: label(), headers: {} }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					updateLabel,
					listLabelsForRepo: async () => ({
						data: [{ name: "existing", color: "bbbbbb", description: null }],
						headers: {},
					}),
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
					listLabelsForRepo: async () => ({
						data: [
							{ name: "ok", color: "aaaaaa", description: null },
							{ name: "boom", color: "bbbbbb", description: null },
						],
						headers: {},
					}),
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
			expect(body).toContain("created (1): `ok`");
			expect(body).toContain("stopped before finishing");
			expect(body).toContain("rate limited");
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
					listLabelsForRepo: async () => ({
						data: [
							{ name: "ok", color: "aaaaaa", description: null },
							{ name: "bad", color: "zzzzzz", description: null },
						],
						headers: {},
					}),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			const body = result.content[0].text;
			expect(body).toContain("stopped before finishing");
			expect(body).toContain("skipped (0): (none)");
		});

		it("reports partial progress when the overwrite update fails mid-loop", async () => {
			const createLabel = vi.fn().mockRejectedValue(conflict());
			const updateLabel = vi
				.fn()
				.mockResolvedValueOnce({ data: label({ name: "first" }), headers: {} })
				.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 403 }));
			const { handlers, server } = captureHandlers();
			registerLabelTools(server, () =>
				stubOctokit({
					createLabel,
					updateLabel,
					listLabelsForRepo: async () => ({
						data: [
							{ name: "first", color: "aaaaaa", description: null },
							{ name: "second", color: "bbbbbb", description: null },
						],
						headers: {},
					}),
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
			expect(body).toContain("updated (1): `first`");
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
					listLabelsForRepo: async () => ({
						data: [
							{ name: "ok", color: "aaaaaa", description: null },
							{ name: "boom", color: "bbbbbb", description: null },
						],
						headers: {},
					}),
				}),
			);

			const result = await invoke(handlers, "clone_labels", {
				...repo,
				source_owner: "o",
				source_repo: "src",
			});
			const body = result.content[0].text;
			expect(body.indexOf("stopped before finishing")).toBeLessThan(body.indexOf("created (1)"));
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
