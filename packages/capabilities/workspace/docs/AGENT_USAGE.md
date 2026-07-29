# Agent Usage

Agents should use a safe workspace loop:

```text
1. List or search to locate candidates.
2. Check lightweight file metadata before reading content.
3. Read bounded ranges only.
4. Resolve a precise target.
5. Build a compact evidence pack.
6. Produce an edit intent.
7. Prepare a transaction and review the diff.
8. Apply the transaction.
9. Validate the result.
10. Roll back or repair if needed.
```

Use `createAgentTools(workspace)` for an agent-safe tool surface. It exposes:

```text
ws_status
ws_read
ws_file_stat
ws_list_files
ws_search
ws_symbols
ws_resolve_target
ws_build_evidence
ws_prepare_edit
ws_amend_edit
ws_commit_edit
ws_apply_edit
ws_validate
ws_rollback
ws_diff
ws_run_batch
```

Recommended inspect flow:

1. `ws_list_files` or `ws_search` to locate candidates.
2. `ws_file_stat` for lightweight metadata before content reads.
3. `ws_read` with `range`, `maxBytes`, or pagination for bounded content.
4. `ws_resolve_target` to turn a path/query/range into a target id.
5. `ws_build_evidence` to package nearby context, revision, and citation.

Use `ws_build_evidence` after a target is known. It is responsible for nearby context, revision, and citation; it is not a general symbol/import/caller expansion tool.

Do not expose raw `write_file`, `replace_lines` or `overwrite_file` as default model tools.

For `ws_prepare_edit`, each item should contain `operation`.
Use `targetId` when you already resolved a target. Otherwise put the relative
path inside `operation.path`, not beside `operation`:

```json
{
  "operations": [
    {
      "operation": {
        "type": "replace_text",
        "path": "src/auth.ts",
        "oldText": "return false",
        "newText": "return true"
      }
    }
  ]
}
```

Use `ws_amend_edit` to repair a prepared transaction, and
`ws_commit_edit` when a caller wants the same runner to prepare,
validate and apply a bounded edit in one call.

## Concurrent file edits

`snapshot.revision` is the authoritative change id for a file snapshot. It is derived from the path, content hash, mtime and size. Agents should pass recent revisions into edit preparation when available, and treat `BASE_REVISION_MISMATCH` as a hard signal to re-read the affected file before preparing a new transaction.

The kernel owns same-file write coordination. `apply_edit` requests a per-file lock; overlapping writes are queued and resumed by the kernel instead of being handed to another worker or session to resolve. If a queued transaction reaches the front and the file revision no longer matches the patch base revision, the kernel will try to replay safe operations against the latest snapshot. If replay cannot be proven safe, the apply fails with `BASE_REVISION_MISMATCH` and the agent that owns the edit must re-read and retry.

Queue-friendly operations are useful only when the agent knows another project thread, session thread or team worker may be editing the same file at the same time. In ordinary single-agent editing, choose the operation that most directly expresses the task.

Prefer these operations for known same-file concurrency when they fit the edit:

- `replace_text` or `delete_text` with unique `oldText`
- symbol operations such as `replace_symbol`, `insert_before_symbol` and `insert_after_symbol`
- `insert_text_at_anchor` with unique `anchorText`
- `add_import` / `remove_import`
- `append_text` / `prepend_text` for naturally appended or prepended text

Do not use `append_text` or `prepend_text` to fake structured code insertion, and do not prefer line/range based edits in a known same-file concurrency case when a unique text, symbol or import anchor is available.
