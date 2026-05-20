---
status: accepted
date: 2026-05-20
decision-makers: nemolize
consulted: none
informed: future contributors via this ADR
---

# Keep `list_my_repos` alongside `search_repositories`

## Context and Problem Statement

When implementing the three repo / user metadata tools from #13, `search_repositories` (`rest.search.repos`) gains the ability to express `user:<login>` queries — which on the surface overlaps with the existing `list_my_repos` (`rest.repos.listForAuthenticatedUser`). The question is whether `list_my_repos` should be deprecated, renamed, or kept as-is. (Note: the original issue framing used `user:@me`, but the GitHub Search API does not resolve `@me` — callers must pass the actual login. This does not change the trade-offs evaluated below.)

The official `github/github-mcp-server` reference implementation does not ship a `list_my_repos`-style sugar tool — it expects clients to construct `user:<login>` search queries — which gave the deprecation option a "shape-conformity" argument worth weighing.

## Decision Drivers

- LLM tool-selection ergonomics — typed parameters and intuitive tool names reduce model errors.
- Functional coverage — a replacement should be a true superset, not a regression.
- Rate-limit and pagination headroom — Search API and Core API have very different operating envelopes.
- Tool-surface minimalism — fewer tools is generally better when truly redundant.
- Alignment with the official MCP shape — minor benefit for cross-MCP consistency.

## Considered Options

1. **Keep `list_my_repos` as-is** alongside the new `search_repositories`.
2. **Rename** `list_my_repos` → `list_authenticated_user_repos` to match the dropped-sugar style of other tool names.
3. **Deprecate / remove** `list_my_repos`; advise callers to use `search_repositories` with `user:<login>` (the login fetched via `get_authenticated_user`).

## Decision Outcome

**Chosen option: 1 — Keep `list_my_repos` as-is.**

`search_repositories user:<login>` is **not** a clean superset of `list_my_repos`. The Search API and the authenticated-user listing endpoint diverge on multiple practical axes (see comparison below), each of which produces a felt regression for at least one common LLM-driven use case. Keeping both tools costs one tool slot in the surface but preserves correctness and ergonomics where it matters.

Renaming (option 2) was rejected because it would break LLM-prompt continuity ("list my repos" maps naturally to `list_my_repos`) without addressing any of the functional concerns that drove option 3 — pure cosmetic churn.

## Pros and Cons of the Options

### Option 1: Keep `list_my_repos` as-is

- Good, because the tool name is naturally LLM-selectable for "show me my own repos" intents.
- Good, because the `visibility: 'all' | 'public' | 'private'` parameter is typed and unambiguous (vs constructing `is:public` / `is:private` qualifier strings inside a free-form query).
- Good, because `listForAuthenticatedUser` has no result cap; the Search API caps at 1000 reachable results regardless of pagination.
- Good, because Core API rate (5000 req/h) is far more generous than Search API (30 req/min), and a paginated LLM walk through a moderately sized account is well within Core but easily contended on Search.
- Good, because `sort: 'pushed' | 'full_name' | 'created' | 'updated'` is the natural sort surface for "my own repos"; `search_repositories` only exposes `'stars' | 'forks' | 'help-wanted-issues' | 'updated'`, with `'pushed'` and `'full_name'` notably missing.
- Good, because `per_page` caps at 100 (vs 50 on Search), halving pagination round-trips.
- Good, because the canonical endpoint is always fresh, while the Search index lags by minutes-to-hours after repo creation / rename.
- Neutral, because one extra tool entry is exposed.
- Bad, because the tool surface diverges slightly from the official `github/github-mcp-server` shape.

### Option 2: Rename to `list_authenticated_user_repos`

- Good, because the name matches the verbose-but-explicit style of other potentially renameable tools.
- Bad, because it breaks LLM-prompt continuity for no functional gain.
- Bad, because the new name is longer and less natural for "list my repos"–style prompts.
- Neutral, because it does not address any of the substantive concerns about Search API limitations.

### Option 3: Deprecate / remove `list_my_repos`

- Good, because tool count goes down by one and matches the official MCP shape.
- Bad, because the Search API hard-caps at 1000 results; power users with >1000 repos lose tail visibility entirely.
- Bad, because `pushed` and `full_name` sorts disappear — the two most natural sorts for "browse my own repos" specifically.
- Bad, because Search API rate (30 req/min) is significantly tighter than Core (5000 req/h); LLM pagination contention increases.
- Bad, because `visibility` becomes a qualifier-string concern, increasing LLM error rate.
- Bad, because the Search index can lag minutes-to-hours behind canonical state, masking recent changes.
- Bad, because the migration breaks existing prompts and downstream integrations that expect `list_my_repos`.

## Consequences

- Positive: the tool surface stays LLM-ergonomic for the most common "list my own repos" intent and preserves full functional coverage (sort, visibility, pagination, rate, freshness).
- Positive: `search_repositories` occupies a complementary slot — cross-GitHub search with arbitrary qualifiers — without competing with `list_my_repos`.
- Negative: the tool surface is one tool larger than a minimal `github/github-mcp-server`-aligned shape would be.
- Negative: future contributors may need this ADR pointed at them when a similar "should sugar tool X be folded into general-purpose tool Y?" question arises, so that the precedent (typed parameters and LLM-ergonomic naming beat cosmetic minimalism when functional regressions exist) is reapplied consistently.

## Confirmation

- `list_my_repos` and `search_repositories` are both present in the README "What's included" table after #27 merges.
- A future ADR superseding this one is required if the functional gap (1000-result cap, missing sorts, rate-limit differential, qualifier-string `visibility` filter) is closed by upstream GitHub API changes.

## More Information

- Issue #13 — original feature request and the follow-up discussion.
- #13 comment resolution — https://github.com/nemolize/remote-mcp-github/issues/13#issuecomment-4497613762
- PR #27 — implementation that this decision is recorded alongside.
