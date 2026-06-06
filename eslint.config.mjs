import { fileURLToPath } from "node:url";

import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	includeIgnoreFile(fileURLToPath(new URL(".gitignore", import.meta.url))),
	{ ignores: ["worker-configuration.d.ts"] },
	js.configs.recommended,
	tseslint.configs.strict,
	{
		languageOptions: { globals: { ...globals.node } },
		plugins: {
			"simple-import-sort": simpleImportSort,
			"unused-imports": unusedImports,
		},
		rules: {
			"@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
			"@typescript-eslint/no-unused-vars": "off",
			"simple-import-sort/imports": "error",
			"simple-import-sort/exports": "error",
			"unused-imports/no-unused-imports": "error",
			"unused-imports/no-unused-vars": [
				"error",
				{
					varsIgnorePattern: "^_",
					argsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
		},
	},
	{
		files: ["src/**/*.ts"],
		languageOptions: { parserOptions: { project: true } },
		rules: {
			"@typescript-eslint/no-deprecated": "error",
			"@typescript-eslint/strict-boolean-expressions": "error",
		},
	},
	{
		// `stripUndefined` narrows away `undefined` from optional keys; the
		// `Object.fromEntries` round-trip is structurally lossy, so a type
		// assertion back to the narrowed shape is unavoidable there. Contain the
		// single assertion to this one file rather than scattering conditional
		// spreads across every Octokit call site (see strip-undefined.ts).
		files: ["src/tools/strip-undefined.ts"],
		rules: {
			"@typescript-eslint/consistent-type-assertions": "off",
		},
	},
);
