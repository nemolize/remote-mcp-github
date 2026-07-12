import { describe, expect, it } from "vitest";

import { registerSecurityTools } from "../src/tools/security.js";
import { captureHandlers, invoke } from "./_helpers/tools.js";

const stubOctokit = (overrides) => ({
	rest: {
		secretScanning: {
			listAlertsForRepo: async () => ({ data: [], headers: {} }),
			getAlert: async () => ({ data: sampleSecretAlert(), headers: {} }),
		},
		codeScanning: {
			listAlertsForRepo: async () => ({ data: [], headers: {} }),
			getAlert: async () => ({ data: sampleCodeAlert(), headers: {} }),
		},
		dependabot: {
			listAlertsForRepo: async () => ({ data: [], headers: {} }),
			getAlert: async () => ({ data: sampleDependabotAlert(), headers: {} }),
		},
		...overrides,
	},
});

const withRest = (rest) => ({ rest: { ...stubOctokit().rest, ...rest } });

const sampleSecretAlert = (overrides = {}) => ({
	number: 7,
	state: "open",
	resolution: null,
	secret_type: "github_personal_access_token",
	secret_type_display_name: "GitHub Personal Access Token",
	// The raw secret must never appear in rendered output — included here to
	// prove the renderer drops it.
	secret: "ghp_THIS_MUST_NOT_LEAK",
	created_at: "2026-06-01T00:00:00Z",
	updated_at: "2026-06-02T00:00:00Z",
	...overrides,
});

const sampleCodeAlert = (overrides = {}) => ({
	number: 12,
	state: "open",
	rule: {
		id: "js/sql-injection",
		name: "SQL injection",
		severity: "error",
		security_severity_level: "high",
	},
	tool: { name: "CodeQL" },
	most_recent_instance: {
		location: { path: "src/db.ts", start_line: 42 },
	},
	...overrides,
});

const sampleDependabotAlert = (overrides = {}) => ({
	number: 3,
	state: "open",
	dependency: { package: { ecosystem: "npm", name: "lodash" } },
	security_advisory: {
		ghsa_id: "GHSA-xxxx-yyyy-zzzz",
		severity: "high",
		summary: "Prototype pollution in lodash",
	},
	...overrides,
});

