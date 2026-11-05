import { createLegacyMcpHandler, type WorkerTransportOptions } from "agents/mcp";

import type { Props } from "../utils";
import type { FetchHandler } from "./body-limit";
import { createMcpServerWithTools, type OctokitBuilder, type ServerInstrument } from "./server";

type StatelessOptions = {
	route: string;
	corsOptions: NonNullable<WorkerTransportOptions["corsOptions"]>;
	instrumentServer: ServerInstrument | undefined;
	createOctokit: OctokitBuilder;
};

const hasAccessToken = (props: unknown): props is Pick<Props, "accessToken"> =>
	typeof props === "object" &&
	props !== null &&
	"accessToken" in props &&
	typeof props.accessToken === "string";

// Fresh server per request, no session id, no Durable Object rows.
// GET and DELETE are 405: there is no session to stream to or end.
export const statelessMcpHandler = ({
	route,
	corsOptions,
	instrumentServer,
	createOctokit,
}: StatelessOptions): FetchHandler => ({
	fetch: (request, env, ctx) => {
		if (request.method === "GET" || request.method === "DELETE") {
			return new Response("Method Not Allowed", {
				status: 405,
				headers: { Allow: "POST, OPTIONS" },
			});
		}
		const props = ctx.props;
		const server = createMcpServerWithTools(() => {
			if (!hasAccessToken(props)) {
				throw new Error("OAuth props are not available; request is not authenticated.");
			}
			return createOctokit(props.accessToken);
		}, instrumentServer);
		// The SDK v1 server only fits the "legacy" handler; its v2 factory handler needs a migration (#252).
		return createLegacyMcpHandler(server, { route, corsOptions })(request, env, ctx);
	},
});
