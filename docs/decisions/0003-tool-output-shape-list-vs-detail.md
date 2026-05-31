---
status: accepted
date: 2026-05-29
decision-makers: nemolize
consulted: none
informed: future contributors via this ADR
---

# Tool output shape — list vs detail asymmetry is intentional

## Context and Problem Statement

Repo-surface tools render the same entity (a GitHub repository) in two different Markdown shapes — `list_my_repos` opens with a `# <Label>` heading naming the collection (e.g. `# Repositories (3)`) followed by one bullet per repo, while `get_repo` opens with a `# <Entity>` heading naming the repo itself, plus a blockquote description and richer bulleted metadata. Both shapes carry a `#` heading; what differs is whether the heading names the _collection_ or the _single entity_, and how much per-entity metadata the body holds. The same split exists across the wider tool surface (`search_issues` vs `get_issue`, `search_repositories` vs `get_repo`, `list_commits` vs `get_commit`). The question is whether this asymmetry should be removed for consistency, or kept as an intentional list-vs-detail convention.

## Decision Drivers

- LLM legibility — a stable visual cue for "this is one of N" vs "this is _the_ entity" reduces selector ambiguity.
- Scan density on list views — long lists must stay readable without per-item heading noise.
- Discoverability of detail metadata — `get_*` is the natural place for a richer field surface.
- Consistency with established CLI patterns the model has been trained against (`git log` vs `git show`, `kubectl get` vs `kubectl describe`).
- Implementation cost — uniformity is cheap to enforce; divergence is cheap to keep when it tracks a meaningful semantic.

## Considered Options

1. **Keep the list-vs-detail asymmetry** and document it as a project-wide tool-output convention.
2. **Promote list rows to richer per-item rendering** — each list entry gets its own `### <entity>` block with multi-line metadata.
3. **Simplify detail views to list shape** — `get_*` drops the entity `#` heading and blockquote, rendering the entity as a single labelled bullet row like the list views.

## Decision Outcome

**Chosen option: 1 — Keep the list-vs-detail asymmetry, documented as a tool-output convention.**

The two shapes encode a real semantic distinction (one-of-many vs the-single-entity) and the existing codebase is already consistent under that convention — `search_issues` / `get_issue`, `list_my_repos` / `get_repo`, `list_commits` / `get_commit` all follow the same split. The cost of changing it is high (output churn across most tools, plus a regression on whichever axis loses) while the benefit is cosmetic.

Options 2 and 3 each remove information that the current shapes carry for free:

- Option 2 inflates list character count per row, hurting scan density on the cases (long repo lists, search results) where lists matter most.
- Option 3 collapses the visual cue that separates "single entity" from "one of N", and drops the description blockquote that gives the model a natural place to ground on the entity's purpose.

## Pros and Cons of the Options

### Option 1: Keep list-vs-detail asymmetry

- Good, because the visual cue (`# Entity` vs `- **entity**`) lets the model immediately distinguish detail-view from list-view output.
- Good, because long list views stay scan-dense — bullet-per-entity scales to dozens of rows without heading noise.
- Good, because detail views have room for fields that don't fit a bullet row (description blockquote, multi-line `Stars | Forks | Open issues` group, optional `Forked from` / `Homepage` / `License` lines).
- Good, because it mirrors widely-known CLI conventions (`git log` / `git show`, `kubectl get` / `kubectl describe`) the model has prior on.
- Good, because no code changes are required; the codebase is already consistent under this rule.
- Neutral, because the model sees two shapes for the "repository" primitive — a small cognitive cost weighed against the semantic benefit above.

### Option 2: Promote list rows to richer per-item rendering

- Good, because every entity appears in the same shape regardless of view.
- Bad, because list character count balloons proportionally to row count; long-tail pagination becomes more expensive.
- Bad, because the model loses the immediate "this is _one of N_" cue from row density.
- Bad, because it requires rewriting every list tool's renderer and updating any consumer that assumes the current bullet shape.

### Option 3: Simplify detail views to list shape

- Good, because every entity appears in the same shape regardless of view.
- Bad, because detail views lose the heading that anchors "this is _the_ entity"; the description and supplementary fields lose their natural home.
- Bad, because optional-field handling (`Forked from`, `Homepage`, `License`, `Total private repos`) becomes a denser bullet pile without the structural separator a heading provides.
- Bad, because it requires touching every `get_*` renderer.

## Consequences

- Positive: the tool output convention is now explicit; new tool authors can follow it without rediscovering the rationale.
- Positive: no output regression on any existing tool — the convention codifies what already ships.
- Negative: the convention has to be re-evaluated when a future tool genuinely sits between "list" and "detail" (e.g. a paginated detail view, or a list that needs per-row sub-bullets). When that happens, this ADR should be amended rather than silently broken.

## Confirmation

- `src/tools.ts` carries a short pointer comment naming this convention and linking to this ADR, so the rule is visible at the registration entry point.
- A re-read of any list tool (`list_my_repos`, `search_issues`, `search_repositories`, `list_commits`, `list_branches`, `list_issue_comments`) shows a `# <Label>` header naming the collection followed by one bullet per row.
- A re-read of any detail tool (`get_repo`, `get_issue`, `get_commit`, `get_authenticated_user`) shows the `#` heading + bullet metadata shape.

## More Information

- Issue #31 — surfaced this as a `/team-review` defer on #27.
- ADR 0001 — `list_my_repos` vs `search_repositories` decision (separate axis: tool _coverage_, not output shape).