describe("registerSecurityTools", () => {
	describe("get_secret_scanning_alert", () => {
		it("requests the hidden-secret response and never renders a raw secret", async () => {
			const { handlers, server } = captureHandlers();
			let receivedParams;
			const octokit = withRest({
				secretScanning: {
					getAlert: async (params) => {
						receivedParams = params;
						return { data: sampleSecretAlert(), headers: {} };
					},
				},
			});
			registerSecurityTools(server, () => octokit);

			const result = await invoke(handlers, "get_secret_scanning_alert", {
				owner: "o",
				repo: "r",
				alert_number: 7,
			});
			const body = result.content[0].text;
			expect(receivedParams).toMatchObject({
				owner: "o",
				repo: "r",
				alert_number: 7,
				hide_secret: true,
			});
			expect(body).toContain("`#7` **open** — GitHub Personal Access Token");
			expect(body).toContain("Created: 2026-06-01T00:00:00Z");
			expect(body).not.toContain("ghp_THIS_MUST_NOT_LEAK");
		});
	});

	describe("get_code_scanning_alert", () => {
		it("renders rule, severity, tool, and location", async () => {
			const { handlers, server } = captureHandlers();
			registerSecurityTools(server, () => withRest({}));

			const result = await invoke(handlers, "get_code_scanning_alert", {
				owner: "o",
				repo: "r",
				alert_number: 12,
			});
			expect(result.content[0].text).toContain(
				"`#12` **open** — `js/sql-injection` (high), CodeQL\n\nLocation: src/db.ts:42",
			);
		});
	});

	describe("get_dependabot_alert", () => {
		it("renders package and advisory detail", async () => {
			const { handlers, server } = captureHandlers();
			registerSecurityTools(server, () => withRest({}));

			const result = await invoke(handlers, "get_dependabot_alert", {
				owner: "o",
				repo: "r",
				alert_number: 3,
			});
			expect(result.content[0].text).toContain(
				"`#3` **open** — npm:lodash (high)\n\nAdvisory: `GHSA-xxxx-yyyy-zzzz` — Prototype pollution in lodash",
			);
		});
	});

	describe("list_secret_scanning_alerts", () => {
		it("renders number, state, secret type, and date — and never the raw secret", async () => {
			const { handlers, server } = captureHandlers();
			const octokit = withRest({
				secretScanning: {
					listAlertsForRepo: async () => ({ data: [sampleSecretAlert()], headers: {} }),
				},
			});
			registerSecurityTools(server, () => octokit);

			const result = await invoke(handlers, "list_secret_scanning_alerts", {
				owner: "o",
				repo: "r",
			});
			const body = result.content[0].text;
			expect(body).toContain("# Secret-scanning alerts (1)");
			expect(body).toContain("`#7` **open** — GitHub Personal Access Token, 2026-06-02T00:00:00Z");
			// The critical guarantee: the raw secret value is never rendered.
			expect(body).not.toContain("ghp_THIS_MUST_NOT_LEAK");
			expect(result.isError).toBeUndefined();
		});

		it("passes hide_secret: true so GitHub omits the raw secret from the response", async () => {
			const { handlers, server } = captureHandlers();
			let receivedParams;
			const octokit = withRest({
				secretScanning: {
					listAlertsForRepo: async (params) => {
						receivedParams = params;
						return { data: [], headers: {} };
					},
				},
			});
			registerSecurityTools(server, () => octokit);

			await invoke(handlers, "list_secret_scanning_alerts", { owner: "o", repo: "r" });
			expect(receivedParams.hide_secret).toBe(true);
		});

		it("never leaks the raw secret even when the display name is absent (fallback path)", async () => {
			const { handlers, server } = captureHandlers();
			const octokit = withRest({
				secretScanning: {
					listAlertsForRepo: async () => ({
						// Drop secret_type_display_name to force the `?? secret_type` fallback,
						// which reads adjacent fields on the same alert object.
						data: [sampleSecretAlert({ secret_type_display_name: undefined })],
						headers: {},
					}),
				},
			});
			registerSecurityTools(server, () => octokit);

			const result = await invoke(handlers, "list_secret_scanning_alerts", {
				owner: "o",
				repo: "r",
			});
			const body = result.content[0].text;
			// Falls back to the raw secret_type identifier, still never the secret value.
			expect(body).toContain("github_personal_access_token");
			expect(body).not.toContain("ghp_THIS_MUST_NOT_LEAK");
		});

		it("shows the resolution for a resolved alert", async () => {
			const { handlers, server } = captureHandlers();
			const octokit = withRest({
				secretScanning: {
					listAlertsForRepo: async () => ({
						data: [sampleSecretAlert({ state: "resolved", resolution: "revoked" })],
						headers: {},
					}),
				},
			});
			registerSecurityTools(server, () => octokit);

			const result = await invoke(handlers, "list_secret_scanning_alerts", {
				owner: "o",
				repo: "r",
			});
			expect(result.content[0].text).toContain("`#7` **resolved** (revoked) —");
		});

		it("reports an empty result", async () => {
			const { handlers, server } = captureHandlers();
			registerSecurityTools(server, () => withRest({}));
			const result = await invoke(handlers, "list_secret_scanning_alerts", {
				owner: "o",
				repo: "r",
			});
			expect(result.content[0].text).toBe("(no secret-scanning alerts found)");
		});

		it("surfaces a 403 via wrapTool rather than throwing", async () => {
			const { handlers, server } = captureHandlers();
			const octokit = withRest({
				secretScanning: {
					listAlertsForRepo: async () => {
						throw Object.assign(new Error("Resource not accessible"), { status: 403 });
					},
				},
			});
			registerSecurityTools(server, () => octokit);
			const result = await invoke(handlers, "list_secret_scanning_alerts", {
				owner: "o",
				repo: "r",
			});
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("(HTTP 403)");
		});
	});

	describe("list_code_scanning_alerts", () => {
		it("renders number, state, rule, security severity, tool, and location", async () => {
			const { handlers, server } = captureHandlers();
			const octokit = withRest({
				codeScanning: {
					listAlertsForRepo: async () => ({ data: [sampleCodeAlert()], headers: {} }),
				},
			});
			registerSecurityTools(server, () => octokit);

			const result = await invoke(handlers, "list_code_scanning_alerts", { owner: "o", repo: "r" });
			const body = result.content[0].text;
			expect(body).toContain("# Code-scanning alerts (1)");
			expect(body).toContain("`#12` **open** — `js/sql-injection` (high), CodeQL, src/db.ts:42");
		});

		it("falls back to the generic severity when no security severity is set", async () => {
			const { handlers, server } = captureHandlers();
			const octokit = withRest({
				codeScanning: {
					listAlertsForRepo: async () => ({
						data: [
							sampleCodeAlert({
								rule: { id: "js/unused", severity: "note", security_severity_level: null },
								most_recent_instance: { location: {} },
							}),
						],
						headers: {},
					}),
				},
			});
			registerSecurityTools(server, () => octokit);

			const result = await invoke(handlers, "list_code_scanning_alerts", { owner: "o", repo: "r" });
			expect(result.content[0].text).toContain("`js/unused` (note), CodeQL");
		});

		it("reports an empty result", async () => {
			const { handlers, server } = captureHandlers();
			registerSecurityTools(server, () => withRest({}));
			const result = await invoke(handlers, "list_code_scanning_alerts", { owner: "o", repo: "r" });
			expect(result.content[0].text).toBe("(no code-scanning alerts found)");
		});
	});

	describe("list_dependabot_alerts", () => {
		it("renders number, state, package, severity, GHSA, and summary", async () => {
			const { handlers, server } = captureHandlers();
			const octokit = withRest({
				dependabot: {
					listAlertsForRepo: async () => ({ data: [sampleDependabotAlert()], headers: {} }),
				},
			});
			registerSecurityTools(server, () => octokit);

			const result = await invoke(handlers, "list_dependabot_alerts", { owner: "o", repo: "r" });
			const body = result.content[0].text;
			expect(body).toContain("# Dependabot alerts (1)");
			expect(body).toContain(
				"`#3` **open** — npm:lodash (high), `GHSA-xxxx-yyyy-zzzz` — Prototype pollution in lodash",
			);
		});

		it("reports an empty result", async () => {
			const { handlers, server } = captureHandlers();
			registerSecurityTools(server, () => withRest({}));
			const result = await invoke(handlers, "list_dependabot_alerts", { owner: "o", repo: "r" });
			expect(result.content[0].text).toBe("(no Dependabot alerts found)");
		});

		it("shows a pagination hint when a next link is present", async () => {
			const { handlers, server } = captureHandlers();
			const octokit = withRest({
				dependabot: {
					listAlertsForRepo: async () => ({
						data: [sampleDependabotAlert()],
						headers: { link: '<https://api.github.com/...?page=2>; rel="next"' },
					}),
				},
			});
			registerSecurityTools(server, () => octokit);

			const result = await invoke(handlers, "list_dependabot_alerts", {
				owner: "o",
				repo: "r",
				page: 1,
			});
			expect(result.content[0].text).toContain("page 1, 1 shown; more available");
		});
	});
});
