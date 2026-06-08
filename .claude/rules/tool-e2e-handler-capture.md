# Tool E2E — Handler-Capture + Live Octokit (No Full-Stack Boot Needed)

## Rule

To verify a tool module (`registerXxxTools` in `src/tools/*.ts`) against the **real
GitHub API** without standing up the full Cloudflare Workers + OAuth stack, drive
the handlers directly through the same registration path the server uses, with a
**live** Octokit injected:

1. Write a throwaway vitest spec, e.g. `test/_verify_<area>_live.test.js` (the
   `_verify_` prefix marks it disposable — delete it after).
2. In it: `captureHandlers()` from `test/_helpers/tools.js`, then
   `registerXxxTools(server, () => new Octokit({ auth: process.env.GITHUB_PERSONAL_ACCESS_TOKEN }))`
   — a **real** network Octokit, not the test stub.
3. `invoke(handlers, "<tool_name>", { owner, repo, ... })` against a repo with real
   data (e.g. `nemolize/remote-mcp-github`, which has both success and failure
   workflow runs). Assert on the rendered Markdown and `console.log` the body so
   the output is observable.
4. Run only that file: `pnpm exec vitest run test/_verify_<area>_live.test.js`.
5. **Delete the spec when done** — it is not part of the suite (it needs network
   + a token and would fail in CI).

This is *not* an import-and-call unit test: `registerXxxTools` is the module's
public registration boundary, and `captureHandlers` invokes the exact handler the
running server registers — only the Octokit factory is swapped for a live one.

## Gotcha — sandboxed `pnpm exec vitest` fails with `listen EPERM`

`@cloudflare/vitest-pool-workers` binds a `127.0.0.1` socket at pool startup, which
the Claude Code sandbox blocks (`Error: listen EPERM: operation not permitted
127.0.0.1`). Run the live spec with `dangerouslyDisableSandbox: true`. (This is the
network-socket axis, unrelated to `.dev.vars` — `secrets.required` does not fix it.)

## Where this sits vs the two-tier ADR

`docs/decisions/0002-ci-e2e-tiering-via-fake-auth-handler.md` defines two tiers: a
CI fake-auth transport E2E (`test/mcp-e2e.test.js`) and a manual full-OAuth harness
(`scripts/e2e/oauth-e2e.mjs`). This handler-capture approach is a **third, lighter
path** — it skips OAuth/transport entirely and exercises just the tool handler →
Octokit → real API output (the "real-GitHub tool-output coverage" the ADR notes is
valuable at release time). Reach for it when verifying a *specific tool's* live
behaviour/output, not the OAuth/transport plumbing the other two tiers cover.

## How to apply

- Triggered when verifying a `src/tools/*.ts` module's real-API behaviour during
  development (e.g. confirming a new tool returns the right Markdown against live
  data) — before relying on the full manual OAuth harness, which is heavier.
- Use a throwaway `test/_verify_*.test.js`, live Octokit via PAT, sandbox-bypassed
  run, then delete the spec.
- For OAuth/consent/transport coverage, use the two ADR-0002 tiers instead.
