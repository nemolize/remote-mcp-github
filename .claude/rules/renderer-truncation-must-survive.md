# Renderer Truncation — Must-Survive Fields Go on the Preserved Side

## Rule

Any renderer whose output passes through `truncate` / `truncateTail`
(`src/mcp/response.ts`, cap `MAX_RESPONSE_CHARS = 8000`) must classify its
output into two kinds of line and place them accordingly:

| Kind | Examples | Placement |
|---|---|---|
| **Must-survive** | abort / partial-progress warnings, counts, pagination cursors, error state | On the **preserved** side of the cut |
| **Droppable** | unbounded per-item name lists, per-row detail, verbose bodies | Anywhere after it |

"Preserved side" is direction-dependent — do not hardcode "put the summary
first":

- `truncate` keeps the **head** → must-survive fields go *before* any unbounded
  list.
- `truncateTail` keeps the **tail** (used where the signal is at the end, e.g.
  workflow-job logs) → must-survive fields go *after*.
- A trailing suffix that must survive head-preserving truncation (the
  `cursorMoreHint` case) → **reserve its `.length` from the budget**, per the
  comment on `cursorMoreHint` citing #50.

## Why

Under-cap tests cannot expose this class. `clone_labels` shipped with its
`⚠ stopped before finishing` warning — and then, after a partial fix, its
`updated` / `skipped` count lines — sitting behind an unbounded per-label name
list. A large clone would drop them, rendering an interrupted copy as a
completed one. 533 unit tests passed and a live E2E at N=17 labels passed 6/6;
both ran far under the 8000-char cap, so neither could fire. #50 is the same
defect on the pagination cursor.

## How to apply

- Adding or editing a renderer that ends in `text(truncate(...))` → ask which
  lines a reader must still see when the output is cut, and put them on the
  preserved side.
- Fixed-size summary + unbounded list in one block → split them (counts as their
  own lines, names separately) rather than interleaving `count: names` pairs,
  so the counts survive independently of the list length.
- Add a test whose rendered input **exceeds** `MAX_RESPONSE_CHARS` asserting each
  must-survive field is still present. A test at realistic N proves nothing here.
- Fixing one instance of this shape → scan the rest of the same render block; the
  `clone_labels` warning and its count lines were two instances three lines apart,
  and fixing only the flagged one cost a second review round.
