---
status: accepted
date: 2026-07-08
decision-makers: nemolize
consulted: none
informed: future contributors via this ADR
---

# Interstitial OAuth callback for loopback redirect URIs

## Context and Problem Statement

The `/callback` endpoint (`src/github-handler.ts`) used to end every successful
authorization with a bare 302 to the client's `redirectTo`. MCP clients
typically register a loopback redirect URI (`http://localhost:<ephemeral-port>/...`)
and run a short-lived local listener to catch it. When that listener has
already exited — Claude Code's listener TTL was measured at roughly 19 seconds
at v2.1.63 (current behaviour unverified; see
anthropics/claude-code#30543) — the 302 lands the user on a browser
connection-error page with no recovery path: the authorization code is in the
URL bar of a dead navigation, and the user has no idea what to do with it.
Issue #174 tracks this failure signal.

The MCP spec (2025-11-25) frames the relevant constraints in
[Authorization — Security Considerations](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization):

- **§Open Redirection** — servers must not become open redirectors; redirect
  targets must be validated against registered URIs (the OAuth provider
  library already enforces this; this change adds no new redirect surface).
- **§Localhost Redirect URI Risks** — loopback redirects are inherently
  racy/spoofable, and the server "MAY inform the user" about where they are
  being redirected. It also says the server "MUST clearly display the
  redirect URI hostname" when informing the user about a loopback redirect.

The question: how should `/callback` respond so the dead-listener case is
recoverable, without changing behaviour for non-loopback clients?

## Decision Drivers

- The dead-listener failure is unrecoverable today; the fix must leave the
  user a visible, copyable URL.
- The happy path (listener alive) must stay effectively instant — no visible
  page flash worth noticing, no extra clicks.
- Non-loopback (regular web) clients have no dead-listener problem; changing
  their flow adds risk for no benefit.
- The interstitial embeds a user/client-controlled URL into HTML — XSS
  hardening (escaping + strict CSP) is mandatory.
- The MCP spec explicitly sanctions informing the user on loopback redirects
  ("MAY inform the user", "MUST clearly display the redirect URI hostname"),
  so the interstitial is spec-aligned, not a deviation.

## Considered Options

1. **Keep the bare 302** (status quo; matches the Cloudflare demo and Sentry's
   sentry-mcp reference implementations).
2. **Interstitial for loopback `redirectTo` only** — meta refresh (0s) + JS
   `location.replace`, with the URL visible and copyable as the fallback body;
   non-loopback keeps the 302.
3. **Interstitial with a ~500ms delay** before navigating, so the user briefly
   sees the page even on the happy path.
4. **Interstitial that also displays the registered client name** as a
   phishing signal.

## Decision Outcome

**Chosen option: 2 — loopback-only interstitial, immediate navigation.**

`src/interstitial.ts` holds the loopback detection (`localhost`, `127.0.0.1`,
`[::1]` / raw `::1` only — spec-defined loopback, not RFC1918 or link-local)
and the HTML template. `/callback` branches on `isLoopbackRedirect(redirectTo)`;
any parse failure or non-loopback host falls through to the pre-existing 302
unchanged, preserving the `Set-Cookie` session-cookie clearing on both paths.

The interstitial navigates immediately via `<meta http-equiv="refresh"
content="0;url=...">` plus a nonce'd inline `window.location.replace(...)`
(belt and suspenders). The body shows the loopback host:port prominently
(satisfying the spec's display requirement), the full redirect URL in a
`<code>` block, and a Copy button (`navigator.clipboard.writeText`, feature
detected; the URL stays selectable when unavailable). All embedded data is
HTML-escaped in the body and `<`-escaped inside the script literal; the
CSP is `default-src 'none'` with per-response nonces and no `unsafe-inline`.

## Pros and Cons of the Options

### Option 1: Keep the bare 302

- Good, because zero code and zero divergence from the reference implementations.
- Bad, because the dead-listener case stays unrecoverable — the exact failure
  users are hitting (issue #174).

### Option 2: Loopback-only interstitial, immediate navigation

- Good, because the happy path is unchanged in practice — the browser starts
  navigating before the page paints.
- Good, because the failure path leaves a self-service recovery UX (visible
  host, copyable URL).
- Good, because scope is minimal: non-loopback clients, `/authorize`, and the
  rest of the handler are untouched.
- Bad, because it diverges from the Cloudflare demo / sentry-mcp 302 pattern —
  future upstream merges need to keep the branch intact.

### Option 3: 500ms delay before navigating

- Good, because the user is guaranteed to glimpse the page.
- Bad, because on the happy path it buys nothing but a page flash — the
  listener catches the redirect either way, and the glimpse is too short to
  read. Rejected.

### Option 4: Display the registered client name

- Good in theory as a phishing signal.
- Bad, because it requires a per-callback KV lookup for a weak signal: the
  DCR-registered `clientName` is attacker-controlled, so it authenticates
  nothing. Rejected.

## Consequences

- Positive: a dead local listener now degrades to a readable page with the
  URL and a Copy button instead of a browser error page.
- Positive: loopback users see the redirect host:port before navigation, per
  the MCP spec's display requirement.
- Negative: divergence from the upstream Cloudflare demo and sentry-mcp
  reference pattern (both plain 302) — carry the branch when syncing.
- Negative: the interstitial is new HTML surface; its XSS posture is locked
  by tests (`test/interstitial.test.js`) and the strict CSP.

## Residual Risk

It is unverified whether a real Claude Code loopback listener transparently
handles the meta-refresh / JS navigation exactly as it handles a 302 (it
should — the browser performs the same GET against the loopback URL — but
this must be QA'd against a live client before merge).

## Confirmation

- `test/interstitial.test.js` covers loopback detection (positive, negative,
  and unparseable inputs), headers/CSP-nonce wiring, meta-refresh + JS
  navigation, host/URL display, `Set-Cookie` preservation, and XSS escaping.
- The non-loopback 302 path has no end-to-end test: the CI transport E2E
  (ADR 0002) swaps in `FakeGitHubHandler`, so the production `/callback` is
  only reachable via the manual OAuth harness (`pnpm run e2e:oauth`). Verify
  the 302 fall-through there; the unit-level detection tests pin the branch
  condition.

## More Information

- Issue #174 — failure report and design discussion.
- anthropics/claude-code#30543 — listener TTL failure signal (~19s at v2.1.63).
- [MCP spec 2025-11-25 — Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
  (§Open Redirection, §Localhost Redirect URI Risks).
- `docs/decisions/0002-ci-e2e-tiering-via-fake-auth-handler.md` — why the CI
  E2E does not exercise the production `GitHubHandler`.
