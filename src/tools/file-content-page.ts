import { z } from "zod";

import { errorResult, MAX_RESPONSE_CHARS, text, type ToolResult } from "../mcp/response.js";

export const MAX_FILE_READ_BYTES = 20_000_000;
const BASE64_CHUNK_CHARS = 16_384;

export const FileRangeSchema = {
	offset: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe(
			"Zero-based Unicode code point offset into file text. Defaults to 0; not supported for directories.",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(MAX_RESPONSE_CHARS)
		.optional()
		.describe(
			`Maximum Unicode code points of file text to return (1-${MAX_RESPONSE_CHARS}). Defaults to ${MAX_RESPONSE_CHARS}; not supported for directories.`,
		),
};

export const fileContentPage = (
	header: string,
	base64: string,
	url: string | null | undefined,
	offset = 0,
	limit = MAX_RESPONSE_CHARS,
): ToolResult => {
	const encoded = base64.replace(/\s/g, "");
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
	const chunk: string[] = [];
	let position = 0;
	let byteCount = 0;
	const collect = (decoded: string): void => {
		for (const point of decoded) {
			if (position >= offset && chunk.length < limit) chunk.push(point);
			position++;
		}
	};
	try {
		for (let start = 0; start < encoded.length; start += BASE64_CHUNK_CHARS) {
			const binary = atob(encoded.slice(start, start + BASE64_CHUNK_CHARS));
			byteCount += binary.length;
			if (byteCount > MAX_FILE_READ_BYTES)
				return errorResult(`File exceeds the ${MAX_FILE_READ_BYTES}-byte read limit.`);
			const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
			collect(decoder.decode(bytes, { stream: true }));
		}
		collect(decoder.decode());
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		return errorResult(
			`File appears to be binary (not valid UTF-8); not rendering its bytes as text. View it on the web instead: ${url ?? "(url unavailable)"}`,
		);
	}
	if (offset > position) return errorResult("offset is past the end of the file.");
	const nextOffset = offset + chunk.length;
	const more = nextOffset < position;
	const continuation = more
		? `More content: call again with \`offset: ${nextOffset}\` and the same path and ref.`
		: "End of file.";
	return text(
		`${header}\n\n\`\`\`\n${chunk.join("")}\n\`\`\`\n\nCharacters ${offset}–${nextOffset} (end exclusive). ${continuation}`,
	);
};
