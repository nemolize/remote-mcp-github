---
status: accepted
date: 2026-05-22
decision-makers: nemolize
consulted: none
informed: future contributors via this ADR
---

# CI E2E tiering via fake auth handler

## Context and Problem Statement

Issue #32 originally framed the OAuth-aware E2E harness as a manual-only developer convenience and explicitly carved it out of CI ("No CI changes — the script is not wired into the workflow"). The follow-up question on PR #35 was whether that carve-out should hold: manual harnesses get forgotten, and the MCP server's transport / OAuth-provider / tool-registration code is otherwise CI-uncovered.

The decision was: keep the manual harness but **also** add a CI-runnable transport E2E, splitting coverage across two tiers rather than choosing one or the other.

## Decision Drivers

- Manual-only coverage rots silently; "forgot to run before release" is a real failure mode.
- A pure full-OAuth E2E in CI hits an external-credentials wall (GitHub login + 2FA).
- Adding test-only auth-bypass code paths to production wiring is a security regression vector.
- The transport / OAuth-provider / tool-registration code (`@cloudflare/workers-oauth-provider` plumbing, `MyMCP.serve`, `tools/list`) is library-driven and changes break in non-obvious ways — exactly the regression class CI is best at catching.
- Real-GitHub tool-output coverage (Markdown formatters fed by real API responses) is genuinely valuable at release time but does not need to gate every PR.

## Considered Options

1. **Manual harness only** (per the issue's original framing).
2. **Real GitHub credentials in CI** — store a PAT or bot account creds as Actions secrets; drive the real OAuth flow headlessly.
3. **Test-mode auth-bypass in production code** — env-gated flag in `src/index.ts` that swaps in a fake auth path when set.
4. **Two-tier: manual real-auth + CI fake-auth via factory swap** — keep the production OAuth wiring intact, extract `buildOAuthProvider(defaultHandler)` so tests can inject a `FakeGitHubHandler` that auto-grants `/authorize`, run the MCP transport assertions inside the Workers pool.

## Decision Outcome

**Chosen option: 4 — Two-tier split via factory swap.**

The CI tier (`test/mcp-e2e.test.js`) drives `/register` → `/authorize` → `/token` → `/mcp initialize` + `tools/list` end-to-end inside the Workers pool. The OAuth `defaultHandler` is the only swappable surface; all other production wiring (`MyMCP.serve`, OAuth-provider endpoints, CORS, KV bindings) runs unmodified.

The manual tier (`scripts/e2e/oauth-e2e.mjs`) covers the surfaces the CI tier deliberately skips — the production `GitHubHandler` (consent UI, CSRF cookie, state binding, upstream GitHub token exchange) and real tool execution against `api.github.com`. Positioned as a pre-release acceptance check, not a routine dev step.

## Pros and Cons of the Options

### Option 1: Manual only

- Good, because zero production code change and zero CI maintenance.
- Bad, because manual = forgotten. The first real run of the harness was during the same PR that added it; without CI there is no signal between releases.
- Bad, because regressions in `registerTool` migration, MCP session handling, or OAuth provider plumbing land silently.

### Option 2: Real GitHub credentials in CI

- Good, because the coverage profile is closest to production reality.
- Bad, because storing a PAT or bot creds in CI introduces a secret-management surface and a credential-rotation cadence the project does not have.
- Bad, because GitHub's bot-detection on the login flow is unpredictable; tests would become flaky over time.
- Bad, because 2FA enforcement on the account would require carve-outs.

### Option 3: Test-mode auth-bypass in production code

- Good, because no factory refactor needed.
- Bad, because production bundle ships an auth-bypass path. Any future misconfiguration (env var set in the wrong place, accidental copy-paste into a prod secret) opens a full-auth bypass.
- Bad, because security-review burden on every change to the gated code.

### Option 4: Two-tier via factory swap

- Good, because production wiring is unchanged — `buildOAuthProvider(handler)` is the same one-line indirection whether `handler` is real or fake.
- Good, because the CI tier catches the regression classes the manual tier was meant to but never reliably did (because it was forgotten).
- Good, because the fake handler is colocated with the test fixtures (`test/_fixtures/`) and cannot be reached from production.
- Good, because the manual tier still exists for the surfaces only it covers (consent UI cookies, real-API formatter fixtures), and its role as "pre-release acceptance" is clearer.
- Neutral, because one extra file in `src/index.ts` (the factory) is exposed as an API.
- Bad, because tool execution against real GitHub still requires the manual tier — a contract change at api.github.com is not caught by CI.

## Consequences

- Positive: every PR now runs the OAuth + MCP transport E2E in ~100ms, automatically. Regressions in `registerTool`, MCP session, or OAuth provider plumbing fail CI.
- Positive: `buildOAuthProvider` is a stable extension point for future test setups (e.g. injecting alternative handlers for permission-gated test scenarios).
- Negative: when the OAuth provider library evolves, the test-worker fixture (`test/_fixtures/test-worker.ts`) needs the same updates as `src/index.ts`. Drift surfaces as test failures, which is the right place to catch it.
- Negative: a tool API contract change at GitHub (e.g. field removal in `repos.get`) still surfaces only at the manual tier.

## Confirmation

- `test/mcp-e2e.test.js` runs in the `Test` CI job; verified passing on PR #35 (commits `0ab1d58`, `5866c3b`).
- `pnpm run e2e:oauth` against `pnpm dev` completes the full real-OAuth flow end-to-end; verified during PR #35.
- `buildOAuthProvider` export is exercised from both production (`src/index.ts` default export) and tests (`test/_fixtures/test-worker.ts`).

## More Information

- Issue #32 — original manual harness scope.
- Issue #34 — follow-up for deduplicating the MCP client shared by the two tiers.
- PR #35 — implementation of both tiers.
