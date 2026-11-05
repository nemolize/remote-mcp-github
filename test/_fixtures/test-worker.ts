import { Octokit } from "octokit";

import { buildOAuthProvider, MyMCP as ProductionMCP } from "../../src/index";
import type { ServerInstrument } from "../../src/mcp/server";
import { FakeGitHubHandler } from "./fake-github-handler";

const offlineOctokit = (): Octokit =>
	new Octokit({
		retry: { enabled: false },
		throttle: { enabled: false },
		request: {
			fetch: async () =>
				new Response(JSON.stringify({ message: "offline test stub" }), {
					status: 418,
					headers: { "content-type": "application/json" },
				}),
		},
	});

type ToolCallback = (...args: unknown[]) => unknown;
type ToolRegistrar = (name: string, config: unknown, callback: ToolCallback) => unknown;

const handlerCalls = new Map<string, number>();
const tokensSeen: string[] = [];

const createOctokit = (accessToken: string): Octokit => {
	tokensSeen.push(accessToken);
	return offlineOctokit();
};

const instrumentServer: ServerInstrument = (server) => {
	server.registerTool("_test_handler_calls", { inputSchema: {} }, () => ({
		content: [{ type: "text", text: JSON.stringify(Object.fromEntries(handlerCalls)) }],
	}));
	server.registerTool("_test_octokit_tokens", { inputSchema: {} }, () => ({
		content: [{ type: "text", text: JSON.stringify(tokensSeen) }],
	}));
	server.registerTool("_test_reset", { inputSchema: {} }, () => {
		handlerCalls.clear();
		tokensSeen.length = 0;
		return { content: [{ type: "text", text: "reset" }] };
	});
	// Typed `string`, so Reflect.get yields `any` rather than the generic overload.
	const method: string = "registerTool";
	const register: ToolRegistrar = Reflect.get(server, method).bind(server);
	Reflect.set(server, method, (name: string, config: unknown, callback: ToolCallback) =>
		register(name, config, (...args) => {
			handlerCalls.set(name, (handlerCalls.get(name) ?? 0) + 1);
			return callback(...args);
		}),
	);
};

let durableObjectsConstructed = 0;

// Re-exported as `MyMCP` so the wrangler.jsonc binding (class_name: MyMCP) resolves here.
class OfflineMCP extends ProductionMCP {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		durableObjectsConstructed++;
	}

	protected override createOctokit(accessToken: string): Octokit {
		return createOctokit(accessToken);
	}
}
export { OfflineMCP as MyMCP };

const provider = buildOAuthProvider(
	{ fetch: (request, env, ctx) => FakeGitHubHandler.fetch(request, env, ctx) },
	{ instrumentServer, createOctokit },
);

export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
		new URL(request.url).pathname === "/_test/durable-objects-constructed"
			? Response.json({ count: durableObjectsConstructed })
			: provider.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
