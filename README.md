# remote-mcp-github

A Claude.ai-ready remote MCP server that exposes GitHub as a custom connector through a public Cloudflare Workers deployment.

Connect this server in `Claude.ai → Settings → Connectors → Add custom connector` and Claude can list/search/inspect your repositories, read files, fetch PR diffs, and (with `repo` scope) create issues, comment, and branch — all under the user's own GitHub identity via standard OAuth 2.1 / PKCE.

The standard endpoint is the public instance maintained by the author:

```text
https://remote-mcp-github.nemolize.workers.dev/sse
```

It is offered on a best-effort basis with no uptime or quota guarantees. Self-host only when you need your own Cloudflare account, quota, operational controls, or OAuth App ownership.

## Why this server

Several GitHub MCP servers exist, alongside GitHub's own `gh` CLI. This server's niche: responses are **curated and bounded for an LLM consumer** — each tool returns the fields that matter and truncates large payloads (diffs, file contents) at the boundary, so a single response can't overrun the model's context window — and every call runs under the user's own GitHub OAuth identity. (Output is serialized as Markdown rather than JSON; that is a deliberate format trade-off, not a strict win — see **Differentiators** below.)

The table below compares coverage by **feature area** against the two most common alternatives. It stays deliberately coarse-grained — the [tool table](#whats-included) is the source of truth for which tools exist right now, and `gh`'s coverage is documented in the [GitHub CLI manual](https://cli.github.com/manual/). Legend: ✅ first-class · 🟡 partial — some tools in the area still missing (see the linked issue or inline note) · ⚠️ only via a lower-level escape hatch (`gh api`, local `git`) · ❌ absent (linked issue = tracked; unlinked = not currently tracked or structurally out of scope).

| Feature area                                                                  | This server                                                                                                                                                                                                                | Official `mcp__github__*` | `gh` CLI                                                       |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------- |
| Repo metadata & discovery                                                     | ✅                                                                                                                                                                                                                         | ✅                        | ✅                                                             |
| Issue read / triage / lifecycle (labels, assignees, comments)                 | 🟡 sub-issues ([#161](https://github.com/nemolize/remote-mcp-github/issues/161)); no pin / lock / transfer / delete / develop, no comment edit / delete ([#190](https://github.com/nemolize/remote-mcp-github/issues/190)) | ✅                        | ✅                                                             |
| Code & repo search                                                            | 🟡 users / orgs / PR search ([#163](https://github.com/nemolize/remote-mcp-github/issues/163))                                                                                                                             | ✅                        | ✅                                                             |
| File content read + remote commit (single & multi-file)                       | ✅                                                                                                                                                                                                                         | ✅                        | ⚠️ `gh api` only                                               |
| Branch list / create / delete                                                 | ✅                                                                                                                                                                                                                         | ✅                        | ⚠️ `gh api` / local `git`                                      |
| PR open / diff / request reviewers                                            | ✅                                                                                                                                                                                                                         | ✅                        | ✅                                                             |
| PR read detail / merge / update lifecycle                                     | 🟡 no draft → ready-for-review (GraphQL `markPullRequestReadyForReview`), no lock / unlock ([#191](https://github.com/nemolize/remote-mcp-github/issues/191))                                                              | ✅                        | ✅                                                             |
| PR reviews & review comments (read + reply + submit + pending)                | ✅ one-shot + pending lifecycle (`create_pr_review`, `create_pending_pr_review` / `add_comment_to_pending_pr_review` / `submit_pending_pr_review` / `delete_pending_pr_review`, `add_pr_review_comment_reply`)             | ✅                        | ⚠️ partial (`gh api` for inline)                               |
| PR review thread resolve / unresolve                                          | ✅                                                                                                                                                                                                                         | ✅                        | ⚠️ `gh api graphql` only                                       |
| Commit history (list / show / compare)                                        | ✅                                                                                                                                                                                                                         | ✅                        | ⚠️ `gh api` only                                               |
| Workflow / Actions (CI status, logs, rerun)                                   | 🟡 run usage / log deletion / artifact download ([#159](https://github.com/nemolize/remote-mcp-github/issues/159))                                                                                                         | ✅                        | ✅                                                             |
| Actions administration (secrets, variables, cache, workflow enable / disable) | 🟡 Codespaces / Dependabot secrets ([#194](https://github.com/nemolize/remote-mcp-github/issues/194))                                                                                                                      | ❌                        | ✅                                                             |
| Releases & tags                                                               | 🟡 read + write (`list_releases`, `get_release`, `list_tags`, create / update / delete release); no asset upload / download ([#192](https://github.com/nemolize/remote-mcp-github/issues/192))                             | 🟡 read only              | ✅                                                             |
| Repo admin (create / fork / delete)                                           | ✅ create / fork / delete (`create_repository`, `fork_repository`, `delete_repository`)                                                                                                                                    | ✅                        | ✅                                                             |
| Repository configuration edit (rename, archive, deploy keys, autolinks)       | ❌ ([#196](https://github.com/nemolize/remote-mcp-github/issues/196))                                                                                                                                                      | ❌                        | ✅                                                             |
| Label definitions (create / edit / delete / clone)                            | 🟡 read only (`list_labels`); no create / edit / delete / clone ([#197](https://github.com/nemolize/remote-mcp-github/issues/197))                                                                                         | 🟡 read only              | ✅                                                             |
| Gists (list / read / create / update / delete)                                | ✅ read + write (`list_gists`, `get_gist`, `list_gist_comments`, `create_gist`, `update_gist`, `delete_gist`)                                                                                                              | ✅                        | ✅                                                             |
| Security scanning (secret / code / Dependabot)                                | 🟡 single-alert `get_*` ([#158](https://github.com/nemolize/remote-mcp-github/issues/158))                                                                                                                                 | ✅                        | ⚠️ `gh api` only                                               |
| Repository rulesets                                                           | ❌ ([#195](https://github.com/nemolize/remote-mcp-github/issues/195))                                                                                                                                                      | ❌                        | ✅                                                             |
| Copilot delegation (assign issue / request PR review)                         | ❌ ([#162](https://github.com/nemolize/remote-mcp-github/issues/162))                                                                                                                                                      | ✅                        | ✅ (`--add-assignee "@copilot"` / `--add-reviewer "@copilot"`) |
| Discussions (list / categories / get / comments)                              | ✅ read (`list_discussions`, `list_discussion_categories`, `get_discussion`, `get_discussion_comments`)                                                                                                                    | ✅                        | ✅ (`gh discussion`, preview)                                  |
| Notifications (list / mark read / thread subscription)                        | ❌ ([#139](https://github.com/nemolize/remote-mcp-github/issues/139))                                                                                                                                                      | ✅                        | ⚠️ `gh api` only                                               |
| Projects (v2)                                                                 | ✅ read + write — project CRUD (create / edit / close / delete / copy / link / unlink), field create / delete, items (add / remove / archive / draft / field values)                                                       | ✅                        | ✅ (`gh project`)                                              |
| Local working-tree ops (clone, checkout, …)                                   | ❌ — out of scope (remote-only)                                                                                                                                                                                            | ❌                        | ✅                                                             |

**Differentiators** — where a focused server earns its place next to the official one:

- **Context-bounded, curated output.** Each tool returns the fields that matter and truncates large payloads (diffs, file contents) at the boundary, so the model spends fewer tokens per call and a single response never overruns the context window. Output is serialized as Markdown — a deliberate format trade-off: denser and closer to how the model consumes the result, at the cost of the unambiguous structure raw JSON gives a programmatic caller. The official server returns JSON.
- **PR review thread resolve / unresolve** ([#39](https://github.com/nemolize/remote-mcp-github/issues/39), shipped) — the built-in `resolve_review_thread` / `unresolve_review_thread` avoid the `gh api graphql` fallback. The official MCP recently added the same tools; this is no longer a coverage differentiator, but the Markdown-serialized inline flow keeps it a smoother match for the review-response loop.

## What's included

All tools respond in Markdown (not raw JSON) so the model can read them efficiently, and large payloads (diff, file content) are truncated at the boundary.

| Tool                               | Kind  | Purpose                                                                                              |
| ---------------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| `list_my_repos`                    | read  | Authenticated user's repositories, with visibility / sort options                                    |
| `get_repo`                         | read  | Repo metadata (default branch, visibility, flags, stars, language, timestamps)                       |
| `get_authenticated_user`           | read  | Identity bound to the current OAuth token (login, profile, repo counts)                              |
| `search_repositories`              | read  | Cross-GitHub repo search (uses GitHub search qualifiers like `org:`, `user:<login>`, `stars:>N`)     |
| `create_repository`                | write | Create a repo for the authenticated user (or an `org`) — visibility, auto-init, gitignore/license    |
| `fork_repository`                  | write | Fork `owner/repo` to the authenticated user (or an `organization`); optional default-branch-only     |
| `delete_repository`                | write | Permanently delete `owner/repo` (destructive; GitHub keeps a 90-day restoration window for orgs)     |
| `search_issues`                    | read  | Issue / PR search inside a specific repo                                                             |
| `get_issue`                        | read  | Single issue / PR detail (title, body, state, labels, assignees, milestone)                          |
| `list_issue_comments`              | read  | Conversation comments on an issue or PR                                                              |
| `list_labels`                      | read  | Labels defined in the repo (companion read for `add_labels` / `update_issue`)                        |
| `get_file_content`                 | read  | Raw file contents at a path + ref (directory listings supported)                                     |
| `list_commits`                     | read  | Commit history (git log) filtered by branch / path / author / date window                            |
| `get_commit`                       | read  | Single commit detail — message, author, parents, per-file stats, diff                                |
| `compare_commits`                  | read  | Diff between two refs (ahead / behind counts, merge base, per-file stats, diff)                      |
| `get_pr_diff`                      | read  | Unified diff for a pull request                                                                      |
| `get_pull_request`                 | read  | Full PR detail — state, mergeable state, head/base SHAs, reviewers, commit/diff counts               |
| `get_pull_request_files`           | read  | Files changed in a PR — status, additions/deletions, truncated patch snippet per file                |
| `get_pull_request_status`          | read  | Combined merge-readiness — Actions check-runs + legacy commit statuses, in one call                  |
| `list_pr_reviews`                  | read  | Submitted reviews — state (APPROVED / CHANGES_REQUESTED / …), reviewer, summary body, submitted_at   |
| `list_pr_review_threads`           | read  | PR review threads with node IDs (`PRRT_…`) + resolved state (companion read for resolve/unresolve)   |
| `search_code`                      | read  | Code search across GitHub                                                                            |
| `search_users`                     | read  | Cross-GitHub user search (`type:user` forced automatically; login + profile URL)                     |
| `search_orgs`                      | read  | Cross-GitHub organization search (`type:org` forced automatically)                                   |
| `search_pull_requests`             | read  | Cross-GitHub PR search (`is:pr` forced; renders state / draft / merged)                              |
| `list_workflow_runs`               | read  | Recent Actions workflow runs filtered by workflow / branch / event / status                          |
| `get_workflow_run`                 | read  | Single run detail — status / conclusion, event, actor, head branch / SHA, attempt, timestamps        |
| `list_workflow_run_jobs`           | read  | Jobs of a run with per-step status — the "what failed?" lookup                                       |
| `list_workflows`                   | read  | Workflows defined in the repo (ID, name, state, path) — discover pipelines / find a `workflow_id`    |
| `get_job_logs`                     | read  | Plain-text logs of a single job, tail-truncated — the "why did it fail?" lookup after the job list   |
| `get_workflow_run_logs`            | read  | Full run log archive download URL (zip of all jobs; short-lived URL, metadata only, no download)     |
| `list_workflow_run_artifacts`      | read  | Artifacts produced by a run (ID, name, size, expiry) — the "what did the build produce?" lookup      |
| `get_artifact`                     | read  | Single artifact metadata + archive download URL (zip; metadata only, no download / unzip)            |
| `rerun_workflow_run`               | write | Re-run an entire workflow run (all jobs) — new attempt; poll `get_workflow_run` for status           |
| `rerun_failed_jobs`                | write | Re-run only the failed jobs of a run — new attempt; poll `get_workflow_run` for status               |
| `cancel_workflow_run`              | write | Cancel an in-progress run (async); poll `get_workflow_run` until conclusion is `cancelled`           |
| `trigger_workflow_dispatch`        | write | Manually dispatch a `workflow_dispatch` workflow on a ref with optional inputs                       |
| `list_actions_secrets`             | read  | Actions secrets by name + timestamps (values are never returned by GitHub)                           |
| `set_actions_secret`               | write | Create / update an Actions secret — encrypted client-side (sealed box); value never echoed back      |
| `delete_actions_secret`            | write | Delete an Actions secret by name                                                                     |
| `list_actions_variables`           | read  | Actions variables (name, plaintext value, timestamps) — the `vars` context workflows read            |
| `get_actions_variable`             | read  | Single Actions variable by name (value + timestamps)                                                 |
| `set_actions_variable`             | write | Create / update an Actions variable (create-first, falls back to update on 409)                      |
| `delete_actions_variable`          | write | Delete an Actions variable by name                                                                   |
| `list_actions_caches`              | read  | Actions caches (ID, key, ref, size, last accessed) — find a cache to evict                           |
| `delete_actions_cache`             | write | Delete caches by `cache_id` or by full `key` (optionally scoped to a ref)                            |
| `enable_workflow`                  | write | Re-enable a disabled workflow so its triggers fire again                                             |
| `disable_workflow`                 | write | Disable a workflow — its triggers stop firing until re-enabled                                       |
| `list_releases`                    | read  | Releases newest first (ID, name, tag, draft / prerelease / published state, date, author)            |
| `get_release`                      | read  | Single release detail + notes body — by `release_id`, by `tag`, or the latest when neither given     |
| `list_tags`                        | read  | Git tags (name, commit SHA) — for release metadata on a tag, use `get_release` with the tag          |
| `create_release`                   | write | Create a release (and its tag) from `tag_name` (+ name, body, draft, prerelease, generated notes)    |
| `update_release`                   | write | Edit a release by `release_id` (rename, edit notes, publish a draft, toggle prerelease)              |
| `delete_release`                   | write | Delete a release by `release_id` (leaves the git tag in place)                                       |
| `list_gists`                       | read  | Authenticated user's gists newest first (ID, description, public flag, file count, updated_at)       |
| `get_gist`                         | read  | Single gist detail — description, owner, public flag, per-file metadata + length-capped content      |
| `list_gist_comments`               | read  | Comments on a gist (companion read for a future comment-write tool)                                  |
| `create_gist`                      | write | Create a gist with one or more files (description, files, public flag)                               |
| `update_gist`                      | write | Edit a gist's description and/or add / replace / rename / delete files                               |
| `delete_gist`                      | write | Delete a gist by `gist_id` (irreversible)                                                            |
| `list_secret_scanning_alerts`      | read  | Secret-scanning alerts (number, state, secret type, resolution, date) — never the raw secret value   |
| `list_code_scanning_alerts`        | read  | Code-scanning alerts (number, state, rule + severity, tool, most-recent location path:line)          |
| `list_dependabot_alerts`           | read  | Dependabot alerts (number, state, package, severity, advisory GHSA + summary)                        |
| `get_secret_scanning_alert`        | read  | One secret-scanning alert (type, state, resolution, timestamps) — never the raw secret value         |
| `get_code_scanning_alert`          | read  | One code-scanning alert (rule, severity, tool, most-recent location)                                 |
| `get_dependabot_alert`             | read  | One Dependabot alert (package, severity, GHSA, advisory summary)                                     |
| `list_projects`                    | read  | Projects (v2) of a user / org — or the authenticated user — number, title, state, node ID (`PVT_…`)  |
| `get_project`                      | read  | Single Project (v2) detail — visibility, state, item count, field definitions + options              |
| `list_project_items`               | read  | Project (v2) board items — type, title, `owner/repo#N`, Status, assignees; `include_archived` opt-in |
| `list_project_fields`              | read  | Project (v2) field definitions — name, data type, single-select option names + IDs                   |
| `add_project_item`                 | write | Add an existing issue / PR to a Project (v2) by its content node ID                                  |
| `remove_project_item`              | write | Remove an item from a Project (v2) by its item node ID (`PVTI_…`)                                    |
| `update_project_item_field`        | write | Set a Project (v2) item's field value — text / number / date / single-select option                  |
| `create_project_draft_item`        | write | Add a draft item (title + optional body) to a Project (v2) without an underlying issue               |
| `create_project`                   | write | Create a Project (v2) under a user / org — or the authenticated user — returns number + node ID      |
| `update_project`                   | write | Edit a Project (v2) — title, short description, visibility, open/closed state (close / reopen)       |
| `delete_project`                   | write | Delete a Project (v2) permanently, including draft items and field configuration (irreversible)      |
| `copy_project`                     | write | Copy a Project (v2) — fields, views, workflows — to a new project (optionally with draft items)      |
| `link_project_to_repository`       | write | Link a Project (v2) to a repository (shows in the repo's Projects tab)                               |
| `unlink_project_from_repository`   | write | Unlink a Project (v2) from a repository                                                              |
| `create_project_field`             | write | Create a custom Project (v2) field — TEXT / NUMBER / DATE / SINGLE_SELECT (with option names)        |
| `delete_project_field`             | write | Delete a custom Project (v2) field by its field node ID (irreversible)                               |
| `archive_project_item`             | write | Archive — or with `undo: true` restore — a Project (v2) item by its item node ID                     |
| `list_discussions`                 | read  | Discussions in a repo, most recently updated first — optional category filter, answered state        |
| `list_discussion_categories`       | read  | Discussion categories (name, slug, answerable flag, node ID — the `category_id` for filtering)       |
| `get_discussion`                   | read  | Single discussion detail — title, body, author, category, answered state, counts, timestamps         |
| `get_discussion_comments`          | read  | Top-level comments on a discussion — author, accepted-answer marker, reply count, body preview       |
| `list_branches`                    | read  | List branches in a repo (name, head SHA, protected flag)                                             |
| `create_branch`                    | write | Branch from a base (or the repo's default)                                                           |
| `delete_branch`                    | write | Delete a branch (default branch refused)                                                             |
| `commit_file`                      | write | Create or update a single file on a branch in one commit                                             |
| `commit_files`                     | write | Create or update multiple files on a branch in one commit (Tree API, per-file mode / encoding)       |
| `delete_file`                      | write | Delete a single file on a branch in one commit (auto-SHA lookup like `commit_file`)                  |
| `create_pull_request`              | write | Open a PR (same-repo `head` by default; `cross_repo_head` for fork PRs)                              |
| `update_pull_request`              | write | Edit a PR's title / body / state (close / reopen) / base branch                                      |
| `update_pull_request_branch`       | write | Update a PR's branch with its base's latest changes (mirrors the "Update branch" button)             |
| `merge_pull_request`               | write | Merge a PR (merge / squash / rebase; optional commit message and `sha` concurrency guard)            |
| `request_pr_review`                | write | Request reviewers (users and/or teams) on a PR                                                       |
| `create_pr_review`                 | write | Submit a review (APPROVE / REQUEST_CHANGES / COMMENT) with optional body + batched inline comments   |
| `create_pending_pr_review`         | write | Open a pending (draft) review — no event, no notification; seed optional inline comments             |
| `add_comment_to_pending_pr_review` | write | Append one inline thread to a pending review (GraphQL `addPullRequestReviewThread`)                  |
| `submit_pending_pr_review`         | write | Submit a pending review with a verdict (APPROVE / REQUEST_CHANGES / COMMENT) — one notification      |
| `delete_pending_pr_review`         | write | Discard a pending review without submitting                                                          |
| `add_pr_review_comment_reply`      | write | Reply to an existing PR review comment thread (by `comment_id`)                                      |
| `resolve_review_thread`            | write | Mark a PR review thread resolved (GraphQL; thread node ID)                                           |
| `unresolve_review_thread`          | write | Re-open a resolved PR review thread (GraphQL; thread node ID)                                        |
| `create_issue`                     | write | Title + body + labels + assignees                                                                    |
| `update_issue`                     | write | Edit title / body / state / labels / assignees / milestone (labels and assignees replace)            |
| `add_labels`                       | write | Append labels to an issue or PR without restating the existing set                                   |
| `remove_label`                     | write | Remove a single label from an issue or PR                                                            |
| `add_assignees`                    | write | Append assignees to an issue or PR without restating the existing set                                |
| `remove_assignees`                 | write | Remove specific assignees from an issue or PR                                                        |
| `add_comment`                      | write | Comment on an issue or PR                                                                            |

Both `/mcp` (Streamable HTTP) and `/sse` endpoints are exposed; Claude.ai currently uses `/sse`.

Each tool call logs the GitHub rate-limit headers (`[github-ratelimit] remaining/limit, resets at …`) to `wrangler tail` so quota exhaustion is observable. Every successful write also emits a structured audit line (e.g. `[github-audit] {"tool":"commit_file","owner":"o","repo":"r","branch":"main","path":"x.ts"}`) to the Workers log, giving per-call accountability for LLM-mediated mutations. Both go to the Workers log only and never appear in the tool responses returned to the model.

`commit_files` reads the branch head and writes it back as a new ref; a concurrent push to the same branch in that window fails with a 422 and is surfaced to the caller to retry (no automatic retry). Its inline `content` (utf-8) path is bound by the Tree API's ~1 MB per-file cap; pass `encoding: "base64"` to upload larger files via the Blob API instead. See the inline comments in `src/tools/files.ts` for detail.

## Setup

### Claude.ai

Use the public endpoint unless you specifically need to operate your own Worker.

1. Open `Claude.ai → Settings → Connectors → Add custom connector`.
2. Name the connector, for example `remote-mcp-github`.
3. Set **Remote MCP server URL** to:

   ```text
   https://remote-mcp-github.nemolize.workers.dev/sse
   ```

4. Click **Add** and then **Connect**.
5. Approve the MCP authorization page.
6. Authorize the GitHub OAuth App.

After the connector is enabled, start a new Claude chat and ask something like _"List my GitHub repositories by most recently updated"_. Claude should call `list_my_repos`.

### What You Authorize

The public instance uses GitHub OAuth. It does not ask you to paste a GitHub token into Claude or into this repository.

The OAuth App currently requests `read:user repo delete_repo gist project`:

- `read:user` identifies the authenticated GitHub user.
- `repo` enables private-repository reads and write tools such as issue comments, branches, pull requests, and commits.
- `delete_repo` is required only by `delete_repository`.
- `gist` is required only by the gist tools.
- `project` covers the GitHub Projects (v2) tools — reads (`list_projects`, `get_project`, `list_project_items`, `list_project_fields`) and writes (`add_project_item`, `remove_project_item`, `update_project_item_field`, `create_project_draft_item`).

The GitHub access token is encrypted in the Worker's OAuth KV storage and used server-side for GitHub API calls. See [Security notes](#security-notes) for the implementation model.

### When to Self-Host

The public instance is the default path for normal use. Self-host if you need any of these:

- your own uptime, quota, logs, and incident response;
- a GitHub OAuth App that you control;
- a different GitHub OAuth scope set;
- Worker-level policy changes such as allowed origins, username restrictions, or extra audit handling;
- private experimentation before exposing a modified tool surface.

## Self-Hosting Setup

### Prerequisites

- A Cloudflare account with the `wrangler` CLI authenticated (`pnpm dlx wrangler@latest login`)
- Permission to create [GitHub OAuth Apps](https://github.com/settings/developers)
- Node.js 22+ and `pnpm`

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

### 8. Register your self-hosted Worker with Claude.ai

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

The server requests `read:user repo delete_repo gist project` from GitHub. The `repo` portion is what enables private-repo visibility for read tools and the create/comment/branch capabilities of the write tools; `delete_repo` is required only by `delete_repository`; `gist` is required only by the gist tools (`list_gists`, `get_gist`, `list_gist_comments`, `create_gist`, `update_gist`, `delete_gist`); `project` is required only by the Projects (v2) tools — it covers both the read tools (`list_projects`, `get_project`, `list_project_items`, `list_project_fields`) and the write tools (`add_project_item`, `remove_project_item`, `update_project_item_field`, `create_project_draft_item`, `create_project`, `update_project`, `delete_project`, `copy_project`, `link_project_to_repository`, `unlink_project_from_repository`, `create_project_field`, `delete_project_field`, `archive_project_item`). Existing connections authorized under the previous `read:project` scope must re-authorize before the Projects write tools work. To run the read tools only against public repositories, change `src/github-handler.ts` to `read:user public_repo gist read:project` (the read-only `read:project` suffices when the write tools aren't needed).

The Actions administration tools (`list_actions_secrets`, `set_actions_secret`, `delete_actions_secret`, the variable tools, the cache tools, `enable_workflow` / `disable_workflow`) need **no additional OAuth scope**: the classic `repo` scope already covers the Actions secrets / variables / cache / workflow-state endpoints. What they do require is a sufficient **repository permission level** on the target repo — admin for secrets and variables, write for caches — which is a property of your access to the repository, not of the token's scopes.

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

## Issue labels

Two prefixed axes: `type:*` mirror the repo's conventional-commit types (`feat` / `fix` / `chore` / `docs`); `area:*` map to a responsibility area — a `src/tools/*.ts` module or a planned tool surface — and are created on demand when the first issue touching that area is filed. GitHub's standard workflow labels (`good first issue`, `help wanted`, `duplicate`, `invalid`, `question`, `wontfix`) are kept as-is.

## Security notes

- Tokens are encrypted at rest in the `OAUTH_KV` namespace using `COOKIE_ENCRYPTION_KEY`. Rotate the key (and re-deploy) to invalidate all active grants.
- The Worker is the OAuth _server_ for Claude.ai (and any other MCP client) and the OAuth _client_ for GitHub. The GitHub access token never leaves the Worker — it sits in `this.props.accessToken` inside the Durable Object instance, used by Octokit per request.
- All tool calls go through a `wrapTool()` boundary that converts thrown errors into `{ isError: true, content: [{ type: "text", text: "Error: …" }] }` so the model sees the failure mode rather than the connection dropping. The error text is forwarded verbatim; Octokit already redacts the Authorization header, so tokens do not leak, though other fields are not sanitised (defence-in-depth, not done today).
- Write-tool payloads carry input-size caps (file content, commit/PR/issue/comment text, per-commit file count, and the aggregate content size of a multi-file commit — see `src/tools/common.ts`) as defence-in-depth, so a runaway model can't burn Worker CPU/memory with a multi-megabyte payload well under the platform's 100 MiB request limit. Oversized input is rejected with a descriptive error (per-field caps at schema validation; the aggregate-commit cap in the `commit_files` handler before any API call).
- This is still a small server. Audit before exposing to untrusted users; consider tightening CORS, limiting allowed origins, or restricting `ALLOWED_USERNAMES` for sensitive write tools.

## License

MIT
