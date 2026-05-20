# remote-mcp-github

A Claude.ai-ready remote MCP server that exposes GitHub as a custom connector, deployed to Cloudflare Workers.

Connect this server in `Claude.ai → Settings → Connectors → Add custom connector` and Claude can list/search/inspect your repositories, read files, fetch PR diffs, and (with `repo` scope) create issues, comment, and branch — all under the user's own GitHub identity via standard OAuth 2.1 / PKCE.

> A public instance maintained by the author is deployed at `https://remote-mcp-github.nemolize.workers.dev`. It is offered on a best-effort basis with no uptime or quota guarantees; self-host (the steps below) for anything you depend on.

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

Each tool call logs the GitHub rate-limit headers (`[github-ratelimit] remaining/limit, resets at …`) to `wrangler tail` so quota exhaustion is observable.

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
- All tool calls go through a `wrapTool()` boundary that converts thrown errors into `{ isError: true, content: [{ type: "text", text: "Error: …" }] }` so the model sees the failure mode rather than the connection dropping.
- This is still a small server. Audit before exposing to untrusted users; consider tightening CORS, limiting allowed origins, or restricting `ALLOWED_USERNAMES` for sensitive write tools.

## License

MIT
