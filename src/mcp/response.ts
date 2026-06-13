export type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

export const MAX_RESPONSE_CHARS = 8000;

// How the caller fetches the next page once `hasMore` is true. All REST list
// endpoints here share `page` / `per_page` semantics, so the instruction is the
// same everywhere — a single constant keeps the wording identical across tools.
const REST_NEXT_PAGE_HINT = "pass next `page` or raise `per_page` up to 100";

// Builds the `# Title (...)` header line for a REST page-based list tool, folding
// the "more results available" hint into the parenthetical when there is a next
// page. Without a next page it collapses to `# Title (count)`. Centralising this
// keeps the page/`per_page` wording consistent across list tools (commits,
// branches, repos, issues, labels, PR reviews, ...) instead of each hand-rolling
// the same string.
export const restListHeader = ({
	title,
	count,
	page,
	hasMore,
}: {
	title: string;
	count: number;
	page?: number | undefined;
	hasMore: boolean;
}): string =>
	hasMore
		? `# ${title} (page ${page ?? 1}, ${count} shown; more available — ${REST_NEXT_PAGE_HINT})`
		: `# ${title} (${count})`;

// Builds the trailing "more results" suffix for a cursor (GraphQL) based list
// tool. Returns "" when there is no next page so the caller can append it
// unconditionally. The cursor instruction is tool-specific (it names the cursor
// argument), so it is passed in; callers that truncate must reserve `.length` of
// this suffix from their budget so the cursor is never dropped (see #50).
export const cursorMoreHint = ({
	shown,
	total,
	hasMore,
	nextPageInstruction,
}: {
	shown: number;
	total: number;
	hasMore: boolean;
	nextPageInstruction: string;
}): string =>
	hasMore ? `\n\n(${shown} of ${total} shown; more results exist. ${nextPageInstruction})` : "";

// Shared truncation core for both `truncate` (keep head) and `truncateTail`
// (keep tail). Both want the same length-invariant: the returned string honours
// `maxChars` *including* the truncation notice, so a caller that appends a
// trailing hint (e.g. a pagination cursor) within its own budget can rely on the
// total staying within the cap. Only two things differ between the two — which
// end of the text is retained and the notice wording — so they are parameters
// here and the invariant logic (reserve notice, slice, hard-cap) lives once.
const truncateKeeping = (
	text: string,
	keep: "head" | "tail",
	maxChars: number,
	notice: (omitted: number) => string,
): string => {
	if (text.length <= maxChars) return text;
	// Size the slice against the notice for the worst case (every other char
	// omitted), then report the exact count from the actual slice length.
	const sliceLen = Math.max(0, maxChars - notice(text.length).length);
	const omitted = text.length - sliceLen;
	const out =
		keep === "head"
			? `${text.slice(0, sliceLen)}${notice(omitted)}`
			: `${notice(omitted)}${text.slice(text.length - sliceLen)}`;
	// When `maxChars` is smaller than the notice itself, `sliceLen` floors at 0
	// and `out` is just the notice — which can exceed `maxChars`. Hard-cap so the
	// length invariant holds for *every* `maxChars`, even degenerate ones. Keep
	// the same end of the notice that the caller asked to keep of the text.
	if (out.length <= maxChars) return out;
	return keep === "head" ? out.slice(0, maxChars) : out.slice(out.length - maxChars);
};

// Keeps the *head* of the text — the default for list / detail tools whose
// signal sits at the top (the first rows, the heading + metadata).
export const truncate = (text: string, maxChars = MAX_RESPONSE_CHARS): string =>
	truncateKeeping(
		text,
		"head",
		maxChars,
		(omitted) =>
			`\n\n... (truncated; ${omitted} more characters omitted to save context. Refine your query or paginate to see more.)`,
	);

// Keeps the *tail* of the text — for payloads whose signal sits at the end, most
// notably workflow-job logs where a CI failure surfaces in the final lines. The
// notice is prefixed (the dropped region is the head). `instruction` lets the
// caller phrase the follow-up that fits its tool (a log tool can't paginate, so
// it shouldn't tell the reader to).
export const truncateTail = (
	text: string,
	maxChars = MAX_RESPONSE_CHARS,
	instruction = "Narrow the source to see more.",
): string =>
	truncateKeeping(
		text,
		"tail",
		maxChars,
		(omitted) =>
			`... (truncated; ${omitted} leading characters omitted to save context — the tail, where failures surface, is kept. ${instruction})\n\n`,
	);

export const text = (body: string): ToolResult => ({
	content: [{ type: "text", text: body }],
});

export const errorResult = (message: string): ToolResult => ({
	content: [{ type: "text", text: `Error: ${message}` }],
	isError: true,
});

// Known limitation: the caught error's message is forwarded to the model
// verbatim. Octokit typically redacts the Authorization header from the error
// it throws, so a token is not expected to leak here — but this is not a hard
// guarantee, and the remaining fields (URLs, request bodies) are not sanitised.
// Field-level sanitisation would be defence-in-depth but is not done today.
export const wrapTool = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
	try {
		return await fn();
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : String(e);
		const status =
			e != null &&
			typeof e === "object" &&
			"status" in e &&
			(typeof e.status === "number" || typeof e.status === "string")
				? ` (HTTP ${e.status})`
				: "";
		return errorResult(`${message}${status}`);
	}
};

export const logRateLimit = (
	headers: Record<string, string | number | undefined> | Headers,
): void => {
	const get = (k: string): string | number | null | undefined =>
		headers instanceof Headers ? headers.get(k) : headers[k];
	const remaining = get("x-ratelimit-remaining");
	const limit = get("x-ratelimit-limit");
	const reset = get("x-ratelimit-reset");
	if (remaining != null) {
		const resetIso = reset != null ? new Date(Number(reset) * 1000).toISOString() : "unknown";
		console.log(`[github-ratelimit] ${remaining}/${limit} remaining, resets at ${resetIso}`);
	}
};

// Fields a write tool reports about the mutation it performed. `tool` is always
// present; the rest are tool-specific (e.g. `owner` + `repo` + `branch` +
// `path` for file commits, `issue_number` for issue/PR edits, `run_id` for
// workflow-run mutations, `workflow_id` for a workflow dispatch, `thread_id`
// for GraphQL review-thread mutations that have no owner/repo at the call
// boundary).
// `null`/undefined values are dropped so the emitted line only carries what the
// call touched.
export type WriteAuditFields = {
	tool: string;
	owner?: string;
	repo?: string;
	branch?: string;
	path?: string;
	issue_number?: number;
	pull_number?: number;
	run_id?: number;
	workflow_id?: number | string; // trigger_workflow_dispatch
	ref?: string; // trigger_workflow_dispatch
	release_id?: number; // create_release / update_release / delete_release
	tag_name?: string; // create_release
	file_count?: number;
	thread_id?: string;
	comment_id?: number; // add_pr_review_comment_reply
	review_id?: number; // create_pr_review
};

// Emits one structured JSON line per successful write operation, giving
// post-hoc accountability for LLM-mediated mutations (`logRateLimit` only
// records quota, not what was written). Distinct `[github-audit]` prefix so log
// drains can isolate the write trail from rate-limit noise.
export const logWrite = (fields: WriteAuditFields): void => {
	const entry: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (value != null) entry[key] = value;
	}
	console.log(`[github-audit] ${JSON.stringify(entry)}`);
};
