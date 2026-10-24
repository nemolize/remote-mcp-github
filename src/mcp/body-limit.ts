// Matches the cap `agents` hard-codes in its /mcp and /sse/message handlers, which
// it checks against Content-Length only, so a chunked or understated body slips past.
export const MAX_MCP_MESSAGE_BYTES = 4 * 1024 * 1024;

type FetchHandler = {
	fetch: (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;
};

const tooLarge = (): Response =>
	new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id: null,
			error: {
				code: -32000,
				message: `Request body too large. Maximum size is ${MAX_MCP_MESSAGE_BYTES} bytes`,
			},
		}),
		{ status: 413, headers: { "content-type": "application/json" } },
	);

const readAtMost = async (
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<Uint8Array | null> => {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
};

export const limitRequestBody = (handler: FetchHandler): FetchHandler => ({
	fetch: async (request, env, ctx) => {
		if (request.body === null) return handler.fetch(request, env, ctx);
		if (Number(request.headers.get("content-length")) > MAX_MCP_MESSAGE_BYTES) return tooLarge();
		const body = await readAtMost(request.body, MAX_MCP_MESSAGE_BYTES);
		if (body === null) return tooLarge();
		const headers = new Headers(request.headers);
		headers.set("content-length", String(body.byteLength));
		return handler.fetch(new Request(request, { body, headers }), env, ctx);
	},
});
