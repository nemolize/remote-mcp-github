# remote-mcp-github

A Claude.ai-ready remote MCP server that exposes GitHub as a custom connector, deployed to Cloudflare Workers.

Connect this server in `Claude.ai → Settings → Connectors → Add custom connector` and Claude can list/search/inspect your repositories, read files, fetch PR diffs, and (with `repo` scope) create issues, comment, and branch — all under the user's own GitHub identity via standard OAuth 2.1 / PKCE.

> A public instance maintained by the author is deployed at `https://remote-mcp-github.nemolize.workers.dev`. It is offered on a best-effort basis with no uptime or quota guarantees; self-host (the steps below) for anything you depend on.

## Why this server

Several GitHub MCP servers exist, alongside GitHub's own `gh` CLI. This server's niche: responses are **curated and bounded for an LLM consumer** — each tool returns the fields that matter and truncates large payloads (diffs, file contents) at the boundary, so a single response can't overrun the model's context window — and every call runs under the user's own GitHub OAuth identity. (Output is serialized as Markdown rather than JSON; that is a deliberate format trade-off, not a strict win — see **Differentiators** below.)

The table below compares coverage by **feature area** against the two most common alternatives. It stays deliberately coarse-grained — the [tool table](#whats-included) is the source of truth for which tools exist right now, and `gh`'s coverage is documented in the [GitHub CLI manual](https://cli.github.com/manual/). Legend: ✅ first-class · ⚠️ only via a lower-level escape hatch (`gh api`, local `git`) · ❌ absent.

| Feature area                                                  | This server                                                                   | Official `mcp__github__*` | `gh` CLI                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------- | -------------------------------- |
| Repo metadata & discovery                                     | ✅                                                                            | ✅                        | ✅                               |
| Issue read / triage / lifecycle (labels, assignees, comments) | ✅                                                                            | ✅                        | ✅                               |
| Code & repo search                                            | ✅                                                                            | ✅                        | ✅                               |
| File content read + remote commit (single & multi-file)       | ✅                                                                            | ✅                        | ⚠️ `gh api` only                 |
| Branch list / create / delete                                 | ✅                                                                            | ✅                        | ⚠️ `gh api` / local `git`        |
| PR open / diff / request reviewers                            | ✅                                                                            | ✅                        | ✅                               |
| PR read detail / merge / update lifecycle                     | ❌ → planned ([#15](https://github.com/nemolize/remote-mcp-github/issues/15)) | ✅                        | ✅                               |
| PR reviews & review comments (read + reply)                   | ❌ → planned ([#15](https://github.com/nemolize/remote-mcp-github/issues/15)) | ✅                        | ⚠️ partial (`gh api` for inline) |
| **PR review thread resolve / unresolve**                      | ❌ → planned ([#39](https://github.com/nemolize/remote-mcp-github/issues/39)) | ❌                        | ⚠️ `gh api graphql` only         |
| Commit history (list / show / compare)                        | ✅                                                                            | ✅                        | ⚠️ `gh api` only                 |
| Workflow / Actions (CI status, logs, rerun)                   | ❌ → planned ([#8](https://github.com/nemolize/remote-mcp-github/issues/8))   | ✅                        | ✅                               |
| Releases & tags                                               | ❌                                                                            | ✅                        | ✅                               |
| Repo admin (create / fork / delete)                           | ❌                                                                            | ✅                        | ✅                               |
| Security scanning (secret / code / Dependabot)                | ❌                                                                            | ✅                        | ⚠️ `gh api` only                 |
| Local working-tree ops (clone, checkout, …)                   | ❌ — out of scope (remote-only)                                               | ❌                        | ✅                               |

Also outside this server's scope today: notifications, Copilot delegation, gists, and projects — reach for the official server or `gh` for those.

**Differentiators** — where a focused server earns its place next to the official one:

- **Context-bounded, curated output.** Each tool returns the fields that matter and truncates large payloads (diffs, file contents) at the boundary, so the model spends fewer tokens per call and a single response never overruns the context window. Output is serialized as Markdown — a deliberate format trade-off: denser and closer to how the model consumes the result, at the cost of the unambiguous structure raw JSON gives a programmatic caller. The official server returns JSON.
- **PR review thread resolve / unresolve** ([#39](https://github.com/nemolize/remote-mcp-github/issues/39), planned). Neither the official MCP nor this server can resolve a review thread today, so resolution flows fall back to `gh api graphql`. This is the gap that motivated the table — closing it is the clearest near-term differentiator.

## What's included

All tools respond in Markdown (not raw JSON) so the model can read them efficiently, and large payloads (diff, file content) are truncated at the boundary.

| Tool                     | Kind  | Purpose                                                                                          |
| ------------------------ | ----- | ------------------------------------------------------------------------------------------------ |
| `list_my_repos`          | read  | Authenticated user's repositories, with visibility / sort options                                |
| `get_repo`               | read  | Repo metadata (default branch, visibility, flags, stars, language, timestamps)                   |
| `get_authenticated_user` | read  | Identity bound to the current OAuth token (login, profile, repo counts)                          |
| `search_repositories`    | read  | Cross-GitHub repo search (uses GitHub search qualifiers like `org:`, `user:<login>`, `stars:>N`) |
| `search_issues`          | read  | Issue / PR search inside a specific repo                                                         |
| `get_issue`              | read  | Single issue / PR detail (title, body, state, labels, assignees, milestone)                      |
| `list_issue_comments`    | read  | Conversation comments on an issue or PR                                                          |
| `list_labels`            | read  | Labels defined in the repo (companion read for `add_labels` / `update_issue`)                    |
| `get_file_content`       | read  | Raw file contents at a path + ref (directory listings supported)                                 |
| `list_commits`           | read  | Commit history (git log) filtered by branch / path / author / date window                        |
| `get_commit`             | read  | Single commit detail — message, author, parents, per-file stats, diff                            |
| `compare_commits`        | read  | Diff between two refs (ahead / behind counts, merge base, per-file stats, diff)                  |
| `get_pr_diff`            | read  | Unified diff for a pull request                                                                  |
| `search_code`            | read  | Code search across GitHub                                                                        |
| `list_branches`          | read  | List branches in a repo (name, head SHA, protected flag)                                         |
| `create_branch`          | write | Branch from a base (or the repo's default)                                                       |
| `delete_branch`          | write | Delete a branch (default branch refused)                                                         |
| `commit_file`            | write | Create or update a single file on a branch in one commit                                         |
| `commit_files`           | write | Create or update multiple files on a branch in one commit (Tree API, per-file mode / encoding)   |
| `delete_file`            | write | Delete a single file on a branch in one commit (auto-SHA lookup like `commit_file`)              |
| `create_pull_request`    | write | Open a PR (same-repo `head` by default; `cross_repo_head` for fork PRs)                          |
| `request_pr_review`      | write | Request reviewers (users and/or teams) on a PR                                                   |
| `create_issue`           | write | Title + body + labels + assignees                                                                |
| `update_issue`           | write | Edit title / body / state / labels / assignees / milestone (labels and assignees replace)        |
| `add_labels`             | write | Append labels to an issue or PR without restating the existing set                               |
| `remove_label`           | write | Remove a single label from an issue or PR                                                        |
| `add_assignees`          | write | Append assignees to an issue or PR without restating the existing set                            |
| `remove_assignees`       | write | Remove specific assignees from an issue or PR                                                    |
| `add_comment`            | write | Comment on an issue or PR                                                                        |

Both `/mcp` (Streamable HTTP) and `/sse` endpoints are exposed; Claude.ai currently uses `/sse`.

Each tool call logs the GitHub rate-limit headers (`[github-ratelimit] remaining/limit, resets at …`) to `wrangler tail` so quota exhaustion is observable. Every successful write also emits a structured audit line (e.g. `[github-audit] {"tool":"commit_file","owner":"o","repo":"r","branch":"main","path":"x.ts"}`) to the Workers log, giving per-call accountability for LLM-mediated mutations. Both go to the Workers log only and never appear in the tool responses returned to the model.

`commit_files` reads the branch head and writes it back as a new ref; a concurrent push to the same branch in that window fails with a 422 and is surfaced to the caller to retry (no automatic retry). Its inline `content` (utf-8) path is bound by the Tree API's ~1 MB per-file cap; pass `encoding: "base64"` to upload larger files via the Blob API instead. See the inline comments in `src/tools/files.ts` for detail.

## Prerequisites

- A Cloudflare account with the `wrangler` CLI authenticated (`pnpm dlx wrangler@latest login`)
- Permission to create [GitHub OAuth Apps](https://github.com/settings/developers)
- Node.js 22+ and `pnpm`

## Setup

### 1. Clone and install

```bash
git clone https://github.com/<your-owner>/remote-mcp-github.git
cd remote-mcp-github
pnpm install
```

### 2. Create two GitHub OAuth Apps

Create **two** OAuth Apps at `https://github.com/settings/applications/new` — one for local dev, one for production. Use the values below; the production URLs use the `*.workers.dev` host you'll be deploying to.

| Purpose | Homepage URL                                             | Authorization callback URL                                        |
| ------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| Dev     | `http://localhost:8788`                                  | `http://localhost:8788/callback`                                  |
| Prod    | `https://remote-mcp-github.<your-subdomain>.workers.dev` | `https://remote-mcp-github.<your-subdomain>.workers.dev/callback` |

After creation, generate a Client Secret for each app and keep both Client ID + Secret pairs handy.

### 3. Create the KV namespace

```bash
pnpm dlx wrangler@latest kv namespace create OAUTH_KV
```

Copy the resulting `id` value and paste it into `wrangler.jsonc` under `kv_namespaces[0].id`. This namespace stores encrypted OAuth grants.

### 4. Wire dev secrets

Copy the example and fill in the **dev** OAuth App credentials:

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars
```

Generate the cookie encryption key with `openssl rand -hex 32`.

`.dev.vars` is git-ignored.

Alternatively, export the three keys as environment variables (e.g. via your
shell or a secret manager) instead of writing `.dev.vars` — `wrangler dev`
reads the required secrets from `process.env` as well.

### 5. Wire production secrets

Push the **prod** OAuth App credentials and a fresh cookie key to Cloudflare:

```bash
pnpm dlx wrangler@latest secret put GITHUB_CLIENT_ID
pnpm dlx wrangler@latest secret put GITHUB_CLIENT_SECRET
pnpm dlx wrangler@latest secret put COOKIE_ENCRYPTION_KEY   # openssl rand -hex 32
```

### 6. Run locally

```bash
pnpm dev
```

The server listens on `http://localhost:8788`. Validate it with [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
DANGEROUSLY_OMIT_AUTH=true pnpm dlx @modelcontextprotocol/inspector
```

Open the printed URL, choose `Transport Type: SSE`, set `URL: http://localhost:8788/sse`, switch `Connection Type: Direct`, and click Connect. The first request triggers the OAuth dance via the **dev** GitHub OAuth App.

### 7. Deploy

```bash
pnpm deploy
```

Verify:

```bash
curl https://remote-mcp-github.<your-subdomain>.workers.dev/.well-known/oauth-authorization-server
```

### 8. Register with Claude.ai

1. Open `Claude.ai → Settings → Connectors → Add custom connector`
2. Name: anything (e.g. `remote-mcp-github`)
3. Remote MCP server URL: `https://remote-mcp-github.<your-subdomain>.workers.dev/sse`
4. Add → Connect → approve on the MCP authorize page → authorize on GitHub → done

In a new chat, prompt Claude with something like _"List my GitHub repositories by most recently updated"_ — Claude will pick `list_my_repos` and call it.

## Code quality

```bash
pnpm lint     # eslint + tsc --noEmit + prettier --check, in parallel
pnpm fix      # eslint --fix && prettier --write
```

CI runs each sub-check (`lint:eslint`, `lint:typecheck`, `lint:prettier`) as a separate matrix job for clearer status reporting; locally, `pnpm lint` is the one-shot equivalent and `pnpm fix` auto-resolves formatting and any autofixable ESLint findings before opening a PR.

## Testing

Tests run with [Vitest](https://vitest.dev/) via [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/), so they execute inside the real Workers runtime (`workerd`) backed by Miniflare — not Node.

```bash
pnpm test         # one-shot run
pnpm test:watch   # watch mode
```

Cross-cutting tests live under top-level `test/`. Tests that exercise a single module can also be co-located as `*.test.ts` next to the source. CI runs `pnpm test` as a dedicated `Test` job on every PR.

The suite includes `test/mcp-e2e.test.js`, a transport-level E2E that drives `/register` → `/authorize` → `/token` and exercises `/mcp initialize` + `tools/list` against the real OAuth provider. To avoid a GitHub round-trip in CI, the test pool swaps in `test/_fixtures/fake-github-handler.ts` via the `buildOAuthProvider` factory in `src/index.ts`; tool execution against real GitHub is covered separately by the manual harness below.

### Manual OAuth E2E

`scripts/e2e/oauth-e2e.mjs` drives the full OAuth 2.1 + PKCE handshake against a locally-running server and then exercises a few read tools over the Streamable HTTP MCP transport, asserting on the rendered Markdown. It is **manual** — approving the GitHub consent in a browser window is the one non-scripted step — and is deliberately not wired into CI.

```bash
pnpm dev                # in one shell
pnpm run e2e:oauth      # in another; prints an authorize URL (open it manually), then waits for ?code=...
```

Defaults assert against `nemolize/remote-mcp-github` so the maintainer can run it with no setup. Forks override via env:

```bash
EXPECTED_OWNER=acme EXPECTED_REPO=widget EXPECTED_LOGIN=acmebot pnpm run e2e:oauth
```

Other knobs: `MCP_BASE` (default `http://localhost:8788`), `CALLBACK_PORT` (default `9876`), `TIMEOUT_MS` (default `300000`).

## OAuth scopes

The server requests `read:user repo` from GitHub. The `repo` portion is what enables private-repo visibility for read tools and the create/comment/branch capabilities of the write tools. To run the read tools only against public repositories, change `src/github-handler.ts` to `read:user public_repo`.

## Project structure

```
src/
├── index.ts             # OAuthProvider + MyMCP class wiring
├── tools.ts             # GitHub tools + helpers (truncation, rate-limit log)
├── github-handler.ts    # OAuth redirect handler (scope set here)
├── workers-oauth-utils.ts
└── utils.ts
wrangler.jsonc           # Cloudflare Workers config; KV id goes here
.dev.vars.example        # Template for the dev secrets
```

## Security notes

- Tokens are encrypted at rest in the `OAUTH_KV` namespace using `COOKIE_ENCRYPTION_KEY`. Rotate the key (and re-deploy) to invalidate all active grants.
- The Worker is the OAuth _server_ for Claude.ai (and any other MCP client) and the OAuth _client_ for GitHub. The GitHub access token never leaves the Worker — it sits in `this.props.accessToken` inside the Durable Object instance, used by Octokit per request.
- All tool calls go through a `wrapTool()` boundary that converts thrown errors into `{ isError: true, content: [{ type: "text", text: "Error: …" }] }` so the model sees the failure mode rather than the connection dropping. The error text is forwarded verbatim; Octokit already redacts the Authorization header, so tokens do not leak, though other fields are not sanitised (defence-in-depth, not done today).
- Write-tool payloads carry input-size caps (file content, commit/PR/issue/comment text, per-commit file count, and the aggregate content size of a multi-file commit — see `src/tools/common.ts`) as defence-in-depth, so a runaway model can't burn Worker CPU/memory with a multi-megabyte payload well under the platform's 100 MiB request limit. Oversized input is rejected with a descriptive error (per-field caps at schema validation; the aggregate-commit cap in the `commit_files` handler before any API call).
- This is still a small server. Audit before exposing to untrusted users; consider tightening CORS, limiting allowed origins, or restricting `ALLOWED_USERNAMES` for sensitive write tools.

## License

MIT
