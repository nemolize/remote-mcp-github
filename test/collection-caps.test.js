import { describe, expect, it } from "vitest";
import { z } from "zod";

import { registerActionTools } from "../src/tools/actions.js";
import {
	MAX_ASSIGNEES,
	MAX_FILES_PER_COMMIT,
	MAX_GIST_FILES,
	MAX_LABELS,
	MAX_REVIEW_COMMENTS,
	MAX_TOOL_INPUT_ELEMENTS,
} from "../src/tools/common.js";
import { registerFileTools } from "../src/tools/files.js";
import { registerGistTools } from "../src/tools/gists.js";
import { registerIssueTools } from "../src/tools/issues.js";
import { registerProjectTools } from "../src/tools/projects.js";
import { registerPullTools } from "../src/tools/pulls.js";

const captureSchemas = (register) => {
	const schemas = new Map();
	register(
		{ registerTool: (name, config) => schemas.set(name, z.object(config.inputSchema)) },
		() => ({}),
	);
	return schemas;
};

const schemas = new Map(
	[
		registerActionTools,
		registerFileTools,
		registerGistTools,
		registerIssueTools,
		registerProjectTools,
		registerPullTools,
	].flatMap((register) => [...captureSchemas(register)]),
);

const repo = { owner: "o", repo: "r" };
const strings = (n) => Array.from({ length: n }, (_, i) => `s${i}`);
const record = (n, value) =>
	Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}.txt`, value(i)]));
const fullComment = (i) => ({
	path: `f${i}.ts`,
	body: "b",
	line: 2,
	side: "RIGHT",
	start_line: 1,
	start_side: "RIGHT",
});
const comments = (n) => Array.from({ length: n }, (_, i) => fullComment(i));

// Hard-coded where the cap is private to its tool file, so a changed cap fails here.
const CASES = [
	["create_issue", "labels", MAX_LABELS, { ...repo, title: "t" }, strings],
	["create_issue", "assignees", MAX_ASSIGNEES, { ...repo, title: "t" }, strings],
	["update_issue", "labels", MAX_LABELS, { ...repo, issue_number: 1 }, strings],
	["update_issue", "assignees", MAX_ASSIGNEES, { ...repo, issue_number: 1 }, strings],
	["add_labels", "labels", MAX_LABELS, { ...repo, issue_number: 1 }, strings],
	["add_assignees", "assignees", MAX_ASSIGNEES, { ...repo, issue_number: 1 }, strings],
	["remove_assignees", "assignees", MAX_ASSIGNEES, { ...repo, issue_number: 1 }, strings],
	["request_pr_review", "reviewers", 100, { ...repo, pull_number: 1 }, strings],
	["request_pr_review", "team_reviewers", 100, { ...repo, pull_number: 1 }, strings],
	[
		"create_pr_review",
		"comments",
		MAX_REVIEW_COMMENTS,
		{ ...repo, pull_number: 1, event: "COMMENT", body: "b" },
		comments,
	],
	[
		"create_pending_pr_review",
		"comments",
		MAX_REVIEW_COMMENTS,
		{ ...repo, pull_number: 1 },
		comments,
	],
	["create_gist", "files", MAX_GIST_FILES, {}, (n) => record(n, () => ({ content: "x" }))],
	["update_gist", "files", MAX_GIST_FILES, { gist_id: "g" }, (n) => record(n, () => null)],
	[
		"trigger_workflow_dispatch",
		"inputs",
		25,
		{ ...repo, workflow_id: "ci.yml", ref: "main" },
		(n) => record(n, (i) => i),
	],
	[
		"create_project_field",
		"options",
		50,
		{ owner: "o", number: 1, name: "Status", data_type: "SINGLE_SELECT" },
		strings,
	],
	[
		"commit_files",
		"files",
		MAX_FILES_PER_COMMIT,
		{ ...repo, branch: "main", message: "m" },
		(n) => Array.from({ length: n }, (_, i) => ({ path: `f${i}.txt`, content: "x" })),
	],
];

describe("collection element caps", () => {
	it.each(CASES)(
		"%s.%s accepts %i entries and rejects one more",
		(tool, field, cap, base, make) => {
			const schema = schemas.get(tool);
			expect(schema, `${tool} not registered`).toBeDefined();
			const atCap = schema.safeParse({ ...base, [field]: make(cap) });
			expect(atCap.success, JSON.stringify(atCap.error?.issues?.[0])).toBe(true);
			const overCap = schema.safeParse({ ...base, [field]: make(cap + 1) });
			expect(overCap.success).toBe(false);
			expect(overCap.error.issues.map((i) => i.path[0])).toContain(field);
		},
	);

	it("covers every array and record field in the tool schemas", () => {
		const isCollection = (s) => {
			const def = s.def ?? s._zod?.def;
			if (def == null) return false;
			if (def.type === "array" || def.type === "record") return true;
			const inner = def.innerType ?? def.in;
			return inner != null && isCollection(inner);
		};
		const found = [...schemas].flatMap(([tool, schema]) =>
			Object.entries(schema.shape)
				.filter(([, field]) => isCollection(field))
				.map(([field]) => `${tool}.${field}`),
		);
		expect(found.sort()).toEqual(CASES.map(([tool, field]) => `${tool}.${field}`).sort());
	});
});

// Same rule as the SDK's toolInputElementCount: every array element and object key.
const countElements = (value) => {
	if (value === null || typeof value !== "object") return 0;
	const children = Array.isArray(value) ? value : Object.values(value);
	return children.length + children.reduce((sum, child) => sum + countElements(child), 0);
};

describe("tool input element budget", () => {
	it("covers the largest argument set the caps admit", () => {
		const largest = CASES.map(([tool, field, cap, base, make]) => {
			const args = { ...base, [field]: make(cap) };
			expect(schemas.get(tool).safeParse(args).success).toBe(true);
			return [tool, countElements(args)];
		}).sort((a, b) => b[1] - a[1])[0];
		expect(largest).toEqual(["create_pr_review", 706]);
		expect(largest[1]).toBeLessThanOrEqual(MAX_TOOL_INPUT_ELEMENTS);
	});
});
