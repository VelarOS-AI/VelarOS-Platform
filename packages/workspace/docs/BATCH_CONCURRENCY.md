# Batch concurrency

The batch runner executes a DAG of workspace tasks with bounded concurrency.

```ts
await workspace.runBatch({
  concurrency: 4,
  atomic: true,
  conflictCheck: true,
  tasks: [
    { id: "a", op: { kind: "read", input: { path: "src/a.ts" } } },
    { id: "b", op: { kind: "read", input: { path: "src/b.ts" } } },
    { id: "validate", dependsOn: ["a", "b"], op: { kind: "validate", input: { paths: ["src/a.ts", "src/b.ts"] } } },
  ],
})
```

## Resource metadata

For custom tasks or external schedulers, declare `resources` metadata:

```ts
{
  id: "edit-auth",
  resources: ["src/auth.ts"],
  op: { kind: "prepare", input: prepareInput },
}
```

The kernel's authoritative protection is still transaction data and file locks:

- In regular DAG mode, dependencies decide scheduling and `applyEdit` queues overlapping writes by file path.
- In `mode: "prepare-then-apply"`, non-apply tasks run first; prepared transactions are checked for overlapping changed files/ranges before apply tasks run.
- `conflictCheck: false` disables that prepared-transaction conflict check, but does not disable per-file apply locks.

## Same-file apply queue

`applyEdit` is safe to run from multiple batch tasks, sessions or team workers. The kernel serializes same-file writes with per-file locks. If the file revision changed while a task waited in the queue, the kernel may replay narrow operations such as unique text edits, symbol edits, import edits, `insert_text_at_anchor`, `append_text` or `prepend_text`. If replay is not safe, the task fails with `BASE_REVISION_MISMATCH` and should be re-read/reprepared by its owner.

## Atomic rollback

If `atomic: true`, applied transactions are rolled back in reverse order when a batch task fails.

## Recommended multi-file edit protocol

```text
batch read/search
batch resolve
batch prepare
review global diff
batch apply
batch validate
commit or rollback
```
