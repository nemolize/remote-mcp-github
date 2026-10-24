import { Octokit } from "octokit";

import { buildOAuthProvider, MyMCP as ProductionMCP } from "../../src/index";
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

class InstrumentedMCP extends ProductionMCP {
	readonly handlerCalls: Record<string, number> = {};
	readonly tokensSeen: string[] = [];

	protected override createOctokit(accessToken: string): Octokit {
		this.tokensSeen.push(accessToken);
		return offlineOctokit();
	}

	override async init(): Promise<void> {
		this.server.registerTool("_test_handler_calls", { inputSchema: {} }, () => ({
			content: [{ type: "text", text: JSON.stringify(this.handlerCalls) }],
		}));
		this.server.registerTool("_test_octokit_tokens", { inputSchema: {} }, () => ({
			content: [{ type: "text", text: JSON.stringify(this.tokensSeen) }],
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
		await super.init();
	}
}

// Re-exported under the production name so the wrangler.jsonc Durable Object
// binding (class_name: MyMCP) resolves against this entry when vitest overrides `main`.
export { InstrumentedMCP as MyMCP };

export default buildOAuthProvider({
	fetch: (request, env, ctx) => FakeGitHubHandler.fetch(request, env, ctx),
});
