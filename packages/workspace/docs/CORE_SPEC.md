# Core Specification

`@velaros-ai/workspace` is the workspace kernel inside Velaros Agent OS. It owns workspace facts, snapshots, target resolution, edit transactions, validation, rollback, batch execution and plugin runtime.

It does **not** own model calls, global memory, UI approvals, context ranking, sandbox implementation or language intelligence. Those are connected by providers and plugins.

## Invariants

1. The file system snapshot is the source of truth.
2. Reads and writes are separate.
3. Targets are versioned with `baseRevision`.
4. Edits are prepared before they are applied.
5. Transactions are reversible.
6. Same-file writes are queued by kernel file locks during apply/rollback.
7. A stale base revision is never silently overwritten; the kernel either safely replays a narrow edit intent or returns `BASE_REVISION_MISMATCH`.
8. Plugins must return prepared patches; they must not mutate files directly.
9. Agents should use workflow tools, not raw overwrite operations.

## Stable objects

- `FileSnapshot`
- `ResolvedTarget`
- `EvidencePack`
- `PreparedPatch`
- `PreparedTransaction`
- `ValidationResult`
- `BatchResult`
- `WorkspaceError`

## Stable workflow

```text
read/search -> resolveTarget -> buildEvidencePack -> prepareEdit -> applyEdit -> validate -> rollback/continue
```

## Revision and write queue contract

Every `FileSnapshot` carries a `sha256` and `revision`. The `revision` is the change id that edit preparation and apply checks use to detect stale work.

`applyEdit` acquires a per-file lock for all changed files in the transaction. If another transaction is already writing the same path, the later transaction waits in the kernel queue. When the queued transaction runs, each prepared patch is checked against the current file revision:

- If the revision still matches, the patch is written as prepared.
- If the revision changed and the original operation is replayable, the kernel rebuilds the patch against the latest snapshot and records the file in `ApplyResult.rebasedFiles`.
- If the revision changed and replay is not provably safe, the kernel throws `BASE_REVISION_MISMATCH` with a suggested action to re-read and retry.

Replayable operations are intentionally conservative: unique text replacement/deletion, symbol edits, anchored insertion, import add/remove, and append/prepend. File deletes, renames, JSON patch and range-only edits should be treated as stale when their base revision changes.
