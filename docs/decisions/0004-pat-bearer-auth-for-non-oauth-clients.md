---
status: proposed
date: 2026-06-20
decision-makers: nemolize
consulted: multi-agent reasoning team (Claude/opus) + cross-model challenge (Codex)
informed: future contributors via this ADR
---

# GitHub-PAT Bearer auth for non-OAuth MCP clients

## Context and Problem Statement

The server authenticates **only** via the full OAuth 2.1 / PKCE browser-consent flow that `@cloudflare/workers-oauth-provider` wraps around `/mcp` and `/sse`. Some MCP clients cannot perform an OAuth consent flow — the **Codex desktop** "Streaming HTTP" custom-MCP form offers only a URL field and a Bearer-token env-var field (plus static headers), with no OAuth "Connect / authorize" affordance. There is therefore no way to connect this server to such a client today (issue #128).

We want to accept `Authorization: Bearer <GitHub PAT>` directly for Bearer-only clients, while keeping OAuth as the default and the public instance OAuth-only.

## Decision Drivers

- The immediate driver (Codex desktop) can send **only** a URL + a `Authorization: Bearer` value — no custom request headers, no consent UI.
- The server's security posture: every call runs under the user's own GitHub identity; the token is minted + encrypted in KV and never sent by the client. A PAT path changes the custody model (client holds a long-lived, possibly broad-scope credential and sends it per request), so the blast radius of enabling it must be bounded.
- The server ships **write** tools (issues / PRs / releases / files / branches / actions). A `repo`-scoped PAT grants real production write, so the gating must be defence-in-depth, not a single in-band flag.
- Minimise new surface area and avoid forking on undocumented library internals.
- OAuth flow must be unchanged when no PAT is presented (existing E2E must still pass).

## Considered Options

### A. `resolveExternalToken` hook + a dedicated `/pat/*` mount (chosen)

`@cloudflare/workers-oauth-provider` v0.8.0 exposes a documented `resolveExternalToken?: (input: { token, request, env }) => Promise<{ props } | null>` option (`.d.ts:607`; runtime `oauth-provider.js:2047/2069/2089/2097`). It fires **only on a KV-miss** (an `Authorization: Bearer` value that is not one of the provider's own issued session tokens). Returning `{ props }` makes OAuthProvider itself set `ctx.props` and dispatch the **same** apiHandler — the same `MyMCP.serve(...)` mount, the same `corsOptions`. Returning `null` → `401 invalid_token`.

Add a dedicated `/pat/mcp` (+ `/pat/sse`) apiHandler mount **only when `ALLOW_PAT_AUTH === "true"`**, and have `resolveExternalToken` return `props` only when the request pathname is on that PAT route. The PAT lands in `props.accessToken` exactly where the OAuth token does today, so the tool layer is untouched.

### B. `resolveExternalToken` hook on the existing `/mcp`, prefix-sniff discriminator

Same hook, but no separate route: a Bearer on `/mcp` whose value starts with `ghp_` / `github_pat_` (or carries an `X-Auth-Mode: pat` header) is treated as a PAT; everything else falls through to OAuth.

### C. Hand-written outer `fetch` wrapping `buildOAuthProvider` + a second McpAgent mount

A top-level `fetch` inspects the Bearer, and on the PAT path constructs `Props` and invokes a separately-mounted `MyMCP.serve` with `ctx.props` set manually (`Object.assign(ctx, { props })`).

## Decision Outcome

Chosen option: **A — `resolveExternalToken` hook + a dedicated `/pat/*` mount**, because it is the package-native seam (so CORS and props injection are handled by the existing OAuth wiring, not reimplemented), it fits the actual Bearer-only client (give Codex a different URL — no custom header needed), and it bounds the PAT-resolution blast radius to a route that exists only when explicitly enabled.

### Why not B (prefix-sniff on `/mcp`)

- The `X-Auth-Mode: pat` half of the discriminator is **unusable**: the existing CORS allow-list is `Content-Type, Authorization, mcp-protocol-version` (`src/index.ts:28`), so a custom header is stripped on preflight, and the immediate driver (Codex desktop) cannot send custom headers at all.
- Prefix-sniff alone is a fragile discriminator: a user who pastes a GitHub OAuth user token (`gho_` / `ghu_`) matches neither prefix and falls through to OAuth with a confusing `401`. Routing PAT resolution across the _canonical_ `/mcp` also means every OAuth KV-miss is offered to the PAT path — a wider surface than necessary.

### Why not C (hand-written wrapper)

- It reimplements what `resolveExternalToken` does natively (`ctx.props = ext.props` at `oauth-provider.js:2089`). Mounting a second McpAgent and setting `ctx.props` by hand forks on a contract the library already owns, with a real risk of CORS / session-continuity regressions on the PAT path while the OAuth path keeps working — an asymmetric, hard-to-spot bug.

### Resolved sub-decisions

- **Discriminator / routing**: the request **path** (`/pat/*`), not a header or a token prefix. No custom header required — the Bearer-only client just points at the PAT URL.
- **Token custody**: the PAT lives only in `props.accessToken` (in-memory, per-DO-session), exactly like today's OAuth token. The Worker persists nothing new. The README documents that the PAT transits in the `Authorization` header per request and that custody shifts to the client (rotate / revoke via GitHub).
- **Scope discipline**: validate-by-use — the first tool call's GitHub `401` / `403` surfaces an invalid or under-scoped PAT naturally. No upfront scope enumeration or hard-reject (classic scope strings drift; fine-grained PATs don't populate `X-OAuth-Scopes` the classic way). The README states the PAT needs `repo` + `read:user`.
- **No per-request `GET /user`**: tools read only `props.accessToken` (verified — `login` / `name` / `email` are unused by any tool; they only fed the OAuth metadata label). The PAT path sets `props = { accessToken: <PAT>, login: "", name: "", email: "" }` with no network call.
- **Gating**: `ALLOW_PAT_AUTH` env var, default off (absent = off). Because the `/pat/*` mount and the `resolveExternalToken` option are wired **only** when the flag is `"true"`, the canonical / public deploy is **structurally** incapable of PAT auth (the route and the hook literally do not exist there), not merely flag-gated in-band.
- **Secret hygiene**: the PAT must never enter `console.*`, an error string, or the audit log. In particular, do not replicate the `console.log(await resp.text())` shape at `src/utils.ts:112` on the PAT path. This preserves the repo's existing `hide_secret: true` discipline.

## Consequences

- Good: Bearer-only clients (Codex desktop) can connect; the change is purely additive and the OAuth path is byte-for-byte unchanged.
- Good: the public instance cannot be turned into a broad-scope credential relay by a single in-band misconfiguration — PAT auth is absent unless the deploy explicitly opts in.
- Good: stateless PAT path enables trivial token rotation (swap the client's env var; no KV session to invalidate).
- Neutral: the README / Codex setup instructions document a **distinct** PAT URL (`/pat/mcp`) rather than the canonical `/mcp`. This deviates from issue #128's original sketch (Bearer on `/mcp`), but is the deliberate consequence of fitting the header-less client and bounding the surface.
- Negative: a second auth path widens the test matrix. Mitigated by the test approach below.
- Negative: validate-by-use means an invalid / under-scoped PAT is reported only at first tool execution, not at connect time. Accepted: the operator pasted their own token into their own self-hosted instance, so a fail-fast-on-use error is sufficient feedback.

## Confirmation

- New test exercises the `/pat/mcp` route with a fake `resolveExternalToken` (injected through an extended `buildOAuthProvider` signature) returning sentinel props for a PAT Bearer, and asserts an **actual tool call** (not merely `tools/list`, which only enumerates registered tools and makes no GitHub request) succeeds with the PAT and **no** OAuth dance — confirming the `Authorization` token is threaded through to the Octokit client.
- A second test asserts that with `ALLOW_PAT_AUTH` off, the same PAT request does not authenticate (falls to the OAuth path / `401`).
- A test (or stub assertion) confirms no PAT fragment appears in any error surface returned to the client.
- The existing OAuth transport E2E (`test/mcp-e2e.test.js`) still passes unchanged.
- `pnpm type-check` / `pnpm lint` / `pnpm test` pass.

## More Information

- Issue #128.
- Builds on the two-tier E2E approach in [ADR-0002](0002-ci-e2e-tiering-via-fake-auth-handler.md); this adds a third, even lighter auth path that the fake-auth seam can cover.
- Library hook: `@cloudflare/workers-oauth-provider` v0.8.0 `resolveExternalToken` (`ResolveExternalTokenInput` / `ResolveExternalTokenResult`, `oauth-provider.d.ts:441-470`, exported at `:607`).
- Codex desktop "Streaming HTTP" custom-MCP form exposes URL + Bearer-token-env-var + static headers only (no OAuth consent UI, no per-request custom-header control) — verified 2026-06-20.
