import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			// Override the worker entry so that the OAuth `defaultHandler` is the
			// fake GitHub handler used by the transport E2E. Production wiring lives
			// in src/index.ts and is unaffected.
			main: "./test/_fixtures/test-worker.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
});
