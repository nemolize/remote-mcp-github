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
2. **Loopback-only interstitial that navigates immediately** via meta
   refresh (0s) + JS `location.replace`, with the URL visible as a
   fallback; non-loopback keeps the 302.
3. **Loopback-only interstitial that navigates after a visible countdown**
   via JS `location.assign` (no meta refresh), so the fallback URL is
   _seen_ first and Back returns to the interstitial after a connection
   error; non-loopback keeps the 302.
4. **JS-side probe-then-navigate** — attempt `fetch(redirectTo, {mode:
"no-cors"})` or an `<img>` load with a short timeout, only navigate on
   success; leave the fallback UI up on failure.
5. **Interstitial that also displays the registered client name** as a
   phishing signal.

## Decision Outcome

**Chosen option: 3 — loopback-only interstitial with a visible countdown,
navigating via `location.assign`.**

`src/interstitial.ts` holds the loopback detection (`localhost`, `127.0.0.1`,
`[::1]` / raw `::1` only — spec-defined loopback, not RFC1918 or link-local)
and the HTML template. `/callback` branches on `isLoopbackRedirect(redirectTo)`;
any parse failure or non-loopback host falls through to the pre-existing 302
unchanged, preserving the `Set-Cookie` session-cookie clearing on both paths.

The interstitial's PRIMARY content is the redirect URL in a `<code>` block
with a Copy button (`navigator.clipboard.writeText`, feature detected; the
URL stays selectable when unavailable). Below the URL, a nonce'd inline
script counts down `Redirecting in N seconds…` and, when it reaches zero,
navigates via `window.location.assign(target)`. The loopback host:port is
shown prominently (satisfying the MCP spec's display requirement). A
`<noscript>` block provides a plain anchor as a JS-disabled fallback.

Two properties are load-bearing for the failure path (dead loopback listener):

- **`location.assign`, not `location.replace`** — a connection-error page
  from the browser then leaves the interstitial in session history. The
  response uses `Cache-Control: no-store` because it contains a single-use
  authorization code and state. Whether Back restores the page from bfcache
  or re-requests the callback remains browser- and session-state-dependent.
- **Visible countdown, no `<meta http-equiv="refresh">`** — meta refresh
  with a 0-second delay replaces history the same way `location.replace`
  does, and (like an immediate JS nav) triggers before the fallback UI is
  legible. The countdown guarantees the URL has been on-screen for a
  couple of seconds before nav is attempted.

Deduped: `sanitizeText` from `src/workers-oauth-utils.ts` is reused for
HTML escaping (there was a near-identical local helper in an earlier draft;
two copies would silently drift). All embedded data is HTML-escaped in
the body and `<`/`>`/`&`-escaped inside the script literal so `</script>`
inside a hostile payload cannot break out. The CSP is `default-src 'none'`
with per-response nonces on `script-src`/`style-src` and no `unsafe-inline`.

## Pros and Cons of the Options

### Option 1: Keep the bare 302

- Good, because zero code and zero divergence from the reference implementations.
- Bad, because the dead-listener case stays unrecoverable — the exact failure
  users are hitting (issue #174).

### Option 2: Loopback-only interstitial, immediate navigation

- Good, because the happy path is unchanged in practice — the browser starts
  navigating before the page paints.
- Bad, because it does not actually solve the dead-listener case: the
  immediate `<meta refresh>` / `location.replace` re-attempts the failed
  connection within the connection-attempt window (near-instant for a
  refused loopback port), so the browser's `ERR_CONNECTION_REFUSED` page
  replaces the interstitial before the user sees the fallback URL. And
  `location.replace` further removes the interstitial from history, so
  Back doesn't recover it either. Rejected on this ground during review.

### Option 3: Countdown + `location.assign` (chosen)

- Good, because the URL is guaranteed to have been on-screen for the
  countdown period before nav is attempted, so the dead-listener case
  degrades to a page the user can read before navigation.
- Neutral, because `location.assign` preserves session history, but the
  `no-store` policy does not make bfcache behavior portable. Back can restore
  the interstitial or re-request the already-consumed callback depending on
  the browser and session state, so it is not a guaranteed recovery path.
- Good, because scope is minimal: non-loopback clients, `/authorize`, and
  the rest of the handler are untouched.
- Neutral, because it adds roughly `AUTO_REDIRECT_SECONDS` (currently 2s)
  of extra latency to the happy path — the MCP client's listener TTL is
  measured in tens of seconds, so this is well within budget.
- Bad, because it diverges from the Cloudflare demo / sentry-mcp 302
  pattern; future upstream merges need to keep the branch intact.

### Option 4: JS-side probe-then-navigate

- Good in theory: navigate only on a successful probe, leave the
  interstitial visible on failure.
- Bad, because the interstitial is served over HTTPS from the Worker and
  the loopback target is HTTP, so mixed-content policy blocks every probe
  channel uniformly (`fetch` including `mode: "no-cors"`, `<img>`
  loading, XHR). The probe's error becomes indistinguishable between
  "listener dead" and "browser refused to try" — a silent-fail probe
  strands _every_ user, not just the ones the feature exists for.
  Rejected.

### Option 5: Display the registered client name

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

- The dead-listener case presents the URL + Copy button as primary content
  during the visible countdown. `Cache-Control: no-store` deliberately keeps
  the authorization code and state out of browser HTTP caches. It does not
  guarantee bfcache exclusion: browser and session state determine whether
  Back after a connection-error page restores the interstitial or re-requests
  the already-consumed callback. Users can still copy the URL before navigation
  or from the browser's address bar on the connection-error page. The
  `<noscript>` fallback anchor covers the JS-disabled case.
- The happy path costs `AUTO_REDIRECT_SECONDS` (currently 2s) of visible
  interstitial per successful OAuth. If a future MCP client shortens its
  listener TTL below that window this constant may need to shrink.
- It is still unverified whether a real Claude Code loopback listener
  handles a JS-driven navigation exactly as it handles a 302 (it should —
  the browser performs the same GET against the loopback URL — but this
  must be QA'd against a live client before merge).

## Confirmation

- `test/interstitial.test.js` covers loopback detection (positive, negative,
  and unparseable inputs), headers/CSP-nonce wiring, `location.assign`
  navigation with no meta refresh and no `location.replace`, the countdown
  seed matching between DOM and JS, URL-above-countdown ordering (so the
  URL is seen first), the `<noscript>` manual link, host/URL display,
  `Set-Cookie` preservation and empty-string omission, and XSS escaping in
  both the HTML body and the inline script literal.
- The non-loopback 302 path has no end-to-end test: the CI transport E2E
  (ADR 0002) swaps in `FakeGitHubHandler`, so the production `/callback`
  is only reachable via the manual OAuth harness (`pnpm run e2e:oauth`).
  Verify the 302 fall-through there; the unit-level detection tests pin
  the branch condition.

## More Information

- Issue #174 — failure report and design discussion.
- anthropics/claude-code#30543 — listener TTL failure signal (~19s at v2.1.63).
- [MCP spec 2025-11-25 — Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
  (§Open Redirection, §Localhost Redirect URI Risks).
- `docs/decisions/0002-ci-e2e-tiering-via-fake-auth-handler.md` — why the CI
  E2E does not exercise the production `GitHubHandler`.
