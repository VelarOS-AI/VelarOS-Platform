# @velaros-ai/workspace

[中文接口文档](./docs/api.zh-CN.md)

`@velaros-ai/workspace` is the standalone Workspace subsystem for **VelarOS**. It gives products and agents a safe, transaction-based way to inspect and edit a local project without letting the model directly overwrite files.

This repository intentionally publishes exactly one package. The transaction engine,
providers, CLI, plugins and optional Agent integration are subpath exports of
`@velaros-ai/workspace`; there is no second `workspace-agent-tools` package.

The package is designed as an injectable **Workspace capability**, not as an agent brain.
VelarOS Kernel or another host owns model calls, memory, long-term context, policy
orchestration and UI. Workspace owns file facts, snapshots, target resolution, patch
transactions, validation, rollback, batch execution and plugin extension points.

## Responsibility

`@velaros-ai/workspace` owns the transaction-safe workspace kernel: file snapshots, target resolution, edit preparation/application, validation, rollback, provider contracts, plugins, CLI, MCP-like adapters and test helpers.

## Public Imports

- `@velaros-ai/workspace`
- `@velaros-ai/workspace/contracts` — browser-safe DTOs, root-source rules and tool names
- `@velaros-ai/workspace/plugins`
- `@velaros-ai/workspace/providers`
- `@velaros-ai/workspace/agent-tools`
- `@velaros-ai/workspace/agent`
- `@velaros-ai/workspace/cli`
- `@velaros-ai/workspace/plugins/jsts`
- `@velaros-ai/workspace/plugins/tree-sitter`
- `@velaros-ai/workspace/plugins/validation`
- `@velaros-ai/workspace/plugins/lsp`
- `@velaros-ai/workspace/plugins/typescript`
- `@velaros-ai/workspace/velaros`
- `@velaros-ai/workspace/mcp`
- `@velaros-ai/workspace/testing`
- `@velaros-ai/workspace/presets`
- `@velaros-ai/workspace/result`

## Boundary

This package must stay independently publishable and repository-independent. It must not
own product IPC, Electron UI, agent loop orchestration, memory/knowledge storage, model
adapters, or product state. Hosts compose those capabilities around Workspace through
providers. The optional `@velaros-ai/workspace/agent` export adapts those ports to the
host's generic Agent extension points without moving Workspace ownership into
Kernel. Workspace owns its public file/project DTOs, tool names, root-source
rules, visibility/indexing policy, verification failure shape, sandbox
lifecycle port, and Agent-facing Workspace capability port.

Renderer、Web Worker、RPC schema 和纯前端测试应从
`@velaros-ai/workspace/contracts` 导入共享契约。该入口不会引入文件系统、命令执行、
provider 实现或其他 Node.js 宿主能力；完整事务运行时仍从包根入口导入。

## What this version includes

This build is intended to be usable as a serious first production integration point:

- transaction-safe workspace kernel;
- snapshot/revision system;
- read, search, symbol listing and target resolution;
- prepare/apply/validate/rollback edit lifecycle;
- base-revision checks, per-file write queues and conservative replay for safe queued edits;
- batch DAG execution with bounded concurrency, dependency handling, atomic rollback and resource conflict checks;
- audit journal;
- hook, pipeline, adapter, patch strategy and validator registries;
- provider boundary for Velaros policy/context/approval/file filtering/secret redaction/command execution/sandbox/telemetry;
- agent-safe tool surface;
- MCP-like tool adapter;
- Velaros bridge;
- text, JSON, Markdown and generic code adapters;
- JS/TS code plugin with AST-backed symbol discovery, method/function/class/interface/type/import resolution and symbol patching;
- optional Tree-sitter provider plugin;
- optional LSP provider plugin;
- command validation plugin for Prettier, ESLint, `tsc` and custom validators;
- CLI;
- tests and examples.

## Install

```bash
npm install @velaros-ai/workspace
```

For local development:

```bash
npm install
npm run build
npm test
```

## Quick start

