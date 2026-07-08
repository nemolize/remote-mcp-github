# Tool E2E — Handler-Capture + Live Octokit (No Full-Stack Boot Needed)

## Rule

To verify a tool module (`registerXxxTools` in `src/tools/*.ts`) against the **real
GitHub API** without standing up the full Cloudflare Workers + OAuth stack, drive
the handlers directly through the same registration path the server uses, with a
**live** Octokit injected. Run it as a **standalone script outside vitest**, not as
a `test/_verify_*.test.js` spec — see the gotcha below for why the vitest route does
not authenticate.

1. Write a throwaway script, e.g. `scripts/_verify_<area>_live.mjs` (the `_verify_`
   prefix marks it disposable — delete it after).
2. In it: build the handler map inline (`const h = new Map(); registerXxxTools({
   registerTool: (n, _c, fn) => h.set(n, fn) }, () => new Octokit({ auth:
   process.env.GITHUB_PERSONAL_ACCESS_TOKEN }))`) — a **real** network Octokit, not
   the test stub. (`captureHandlers` from `test/_helpers/tools.js` pulls in vitest's
   `expect`, so inline the 3-line capture instead of importing it into a plain
   script.)
3. Invoke a handler against a repo with real data (e.g. `nemolize/remote-mcp-github`,
   which has both success and failure workflow runs), and assert / `console.log` the
   rendered Markdown so the output is observable.
4. Run it with `pnpm dlx tsx scripts/_verify_<area>_live.mjs` (tsx resolves the
   `.js`-extension imports inside the `.ts` source). `node --experimental-strip-types`
   does **not** work — it does not remap `.js`→`.ts` specifiers, so the import of
   `../src/mcp/response.js` fails with `ERR_MODULE_NOT_FOUND`.
5. **Delete the script when done** — it needs network + a token and is not part of
   the suite.

This is *not* an import-and-call unit test: `registerXxxTools` is the module's
public registration boundary, and the inline capture invokes the exact handler the
running server registers — only the Octokit factory is swapped for a live one.

### Verifying a write (mutating) tool — use the error path

For write tools (`rerun_*`, `cancel_workflow_run`, `trigger_workflow_dispatch`, …)
a real mutation against this repo is unsafe (a dispatch on `deploy.yml` is a real
production deploy; a cancel disrupts live CI). Verify the **live binding** via the
error path instead — it exercises the real Octokit method, endpoint, request body,
and `wrapTool` error surfacing with **no side effect**:

- `cancel_workflow_run` on an already-**completed** run → real `409 Cannot cancel a
  workflow run that is completed`.
- `trigger_workflow_dispatch` on `ci.yml` (which has **no** `workflow_dispatch`
  trigger) → real `422 Workflow does not have 'workflow_dispatch' trigger`.

The error path proves the live binding but never the **success** path (response
rendering, audit log, multi-tool chaining). When that matters, run the same
handler-capture script against a **throwaway PR in a disposable private repo**
(`nemolize/dotfiles`; no auto-deploy on PR), perform the real mutations, then
close the PR + delete the branch. Caveat: a self-authored PR can't be `APPROVE`d —
use `COMMENT` for the success path, keep `APPROVE` on the error path (it returns a
real `422 Can not approve your own pull request`, exercising the review path).

### A "round-trip" must exercise every mutation BRANCH, not one happy path

When a tool exposes **multiple mutation sub-paths inside one entry point** (e.g.
`update_gist` can add / replace / rename / **delete** a file; `update_issue` can
change state / labels / assignees independently), running ONE round-trip through
ONE sub-path and declaring "verified" misses the others. Wire shapes for sibling sub-paths can be
**different** (and one of them can be broken) even when the entry point and SDK
binding are the same — gist file deletion is the canonical case here: the SDK's
"set the entry to `null`" path works, but `{ content: null }` returns
`422 "data cannot be null"`. A single content-update round-trip never touches
the delete branch.

Before declaring a mutation tool's live-verify done:

1. **Enumerate the sub-paths** from the input schema. List add / replace / rename
   / delete / mixed / invalid-input combinations the tool accepts.
2. **Exercise each sub-path against the real API** in the verify script — for
   destructive sub-paths, use a freshly-created throwaway resource.
3. **Probe post-state**, don't trust the rendered response — re-list / re-fetch
   and assert what *actually* changed (`Object.keys(files).length` shrunk, the
   label list dropped the expected name, the state reads `closed`). A no-op
   request often still returns 200 with unchanged state — Markdown rendering
   alone is not proof.
4. If a sub-path is **genuinely unsafe** to exercise live (would mutate prod
   state), say so explicitly and lock the wire shape in a unit test instead, so
   the unverified surface is visible rather than implicit.

Tells that a "happy round-trip" is hiding gaps: the verify script's call graph
shows only one path through the tool; the rendered output is the *only*
assertion (no post-state probe); the tool's docstring describes a sub-path the
script never invokes.

