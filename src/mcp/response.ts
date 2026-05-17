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

export const wrapTool = async (
	fn: () => Promise<ToolResult>,
): Promise<ToolResult> => {
	try {
		return await fn();
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : String(e);
		const status =
			e != null && typeof e === "object" && "status" in e
				? ` (HTTP ${(e as { status: number }).status})`
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
		const resetIso = reset
			? new Date(Number(reset) * 1000).toISOString()
			: "unknown";
		console.log(
			`[github-ratelimit] ${remaining}/${limit} remaining, resets at ${resetIso}`,
		);
	}
};