```ts
import { createRecommendedWorkspace } from '@velaros-ai/workspace'

const workspace = await createRecommendedWorkspace({
  root: process.cwd(),
})

const target = await workspace.resolveTarget({
  path: 'src/auth.ts',
  target: {
    symbol: {
      kind: 'method',
      container: 'AuthService',
      name: 'refreshToken',
    },
  },
  expectedMatches: 1,
})

if (target.status !== 'resolved') throw new Error(target.reason)

const tx = await workspace.prepareEdit({
  operations: [
    {
      targetId: target.target.targetId,
      operation: {
        type: 'replace_symbol',
        replacement: `refreshToken(token: string) {
  if (!token) return ""
  return verify(token)
}`,
      },
    },
  ],
})

console.log(tx.diff)

await workspace.applyEdit({ transactionId: tx.transactionId })
await workspace.validate({ transactionId: tx.transactionId, checks: ['typescript.syntax'] })
```

## Velaros Agent OS integration

```ts
import {
  createVelarosWorkspaceBridge,
  typescriptPlugin,
  validationPlugin,
} from '@velaros-ai/workspace'

const bridge = await createVelarosWorkspaceBridge({
  root: process.cwd(),
  velaros,
  autoRegisterTools: true,
  plugins: [typescriptPlugin(), validationPlugin({ eslint: true, tsc: true })],
})

// Velaros receives tools and can expose them to agents.
const { workspace, tools, mcp } = bridge
```

The bridge maps Velaros providers into workspace providers:

- `policy`
- `approval`
- `fileFilter`
- `secretRedaction`
- `context`
- `command`
- `sandbox`
- `telemetry`
- `logger`

## Agent tool flow

Do not expose raw `write_file` or `replace_lines` tools to models. Use the workspace protocol:

```text
list_files/search
  -> file_stat
  -> bounded read
  -> resolve_target
  -> build_evidence
  -> prepare_edit
  -> review diff
  -> apply_edit
  -> validate
  -> rollback if needed
```

```ts
import { createAgentTools } from '@velaros-ai/workspace'

const tools = createAgentTools(workspace)
```

For model-facing discovery payloads, prefer the compact schema bundle so common
operation structures are emitted once under `$defs` instead of repeated in every
tool schema:

```ts
import { createAgentTools, createWorkspaceToolSchemaBundle } from '@velaros-ai/workspace'

const bundle = createWorkspaceToolSchemaBundle(createAgentTools(workspace))
// bundle.tools[*].inputSchema may reference bundle.$defs through #/$defs/...
```

The exported tools include:

- `ws_status`
- `ws_read`
- `ws_file_stat`
- `ws_list_files`
- `ws_search`
- `ws_symbols`
- `ws_resolve_target`
- `ws_build_evidence`
- `ws_prepare_edit`
- `ws_amend_edit`
- `ws_commit_edit`
- `ws_apply_edit`
- `ws_validate`
- `ws_rollback`
- `ws_diff`
- `ws_run_batch`

Recommended inspect flow:

1. `ws_list_files` or `ws_search` to locate candidates.
2. `ws_file_stat` for lightweight metadata before content reads.
3. `ws_read` with `range`, `maxBytes`, or pagination for bounded content.
4. `ws_resolve_target` to turn a path/query/range into a target id.
5. `ws_build_evidence` to package nearby context, revision, and citation.

`ws_commit_edit` uses the same operation shape as
`ws_prepare_edit`, but performs prepare + overlay validation +
low-risk apply in one call. `ws_amend_edit` appends follow-up
operations to an existing transaction. When you do not pass a resolved
`targetId`, put the path inside `operation.path`:

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

### Concurrent edits

The kernel coordinates overlapping writes at `apply_edit` time. Same-file applies wait in a per-file queue, then compare the prepared patch base revision with the current file revision. If the operation can be safely replayed against the latest snapshot, the apply result includes `rebasedFiles`; otherwise the kernel returns `BASE_REVISION_MISMATCH` and the owning agent must re-read and prepare a fresh transaction.

Agents should only prefer replay-friendly operations when same-file concurrency is known or likely. In normal single-agent editing, use the operation that best expresses the change. When another session or team worker may edit the same path, prefer unique `oldText`, unique `anchorText`, symbol operations, import operations, or natural `append_text` / `prepend_text` edits when they fit.

## Plugin usage

### JS/TS AST plugin

```ts
import { createWorkspace, typescriptPlugin } from '@velaros-ai/workspace'

const workspace = await createWorkspace({
  root: process.cwd(),
  plugins: [typescriptPlugin()],
})
```

Supported JS/TS operations:

- list symbols;
- resolve functions, methods, classes, interfaces, types, variables and imports;
- replace symbol;
- insert before/after symbol;
- add named/default/namespace/side-effect imports;
- remove imports;
- syntax validation.