Sibling axis: cross-model review (`/team-review` codex layer) and Copilot's
inline review have caught this class of gap when the script missed it — treat
those reviewer signals as a backstop, but the cheap fix is the branch-matrix
enumeration at design time, not waiting for review to flag the missed path.

## Discovery-chain check — a write tool's ID params must be producible by sibling read tools

A write tool taking an opaque ID (`field_id` / `item_id` / `content_id` / any
GraphQL node ID) carries an implicit contract: some sibling read tool must
RENDER that ID in its Markdown output, or the write tool is unreachable through
the tool suite alone. Per-tool live E2E can't see this — each tool passes in
isolation when the ID is obtained out-of-band (`gh api`, browser), so the gap
is silent (PR #178: 8/8 live PASS while 4 write tools required IDs no read tool
surfaced; caught only by cross-model review).

Before merging a write tool that consumes an ID:

1. Enumerate every ID param from its input schema.
2. For each, grep the sibling read tools' renderers and confirm the ID appears
   in the **emitted Markdown** — present in the fetched GraphQL data is not enough.
3. A tool description claiming "obtain via `<read_tool>`" is a fact claim —
   verify against that renderer before shipping (same discipline as the
   capability-claim check in user-rules-mem `pr-description-scope`).
4. Strongest form: chain the verify script — feed the write step ONLY IDs
   parsed from a read tool's rendered output, so the discovery path is the
   thing under test.

## Adding a write tool — register it in the audit-log coverage matrix

`test/audit-log.test.js` holds an **exhaustive** `WRITE_TOOLS` table driving the
"every write tool emits exactly one audit line tagged with its own name" test
(read tools are intentionally absent — they must NOT emit an audit line). When
you add a new **write** tool, you must:

1. Add the tool's `[registerXxxTools, "tool_name", { …minimal params… }]` row to
   `WRITE_TOOLS`.
2. Add any Octokit method the tool calls to the `wideOctokit()` stub, returning a
   response shaped so the tool's `logWrite(...)` resolves `owner`/`repo`. If the
   tool derives those from the API response (e.g. `data.owner?.login`,
   `data.name`) rather than the input args, the stub must return
   `{ owner: { login: "o" }, name: "r" }` so the table's
   `toMatchObject({ owner: "o", repo: "r" })` assertion passes.

Skipping this leaves the new mutation without audit-log regression coverage —
the table won't fail (it only iterates rows it has), so the gap is silent. (codex
flagged exactly this miss on the `create_repository`/`fork_repository` PR #111.)
Also add the tool to the `test/mcp-e2e.test.js` transport spot-check list so a
"stopped registering over the wire" regression is caught.

## Gotcha — the Workers vitest pool does NOT expose `process.env` to the isolate

This repo's `vitest.config.mts` runs **every** spec in `@cloudflare/vitest-pool-workers`,
and the Workers isolate's `process.env` is **not** Node's process env — a handler doing
`new Octokit({ auth: process.env.GITHUB_PERSONAL_ACCESS_TOKEN })` gets `undefined` inside
the pool, so live calls fail with `401 Requires authentication`. Neither a shell-exported
PAT, adding the PAT to `secrets.required` in `wrangler.jsonc`, `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`,
nor a temporary `.dev.vars` fixes it (`.dev.vars` maps to the Worker `env` binding, not
`process.env`). That is why a live-PAT verification must run as a **standalone script**
(step 4 above), where Node's real `process.env` carries the token — not as a vitest spec.

(A `_verify_*.test.js` that uses only **stubbed** Octokit still works fine in the pool —
the limitation is specifically the *live-PAT* path. A sandboxed `pnpm exec vitest` also
hits a separate `listen EPERM` on the pool's `127.0.0.1` bind; run with
`dangerouslyDisableSandbox: true`. That socket axis is unrelated to `.dev.vars` /
`secrets.required`.)

## Gotcha — direct handler invocation bypasses Zod defaults

The inline capture calls handlers directly, skipping the MCP SDK's Zod parse —
so schema `.default(...)` values (e.g. `per_page: 30`) never apply and the
handler sees `undefined` (GraphQL rejects: `Variable $first of type Int! was
provided invalid value`). Not a tool bug. Pass every defaulted param explicitly
in `scripts/_verify_*.mjs`, matching the unit-test convention. A first verify
run reporting ALL tools failing with an invalid-variable shape → suspect the
script's missing params before the tools.

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
- Use a throwaway **standalone** `scripts/_verify_*.mjs` (live Octokit via PAT from
  Node's `process.env`), run with `pnpm dlx tsx`, then delete it. Do **not** use a
  `test/_verify_*.test.js` spec for the *live-PAT* path — the Workers vitest pool
  isolate has no `process.env` PAT, so it 401s (see the gotcha above).
- For a **write** tool, verify the live binding via the error path (completed-run
  `409`, no-trigger-workflow `422`) rather than performing a real mutation.
- For OAuth/consent/transport coverage, use the two ADR-0002 tiers instead.
