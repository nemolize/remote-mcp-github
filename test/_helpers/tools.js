import { expect } from "vitest";

/**
 * Capture the handlers a `registerXxxTools(server, client)` call registers.
 *
 * Returns a minimal `server` exposing only `registerTool` plus the `handlers`
 * map it populates. Pass the `server` to a register function, then look the
 * handler up by tool name via {@link invoke}.
 */
export const captureHandlers = () => {
	const handlers = new Map();
	const server = {
		registerTool: (name, _config, handler) => {
			handlers.set(name, handler);
		},
	};
	return { handlers, server };
};

/**
 * Invoke a captured tool handler by name, asserting it was registered.
 */
export const invoke = async (handlers, name, params) => {
	const handler = handlers.get(name);
	expect(handler, `tool ${name} was not registered`).toBeDefined();
	return handler(params);
};