### Command validation plugin

```ts
import { validationPlugin } from '@velaros-ai/workspace'

const workspace = await createWorkspace({
  root: process.cwd(),
  plugins: [
    validationPlugin({
      prettier: true,
      eslint: true,
      tsc: true,
    }),
  ],
})
```

Command execution can be routed through Velaros by providing a `command` provider.

### Tree-sitter provider plugin

Workspace does not bundle native Tree-sitter parsers. You inject a provider:

```ts
import { treeSitterPlugin } from '@velaros-ai/workspace/plugins/tree-sitter'

const workspace = await createWorkspace({
  root,
  plugins: [
    treeSitterPlugin({
      provider: {
        id: 'my-tree-sitter',
        listSymbols({ content }) {
          return []
        },
      },
    }),
  ],
})
```

### LSP provider plugin

Workspace does not own language servers. Velaros or your runtime can inject one:

```ts
import { lspPlugin } from '@velaros-ai/workspace/plugins/lsp'

const workspace = await createWorkspace({
  root,
  plugins: [
    lspPlugin({
      provider: {
        async listSymbols({ path, content }) {
          return []
        },
        async diagnostics({ path, content }) {
          return []
        },
      },
    }),
  ],
})
```

## Batch concurrency

```ts
const result = await workspace.runBatch({
  concurrency: 4,
  atomic: true,
  tasks: [
    { id: 'read-a', op: { kind: 'read', input: { path: 'src/a.ts' } } },
    { id: 'read-b', op: { kind: 'read', input: { path: 'src/b.ts' } } },
    {
      id: 'validate',
      dependsOn: ['read-a', 'read-b'],
      op: { kind: 'validate', input: { paths: ['src/a.ts', 'src/b.ts'] } },
    },
  ],
})
```

Batch supports:

- dependencies;
- bounded concurrency;
- resource metadata;
- conflict detection for overlapping read/write or write/write resources;
- optional atomic rollback of applied transactions.

## CLI

Human-friendly commands:

```bash
velaros-workspace status
velaros-workspace read src/index.ts --start 1 --end 40
velaros-workspace search refreshToken
velaros-workspace symbols src/auth.ts
velaros-workspace resolve src/auth.ts --symbol refreshToken --kind function
velaros-workspace prepare-edit --input edit.json
velaros-workspace commit-edit --input edit.json
velaros-workspace validate --paths src/auth.ts
```

Machine-oriented commands return stable JSON envelopes by default:

```bash
velaros-workspace tools list
velaros-workspace tools call ws_read --args-json '{"path":"src/index.ts","maxBytes":4000}'
velaros-workspace tools workflow --steps-file workflow.json
```

`tools list` returns the same compact schema bundle shape as
`createWorkspaceToolSchemaBundle`: `schemaVersion`, top-level `$defs`, and
`tools`. This keeps large edit operation schemas model-visible without sending
the same structure repeatedly.

Every human command also supports `--json` for scripted use.

## 1.0 release gate

Before publishing a 1.0 candidate, run:

```bash
npm --workspace @velaros-ai/workspace run preflight:1.0
```

The gate runs the workspace package tests, eval tests, compact schema budget
check, tool file boundary tests, the changed-file tool boundary arch guard, and
a whitespace diff check for the workspace and arch-guard changes.

## Package boundaries

Core owns:

- file snapshots and revisions;
- read/search dispatch;
- target resolution protocol;
- evidence-pack protocol;
- patch transaction lifecycle;
- apply/rollback;
- locks and conflict checks;
- batch execution;
- plugin registries;
- audit journal;
- error taxonomy.

Core does not own:

- model calls;
- long-term memory;
- global Velaros context orchestration;
- product UI;
- project-specific permission policy;
- native Tree-sitter parsers;
- language server lifecycle;
- sandbox/worktree implementation;
- domain-specific document adapters.

Those are providers or plugins.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Velaros integration](docs/VELAROS_INTEGRATION.md)
- [Agent protocol](docs/AGENT_INTEGRATION.md)
- [JS/TS plugin](docs/JSTS_PLUGIN.md)
- [Batch concurrency](docs/BATCH_CONCURRENCY.md)
- [Plugin authoring](docs/PLUGIN_AUTHORING.md)
- [Production readiness](docs/PRODUCTION_READINESS.md)
- [API reference](docs/API.md)
