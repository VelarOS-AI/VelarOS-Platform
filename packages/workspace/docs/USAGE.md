# Usage Guide

## Create a workspace

```ts
import { createWorkspace } from "@velaros-ai/workspace"

const workspace = await createWorkspace({ root: process.cwd() })
```

## Read a file

```ts
const result = await workspace.read({
  path: "src/index.ts",
  range: { startLine: 1, endLine: 80 },
})

console.log(result.snapshot.revision)
console.log(result.content)
```

## Search

```ts
const result = await workspace.search({
  query: "refreshToken",
  maxResults: 20,
})
```

## Resolve a target

Exact snippet:

```ts
const target = await workspace.resolveTarget({
  path: "src/auth.ts",
  target: { exactSnippet: "function refreshToken" },
  expectedMatches: 1,
})
```

Symbol target using the generic code adapter:

```ts
const target = await workspace.resolveTarget({
  path: "src/auth.ts",
  target: {
    symbol: { kind: "function", name: "refreshToken" },
  },
})
```

## Prepare an edit

```ts
if (target.status === "resolved") {
  const tx = await workspace.prepareEdit({
    operations: [
      {
        targetId: target.target.targetId,
        operation: {
          type: "replace_text",
          oldText: "return false",
          newText: "return true",
        },
      },
    ],
  })

  console.log(tx.diff)
}
```

## Apply and validate

```ts
await workspace.applyEdit({ transactionId: tx.transactionId })

const validation = await workspace.validate({
  transactionId: tx.transactionId,
  postconditions: [
    { type: "must_contain", value: "return true" },
  ],
})

if (!validation.ok) {
  await workspace.rollback({ transactionId: tx.transactionId })
}
```

## Handling concurrent edits

Each read result includes `snapshot.revision`. If a file changes between `prepareEdit` and `applyEdit`, the kernel checks the prepared patch against the current revision after acquiring the per-file write lock.

For normal single-agent edits, use the clearest operation for the task. When you know another worker or session may edit the same file concurrently, prefer operations that can be replayed safely:

```ts
const tx = await workspace.prepareEdit({
  baseRevision: read.snapshot.revision,
  operations: [
    {
      operation: {
        type: "insert_text_at_anchor",
        path: "src/index.ts",
        anchorText: "export function start()",
        position: "before",
        text: "const startedAt = Date.now()\n",
        expectedMatches: 1,
      },
    },
  ],
})

const result = await workspace.applyEdit({ transactionId: tx.transactionId })

if (result.rebasedFiles?.includes("src/index.ts")) {
  await workspace.read({
    path: "src/index.ts",
    range: { startLine: 1, endLine: 120 },
  })
}
```

If `applyEdit` throws `BASE_REVISION_MISMATCH`, re-read the affected path and prepare a new transaction from the latest revision. Do not keep retrying the stale transaction.

## JSON patch

```ts
const tx = await workspace.prepareEdit({
  operations: [
    {
      operation: {
        type: "json_patch",
        patches: [
          { op: "replace", path: "/version", value: "0.2.0" },
        ],
      },
    },
  ],
})
```
