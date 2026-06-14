# Security-scanning Tools — `hide_secret: true` Is the API-Level Secret Guard

## Rule

The GitHub secret-scanning **list** endpoint
(`secretScanning.listAlertsForRepo`) returns the raw detected credential in the
alert's `secret` field by default. Passing **`hide_secret: true`** makes GitHub
omit `secret` from the response entirely, so the live credential never reaches
Worker memory at all.

For `list_secret_scanning_alerts` (and any future secret-scanning tool in
`src/tools/security.ts`), always pass `hide_secret: true`. This is
defence-in-depth **on top of** the renderer never emitting `secret` — the
renderer guard alone still pulls the secret into memory; `hide_secret` stops it
at the API boundary.

## Other security-scanning API facts worth not re-deriving

- **Access level**: the secret-scanning list endpoint requires repo **admin**
  access (or a token with `repo` / `security_events` scope) — *not* mere push
  access. Word tool descriptions accordingly.
- **`code-scanning` `state` filter**: the Octokit parameter type only accepts
  `open` / `dismissed` / `fixed` (it reuses the *response* state enum), so do
  not expose `closed` as a filter value even though the REST docs list it — it
  fails type-check.
- All three alert types render the same lead — `` `#<number>` **<state>** `` —
  via the shared `alertLead(number, state)` helper; keep new alert renderers on
  it so the state-fallback stays uniform.

## How to apply

- Triggered when implementing or editing any secret-scanning tool in
  `src/tools/security.ts` (notably issue #106 Phase 2 detail tools).
- Pass `hide_secret: true` on every secret-scanning list/detail call.
- Verify with the handler-capture live E2E ([[tool-e2e-handler-capture]]): a
  real secret value must never appear in the rendered output.
