## Architecture Decision Records

This directory stores Architecture Decision Records (ADRs) — durable notes for non-obvious design or trade-off decisions whose rationale future contributors (and AI assistants) will need to look back on.

We follow [MADR 4.0.0](https://adr.github.io/madr/).

### When to add an ADR

- A decision involves a non-obvious trade-off that took real evaluation to land on.
- The decision sets precedent for future similar choices (e.g. tool-surface shape, dependency choice, naming convention).
- A future reader six months on would need the rationale, not just the outcome.

If the answer is "this is obvious from the code" or "this is a single-PR mechanical change", skip the ADR.

### File naming

`NNNN-title-with-dashes.md` — 4-digit zero-padded sequential index, lowercase, dashes. Pick the next free number; do not reuse retired ones.

### Required front matter

```yaml
---
status: { proposed | accepted | rejected | deprecated | superseded by ADR-NNNN }
date: { YYYY-MM-DD }
decision-makers: { names or roles }
consulted: { subject-matter experts — `none` if none }
informed: { stakeholders — `none` if none }
---
```

### Required sections

1. **Context and Problem Statement**
2. **Considered Options**
3. **Decision Outcome**

Recommended: Decision Drivers, Pros and Cons of the Options, Consequences, Confirmation, More Information.
