import { Octokit } from "octokit";

import { buildOAuthProvider, MyMCP as ProductionMCP } from "../../src/index";
import { registerTools } from "../../src/tools";
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

// Production server, transport and tool registrations; only the Octokit factory
// differs, plus a `_test_handler_calls` tool reporting how often each handler ran.
class InstrumentedMCP extends ProductionMCP {
	readonly handlerCalls: Record<string, number> = {};

	override async init(): Promise<void> {
		this.server.registerTool("_test_handler_calls", { inputSchema: {} }, () => ({
			content: [{ type: "text", text: JSON.stringify(this.handlerCalls) }],
		}));
		// Typed `string`, so Reflect.get yields `any` rather than the generic overload.
		const method: string = "registerTool";
		const register: ToolRegistrar = Reflect.get(this.server, method).bind(this.server);
		Reflect.set(this.server, method, (name: string, config: unknown, callback: ToolCallback) =>
			register(name, config, (...args) => {
				this.handlerCalls[name] = (this.handlerCalls[name] ?? 0) + 1;
				return callback(...args);
			}),
		);
		registerTools(this.server, offlineOctokit);
	}
}

// Re-exported under the production name so the wrangler.jsonc Durable Object
// binding (class_name: MyMCP) resolves against this entry when vitest overrides `main`.
export { InstrumentedMCP as MyMCP };

export default buildOAuthProvider({
	fetch: (request, env, ctx) => FakeGitHubHandler.fetch(request, env, ctx),
});
