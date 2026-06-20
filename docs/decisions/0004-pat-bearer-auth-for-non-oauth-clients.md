---
status: accepted
date: 2026-06-20
decision-makers: nemolize
consulted: multi-agent reasoning team (Claude/opus) + cross-model challenge (Codex)
informed: future contributors via this ADR
---

# GitHub-PAT Bearer auth for non-OAuth MCP clients

## Context and Problem Statement

The server authenticates **only** via the full OAuth 2.1 / PKCE browser-consent flow that `@cloudflare/workers-oauth-provider` wraps around `/mcp` and `/sse`. Some MCP clients cannot perform an OAuth consent flow — the **Codex desktop** "Streaming HTTP" custom-MCP form offers only a URL field and a Bearer-token env-var field (plus static headers), with no OAuth "Connect / authorize" affordance. There is therefore no way to connect this server to such a client today (issue #128).

We want to accept `Authorization: Bearer <GitHub PAT>` directly for Bearer-only clients.

## Decision Drivers

- The immediate driver (Codex desktop) can send **only** a URL + a `Authorization: Bearer` value — no custom request headers, no consent UI.
- **The server is a public demo**: each caller authenticates as themselves and operates only within their own GitHub permissions. This is the stance that decides the access-control questions below.
- **Symmetry with the existing OAuth path.** The OAuth path applies **no `login` allowlist** today — anyone with a GitHub account can complete the flow and act as themselves (`src/github-handler.ts` `/callback` reads `login` but does not gate on it). A PAT path should match that posture, not be held to a stricter (and asymmetric) standard.
- Minimise new surface area and avoid forking on undocumented library internals.
- OAuth flow must be unchanged (existing E2E must still pass).

## Considered Options

### Wiring

#### A. `resolveExternalToken` hook + a dedicated `/pat/*` mount (chosen)

`@cloudflare/workers-oauth-provider` v0.8.0 exposes a documented `resolveExternalToken?: (input: { token, request, env }) => Promise<{ props } | null>` option (`.d.ts:607`; runtime `oauth-provider.js:2047/2069/2089/2097`). It fires **only on a KV-miss** (an `Authorization: Bearer` value that is not one of the provider's own issued session tokens). Returning `{ props }` makes OAuthProvider itself set `ctx.props` and dispatch the **same** apiHandler — the same `MyMCP.serve(...)` mount, the same `corsOptions`. Returning `null` → `401 invalid_token`.

A dedicated `/pat/mcp` (+ `/pat/sse`) apiHandler mount, with `resolveExternalToken` returning `props` only when the request pathname is on that PAT route. The PAT lands in `props.accessToken` exactly where the OAuth token does today, so the tool layer is untouched.

#### B. `resolveExternalToken` hook on the existing `/mcp`, prefix-sniff discriminator

Same hook, but no separate route: a Bearer on `/mcp` whose value starts with `ghp_` / `github_pat_` (or carries an `X-Auth-Mode: pat` header) is treated as a PAT; everything else falls through to OAuth.

#### C. Hand-written outer `fetch` wrapping `buildOAuthProvider` + a second McpAgent mount

A top-level `fetch` inspects the Bearer, and on the PAT path constructs `Props` and invokes a separately-mounted `MyMCP.serve` with `ctx.props` set manually (`Object.assign(ctx, { props })`).

### Access control (who may use the PAT path)

#### P1. Symmetric / unrestricted — PAT path always on, no allowlist (chosen)

The PAT path is always mounted and accepts any valid GitHub PAT, exactly mirroring the OAuth path's "anyone, acting as themselves" posture.

#### P2. `ALLOW_PAT_AUTH` feature flag, default off

The `/pat/*` mount and the hook are wired only when an env var is `"true"`, so a deploy must opt in.

#### P3. GitHub-login allowlist (`ALLOWED_GITHUB_LOGINS`, `GET /user` check)

Restrict the PAT path to specific GitHub identities by resolving the PAT owner's `login` and checking an allowlist; fail-closed when empty.

#### P4. Pre-shared secret header / Cloudflare Access service token

Gate reachability with a second credential (a static `X-*` header, or a Cloudflare Access service token at the edge).

## Decision Outcome

**Wiring: A** — the package-native `resolveExternalToken` hook + a dedicated `/pat/*` mount, because it is the package-native seam (CORS and props injection are handled by the existing OAuth wiring, not reimplemented), it fits the actual Bearer-only client (give the client a different URL — no custom header needed), and it keeps the PAT path on its own route.

**Access control: P1 (symmetric / unrestricted)** — the PAT path is always on and applies no allowlist, mirroring the OAuth path exactly.

### Why no restriction (the key reasoning)

The instinct to guard the PAT path harder than OAuth does not survive the public-demo threat model:

- **"Open relay" is not a real threat here.** A third party using _their own_ PAT (or _their own_ OAuth) acts only under _their own_ GitHub identity — no other user's resources are reachable. The only cost is the owner's Worker free-tier consumption, which is accepted when publishing a public demo.
- **Restricting only the PAT path would be asymmetric and pointless.** The OAuth path already lets anyone in (no `login` allowlist). An allowlist or secret-header gate on just the PAT path would not raise the security floor — an attacker would simply use the OAuth path. Any real access restriction must be **cross-cutting** (applied to both paths where `login` is known), which is a separate decision tracked in issue #129, not part of enabling PAT auth.
- **OAuth's consent screen is not access control.** It obtains _consent_, not _authorization of a specific identity_ — and GUI-capable AI agents erode even its friction value. So "OAuth has a consent UI" is not a reason to hold the PAT path to a higher bar.

### Why not P2 (feature flag)

An earlier revision of this ADR gated the PAT path behind `ALLOW_PAT_AUTH` (default off) to make the public deploy "structurally OAuth-only". That rationale assumed the PAT path was riskier than OAuth. Under the symmetric public-demo model it is not, so the flag adds configuration surface and an asymmetry with the always-on OAuth path for no security gain. Dropped.

### Why not P3 / P4 (allowlist / secret / Cloudflare Access)

These restrict _who_ may use the server. They belong to the cross-cutting access-control question (issue #129), which — if ever adopted — must apply to **both** auth paths to be meaningful. In particular, Cloudflare Access was rejected for this deploy: a service token's headers collide with the GitHub PAT's `Authorization: Bearer`, `*.workers.dev` needs a custom domain to sit behind Access, and edge enforcement is disproportionate for a single-Worker public demo.

### Why not B (prefix-sniff on `/mcp`) / C (hand-written wrapper)

- **B**: the `X-Auth-Mode: pat` half of the discriminator is unusable — the CORS allow-list is `Content-Type, Authorization, mcp-protocol-version` (`src/index.ts`), so a custom header is stripped on preflight, and Codex desktop cannot send custom headers anyway. Prefix-sniff alone misroutes a pasted `gho_`/`ghu_` OAuth token and widens the surface by offering every OAuth KV-miss to the PAT path.
- **C**: reimplements what `resolveExternalToken` does natively (`ctx.props = ext.props` at `oauth-provider.js:2089`), forking on a library-owned contract with a real risk of CORS / session-continuity regressions on the PAT path.

### Resolved sub-decisions

- **Routing**: the request **path** (`/pat/*`), not a header or a token prefix. No custom header required.
- **Token custody**: the PAT lives only in `props.accessToken` (in-memory, per-DO-session), exactly like today's OAuth token. The Worker persists nothing new. The README documents that the PAT transits in the `Authorization` header per request and that custody shifts to the client (rotate / revoke via GitHub).
- **No per-request `GET /user`**: tools read only `props.accessToken` (verified — `login` / `name` / `email` are unused by any tool). The PAT path sets `props = { accessToken: <PAT>, login: "", name: "", email: "" }` with no network call. Validity is established by use (the first tool call's GitHub `401` / `403`).
- **Scope discipline**: validate-by-use; the README states the PAT needs `repo` + `read:user`. No upfront scope enumeration or hard-reject.
- **Secret hygiene**: the PAT must never enter `console.*`, an error string, or the audit log. In particular, do not replicate the `console.log(await resp.text())` shape at `src/utils.ts:112` on the PAT path. This preserves the repo's existing `hide_secret: true` discipline. (Tracked alongside the other hardening candidates in issue #129.)

## Consequences

- Good: Bearer-only clients (Codex desktop) can connect; the change is purely additive and the OAuth path is byte-for-byte unchanged.
- Good: the two auth paths are symmetric — no special-casing, no flag, no asymmetric restriction that would be trivially bypassable via OAuth.
- Good: stateless PAT path enables trivial token rotation (the client swaps its env var; no KV session to invalidate).
- Neutral: the README / Codex setup instructions document a **distinct** PAT URL (`/pat/mcp`) rather than the canonical `/mcp`. This deviates from issue #128's original sketch (Bearer on `/mcp`), but is the deliberate consequence of fitting the header-less client and keeping the PAT path on its own route.
- Negative: a public-demo server accepts a PAT from any caller (acting as themselves). This is an accepted property of the public-demo model, not a regression vs the already-open OAuth path. Restricting access (and bounding free-tier abuse) is deferred to issue #129.
- Negative: validate-by-use means an invalid / under-scoped PAT is reported only at first tool execution, not at connect time. Accepted: the caller is acting as themselves, so a fail-fast-on-use error is sufficient feedback.

## Confirmation

- New test exercises the `/pat/mcp` route with a fake `resolveExternalToken` (injected through an extended `buildOAuthProvider` signature) returning sentinel props for a PAT Bearer, and asserts an **actual tool call** (not merely `tools/list`, which only enumerates registered tools and makes no GitHub request) succeeds with the PAT and **no** OAuth dance — confirming the `Authorization` token is threaded through to the Octokit client.
- A test confirms the canonical `/mcp` route still rejects an unknown Bearer with `401` (the PAT resolver accepts only on `/pat/*`).
- The existing OAuth transport E2E (`test/mcp-e2e.test.js`) still passes unchanged.
- `pnpm type-check` / `pnpm lint` / `pnpm test` pass.

## More Information

- Issue #128.
- Cross-cutting access control and PAT-path secret hygiene are tracked separately in issue #129 (deferred hardening; must apply to both auth paths if adopted).
- Builds on the two-tier E2E approach in [ADR-0002](0002-ci-e2e-tiering-via-fake-auth-handler.md); this adds a third, even lighter auth path that the fake-auth seam can cover.
- Library hook: `@cloudflare/workers-oauth-provider` v0.8.0 `resolveExternalToken` (`ResolveExternalTokenInput` / `ResolveExternalTokenResult`, `oauth-provider.d.ts:441-470`, exported at `:607`).
- Codex desktop "Streaming HTTP" custom-MCP form exposes URL + Bearer-token-env-var + static headers only (no OAuth consent UI, no per-request custom-header control) — verified 2026-06-20.

## History

- 2026-06-20 (initial, `proposed`): chose wiring A but gated the PAT path behind `ALLOW_PAT_AUTH` (default off) with the public deploy "structurally OAuth-only", on the assumption the PAT path was riskier than OAuth.
- 2026-06-20 (this revision, `accepted`): on review, the OAuth path was found to apply no `login` allowlist either, so gating only the PAT path was asymmetric and bypassable. Under the public-demo threat model the "open relay" worry is not a real threat (callers act only as themselves). Dropped the `ALLOW_PAT_AUTH` flag; the PAT path is now always-on and symmetric with OAuth. Any real access restriction is cross-cutting and deferred to issue #129.
