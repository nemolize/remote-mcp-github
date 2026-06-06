/**
 * Drops keys whose value is `undefined`, leaving every other value (including
 * `null`) intact, and narrows the result type so the surviving optional keys no
 * longer carry `undefined`.
 *
 * Under `exactOptionalPropertyTypes`, Octokit's request methods reject an
 * explicit `undefined` on an optional field (`body?: string` does not accept
 * `body: undefined`), so optional schema inputs cannot be spread into a request
 * object directly. Passing the object through this helper omits the unset keys
 * so the remaining shape matches Octokit's `T?` optionals.
 *
 * `null` is preserved (the key is kept) because some fields — e.g.
 * `update_issue`'s `state_reason` / `milestone` — accept `null` as a meaningful
 * "clear" signal that must still be sent.
 *
 * This file is the single sanctioned home for the type assertion the narrowing
 * requires: `Object.fromEntries` returns a structurally-lossy type, so the cast
 * back to the narrowed shape is unavoidable. The repo-wide eslint rule
 * `@typescript-eslint/consistent-type-assertions` (`assertionStyle: "never"`)
 * is relaxed for this one file via `eslint.config.mjs` overrides, keeping the
 * assertion contained rather than scattering nine conditional spreads across
 * the call sites.
 */
export const stripUndefined = <T extends object>(
	obj: T,
): { [K in keyof T]: Exclude<T[K], undefined> } =>
	Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as {
		[K in keyof T]: Exclude<T[K], undefined>;
	};
