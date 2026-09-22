import { z } from "zod";

import { text, type ToolResult, truncate } from "../mcp/response.js";

export const FullResponseSchema = {
	full: z
		.boolean()
		.optional()
		.describe(
			"Return the complete response without the default 8000-character truncation. May produce a large response; existing file read limits still apply.",
		),
};

export const detailText = (body: string, full?: boolean): ToolResult =>
	text(
		full === true
			? body
			: truncate(body, undefined, "Call again with `full: true` to read the complete response."),
	);
