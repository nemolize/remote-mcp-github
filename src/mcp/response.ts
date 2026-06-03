export type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

export const MAX_RESPONSE_CHARS = 8000;

export const truncate = (text: string, maxChars = MAX_RESPONSE_CHARS): string => {
	if (text.length <= maxChars) return text;
	const omitted = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n... (truncated; ${omitted} more characters omitted to save context. Refine your query or paginate to see more.)`;
};

export const text = (body: string): ToolResult => ({
	content: [{ type: "text", text: body }],
});

export const errorResult = (message: string): ToolResult => ({
	content: [{ type: "text", text: `Error: ${message}` }],
	isError: true,
});

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

// Fields a write tool reports about the mutation it performed. `tool`, `owner`,
// and `repo` are always present; the rest are tool-specific (e.g. `branch` +
// `path` for file commits, `issue_number` for issue/PR edits). `null`/undefined
// values are dropped so the emitted line only carries what the call touched.
export type WriteAuditFields = {
	tool: string;
	owner: string;
	repo: string;
	branch?: string;
	path?: string;
	issue_number?: number;
	pull_number?: number;
	file_count?: number;
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
