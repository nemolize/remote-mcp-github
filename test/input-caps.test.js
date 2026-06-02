import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
	MAX_FILE_CONTENT_LENGTH,
	MAX_FILES_PER_COMMIT,
	MAX_TEXT_FIELD_LENGTH,
	MAX_TOTAL_COMMIT_CONTENT_LENGTH,
} from "../src/tools/common.js";
import { registerFileTools } from "../src/tools/files.js";
import { registerIssueTools } from "../src/tools/issues.js";
import { registerPullTools } from "../src/tools/pulls.js";

// The MCP SDK validates a tool's inputSchema before the handler runs, so the
// handler-level tests elsewhere never exercise these caps. Here we capture the
// registered inputSchema and parse against it directly to assert the limits.
const captureSchemas = (register) => {
	const schemas = new Map();
	const server = {
		registerTool: (name, config, _handler) => {
			schemas.set(name, z.object(config.inputSchema));
		},
	};
	register(server, () => ({}));
	return schemas;
};

// The aggregate-content cap lives in the commit_files handler (not the schema),
// so it needs handler capture. The octokit stub throws on any REST call to prove
// the guard short-circuits before reaching the GitHub API.
const captureHandlers = (register, client) => {
	const handlers = new Map();
	const server = {
		registerTool: (name, _config, handler) => {
			handlers.set(name, handler);
		},
	};
	register(server, client);
	return handlers;
};

const fileSchemas = captureSchemas(registerFileTools);
const issueSchemas = captureSchemas(registerIssueTools);
const pullSchemas = captureSchemas(registerPullTools);

const repo = { owner: "o", repo: "r" };
const overLimit = (max) => "x".repeat(max + 1);
const atLimit = (max) => "x".repeat(max);

describe("input size caps", () => {
	it("commit_file rejects oversized content but accepts content at the limit", () => {
		const schema = fileSchemas.get("commit_file");
		const base = { ...repo, branch: "main", path: "a.txt", message: "m" };
		expect(schema.safeParse({ ...base, content: overLimit(MAX_FILE_CONTENT_LENGTH) }).success).toBe(
			false,
		);
		expect(schema.safeParse({ ...base, content: atLimit(MAX_FILE_CONTENT_LENGTH) }).success).toBe(
			true,
		);
	});

	it("commit_file rejects an oversized commit message", () => {
		const schema = fileSchemas.get("commit_file");
		const result = schema.safeParse({
			...repo,
			branch: "main",
			path: "a.txt",
			content: "hi",
			message: overLimit(MAX_TEXT_FIELD_LENGTH),
		});
		expect(result.success).toBe(false);
	});

	it("delete_file rejects an oversized commit message", () => {
		const schema = fileSchemas.get("delete_file");
		const result = schema.safeParse({
			...repo,
			branch: "main",
			path: "a.txt",
			message: overLimit(MAX_TEXT_FIELD_LENGTH),
		});
		expect(result.success).toBe(false);
	});

	it("commit_files caps the file count", () => {
		const schema = fileSchemas.get("commit_files");
		const makeFiles = (n) =>
			Array.from({ length: n }, (_, i) => ({ path: `f${i}.txt`, content: "x" }));
		expect(
			schema.safeParse({
				...repo,
				branch: "main",
				message: "m",
				files: makeFiles(MAX_FILES_PER_COMMIT),
			}).success,
		).toBe(true);
		expect(
			schema.safeParse({
				...repo,
				branch: "main",
				message: "m",
				files: makeFiles(MAX_FILES_PER_COMMIT + 1),
			}).success,
		).toBe(false);
	});

	it("commit_files caps per-file content size", () => {
		const schema = fileSchemas.get("commit_files");
		const result = schema.safeParse({
			...repo,
			branch: "main",
			message: "m",
			files: [{ path: "a.txt", content: overLimit(MAX_FILE_CONTENT_LENGTH) }],
		});
		expect(result.success).toBe(false);
	});

	it("commit_files rejects aggregate content over the total cap before any API call", async () => {
		const throwingOctokit = {
			rest: {
				git: {
					getCommit: () => {
						throw new Error("octokit should not be called when the aggregate cap is exceeded");
					},
				},
			},
		};
		const handlers = captureHandlers(registerFileTools, () => throwingOctokit);
		// Each file is at the per-file cap (passes schema); enough files to exceed the total.
		const fileCount = Math.floor(MAX_TOTAL_COMMIT_CONTENT_LENGTH / MAX_FILE_CONTENT_LENGTH) + 1;
		const files = Array.from({ length: fileCount }, (_, i) => ({
			path: `f${i}.txt`,
			content: atLimit(MAX_FILE_CONTENT_LENGTH),
		}));
		const result = await handlers.get("commit_files")({
			...repo,
			branch: "main",
			message: "m",
			files,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Combined file content");
	});

	it("create_issue rejects an oversized body", () => {
		const schema = issueSchemas.get("create_issue");
		expect(
			schema.safeParse({ ...repo, title: "t", body: overLimit(MAX_TEXT_FIELD_LENGTH) }).success,
		).toBe(false);
		expect(schema.safeParse({ ...repo, title: "t" }).success).toBe(true);
	});

	it("add_comment rejects an oversized body", () => {
		const schema = issueSchemas.get("add_comment");
		const result = schema.safeParse({
			...repo,
			issue_number: 1,
			body: overLimit(MAX_TEXT_FIELD_LENGTH),
		});
		expect(result.success).toBe(false);
	});

	it("update_issue rejects an oversized body", () => {
		const schema = issueSchemas.get("update_issue");
		const result = schema.safeParse({
			...repo,
			issue_number: 1,
			body: overLimit(MAX_TEXT_FIELD_LENGTH),
		});
		expect(result.success).toBe(false);
	});

	it("create_pull_request rejects an oversized body", () => {
		const schema = pullSchemas.get("create_pull_request");
		const result = schema.safeParse({
			...repo,
			title: "t",
			head: "feature",
			body: overLimit(MAX_TEXT_FIELD_LENGTH),
		});
		expect(result.success).toBe(false);
	});
});
