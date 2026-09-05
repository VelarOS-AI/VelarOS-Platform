# Platform 0.6.13 migration

This document describes the source and API changes prepared for the 0.6.13 release train. Package publication, registry availability, and consumer installation are pending verification. The version table is the release target, not a publication receipt.

## Package targets

| Package | Target version | Migration scope |
| --- | --- | --- |
| `@velaros-ai/agent` | `0.6.9` | Shared execution stack, host lifecycle and retry hooks, tool-call identity, shared discovery contract, execution correctness fixes. |
| `@velaros-ai/model` | `0.5.0` | Generic `ModelRequestClient`; scenario ownership moves to callers. |
| `@velaros-ai/computer` | `0.2.11` | Public operation and permission metadata. |
| `@velaros-ai/development` | `1.1.0` | Narrow language inspection context. |
| `@velaros-ai/project` | `2.0.8` | Directory helper accepts only its required project port. |
| `@velaros-ai/memory` | `0.4.0` | Independent backend mounting and explicit optional tree governance. |
| `@velaros-ai/browser` | `0.2.16` | Updated dependency closure for this train. |
| `@velaros-ai/office` | `1.1.5` | Updated dependency closure for this train. |
| `@velaros-ai/system` | `1.1.5` | Updated dependency closure for this train. |

The release train and individual package versions are separate identifiers. Use the package versions above when updating dependency manifests, while preserving each consumer's existing range policy.

## Agent execution and host lifecycle

Use `createAgentExecutionStack` from `@velaros-ai/agent` as the shared assembly entry. It pairs ModelRuntime, TurnRunner, RunContext, SoloLoop, and an optional QueryLoop with the same tool registry, governance sessions, prompt policy, execution limits, and observation seams. Call `executeSolo` directly for a host-owned run; enable the query options when using `createRunner` or `executeQuery`.

`capabilityPorts.allocation.baselineToolNames` is a host visibility policy: include only tools approved for the current turn. Termel and Workbench supply their admitted baseline; Desktop uses its resident discovery tools and paging policy. Preserve those product choices when adapting a registry. The `context.describeToolInputSchema` getter serves discovery and tool-space details and should read the corresponding frozen registry view.

Provider request auditing materializes the actual definitions in that turn's `aiTools` through the SDK's `asSchema`, including asynchronous schemas. Both StreamTurn and QueryTurn await this shared helper. If a provider is unloaded or a same-name tool is replaced during asynchronous context preparation, the current request retains its captured schema and visible tool set. Execution still checks the live registration signature and rejects a stale call.

`AgentRunLifecycle` and `AgentModelRetryPolicy` are per-run `executeSolo` arguments. They are not factory configuration:

- `beforeTurn` is awaited before the turn captures its tool surface and compiles a model request. Hosts can apply pending input, compact their history, and refresh their tool surface here.
- `onTurnSettled` is awaited after assistant and tool results enter history, before another request. It receives the turn result and can return `continue`, `stop`, or no override. Hosts retain persistence, usage accounting, and product continuation policy at this boundary.
- A lifecycle failure propagates through the execution path; successful settlement is not a substitute for a host storage commit receipt.
- Call `clearSession(sessionId)` when disposing a run-scoped stack or permanently clearing a session. This releases execution state and invalidates its governance session.

The shared model retry loop always rejects replay after cancellation, an abort error, visible output, or tool use. With a custom policy, emitted reasoning also blocks a connection retry. A custom `modelRetry.onFailure` runs only after those checks; it returns a non-negative finite `delayMs`, or `null` to stop. The host owns its retry budget, error classification, and provider fallback selection. Retry delays remain abortable. Set `allowPartialContinuation: false` to disable partial-response continuation and the outer follow-up turn for malformed or interrupted tool arguments. Together these rules prevent a policy-controlled run from restarting after emitted reasoning or bypassing its stop decision through an outer recovery turn.

`ToolExecutionPolicyContext.toolCallId` carries the model call's identity into the derived execution context. It remains optional on a base context because that context exists before a tool call; the shared executor supplies it for a dispatched call. Host bridges must forward this identity to approval, tool execution, and durable records rather than generate a replacement ID. Tool-call history, the result, and host records can then refer to the same invocation.

The Agent package also contains the earlier cancellation, call/result finalization, run-scoped loop guard, and context replay fixes. Consumers must validate the official package artifact that contains these fixes when replacing a package patch.

## Termel host integration

Termel's `packages/termel-runtime/src/agent-execution-stack.ts` adapts its host ports to the shared factory. Both primary runs and worker runs in `agent-service.ts` enter this adapter. The model receives tool schemas; Platform's executor dispatches the actual calls using the original `toolCallId` and abort signal.

Termel continues to own session events and durable history, steering input, history compaction policy, usage and budgets, provider selection and fallback, worker workspaces, and local/remote approval. The primary run connects these controls through the lifecycle and retry hooks. Workers explicitly disable model retry and partial continuation. This preserves product policy while giving both paths the same turn, tool, cancellation, and finishing implementation.

This integration is a source migration. Its release acceptance requires running the consumer against the published Agent package, including primary and worker execution; a workspace-source test alone is insufficient.

## Model request clients and scenario ownership

`ModelRequestClient` is the generic request API exported from `@velaros-ai/model`. It provides `generateText`, `streamText`, `generateObject`, and `collectTextStream`, using an injectable transport and generic request options. Its `endpoint` is a caller-defined observability label, not a required product scenario identifier.

```ts
import { ModelRequestClient } from '@velaros-ai/model'

const client = new ModelRequestClient({ transport })
const text = await client.generateText({
  endpoint: 'example.summary',
  model,
  system: summaryInstructions,
  prompt: sourceText,
  abortSignal,
})
```

The example assumes the caller supplies its transport, resolved model, instructions, input, and signal. Product code owns prompt content, schemas, input bounds, timeout policy, output validation, and scenario fallback:

| Caller | Scenario owner |
| --- | --- |
| Desktop chat | Thinking translation, handoff briefs, suggestions, and pure chat requests. |
| Desktop Agent integration | Context distillation and sub-agent guidance relay. |
| Desktop scheduled tasks | Schedule rule generation and task ledger summaries. |
| Desktop project integration | Git commit messages. |
| Workbench language integration | Inline completion, cursor context, output limits, and empty-result fallback. |

`ModelRequestService` and `ModelRequestServiceOptions` remain deprecated aliases for the generic client and its options. The aliases preserve constructor/type imports; they do not restore the former business scenario methods. Migrate those calls to the generic operation and move the associated prompt, schema, limits, and result handling into the existing scenario owner before upgrading to Model `0.5.0`.

Provider resolution and generic request conversion remain in Model. Agent keeps its turn-oriented request port and replay safety; adopting the client does not transfer the Agent execution loop into Model.

## Development and Project ports

`LanguageToolContext` no longer aliases the full `ProjectToolContext`. Its public shape is:

```ts
interface LanguageToolContext {
  abortSignal: AbortSignal
  project: {
    getRootPath(): string
    runInDirectory<T>(path: string, action: () => Promise<T>): Promise<T>
    kernel(): Promise<LanguageReadPort>
  }
}
```

`LanguageReadPort` selects `listFiles`, `read`, and `listSymbols` from the public Project kernel port. Pass this context to `executeProjectCodeLanguageQuery`; a standalone language inspection host only supplies directory scoping, reads, and cancellation. The Project `runInProjectDirectory` helper similarly requires only `project.runInDirectory`.

Existing full Project contexts structurally satisfy the smaller language context. The optional Project code graph composition still accepts its Project context at that integration boundary. Keep that context where graph composition needs it; standalone language inspection does not need the graph or a full Agent tool context.

## Memory authority and explicit tree governance

`mountMemoryAdapter` from `@velaros-ai/memory/adapter-kernel` accepts either an already assembled `backend` or the existing `store` registry selection port. The two selection sources are mutually exclusive. The selected backend must be an authority backend with the required memory verbs.

Tree governance is independently enabled by `tree: { domain, idleSignal }`. Without it, mounting an independent backend does not require a `MemoryDomain` and does not create tree warmup, Dream, or idle scheduling. Capture and recall still use the selected authority backend.

```ts
// Independent authority backend.
const standalone = mountMemoryAdapter({ backend, config, hostContext })

// Explicitly combine that authority backend with tree governance.
const governed = mountMemoryAdapter({
  backend,
  config,
  hostContext,
  tree: { domain, idleSignal },
})
```

Migrate former top-level `domain` and `idleSignal` arguments into `tree`. `MemoryAdapterRuntime.service` is now nullable, so warmup and shutdown callers must handle its absence. A UI that exposes tree-specific operations must report unavailable when tree governance is absent. If no backend resolves, fallback is allowed only when an explicit tree is present; otherwise mounting fails. Invalid or ambiguous authority selection also fails explicitly.

The backend's name does not enable or disable governance. Desktop explicitly supplies both its assembled backend and `tree` to retain its existing tree IPC, warmup, and lifecycle behavior. A standalone backend host can omit `tree` entirely.

## Shared tool discovery and Computer permissions

Import `ToolContractDiscoveryDescriptors` and `readToolSchemaDiscoveryNames` from `@velaros-ai/agent/tool-contract`. The shared `tooling:schema` request is `{ names: string[] }`, with 1–12 names. Hosts must migrate a former single `toolName` request and return the current schemas and missing names under their existing catalog visibility policy. Platform's facade and Termel's gateway consume the same discovery descriptors.

Import `ComputerOperationMetadata` and `ComputerToolOperations` from `@velaros-ai/computer/contracts`. The first defines operation permissions and reasons; the second maps public tool names to operations. Computer's kernel module and Termel's discovery projection use this metadata together. Hosts still enforce their own local or remote permission and approval boundary; metadata is not an approval receipt.

## Official package rollout and evidence

Replace the prior fixed-version Agent Bun patch with the official package only after the target version is readable from the configured registry and its artifact contains the fixes. Update dependency manifests and lockfiles together, then remove the obsolete Agent patch registration and file. Preserve unrelated package patches. Do not use a sibling source import, local `dist`, or `file:`/`link:` dependency as evidence of an official-package upgrade.

Follow [the consumer update workflow](platform-consumer-updates.md) for publication visibility, targeted lockfile updates, frozen installation, and consumer validation. Record each stage separately:

| Stage | Current evidence status |
| --- | --- |
| API and host source migration | Implemented in the working changes described above. |
| Candidate source validation | Platform builds, type checks, tests, and suites passed; lint and all 37 architecture/style checks passed. Remaining release gates are still running. Desktop candidate checks passed all 19 type partitions and its build. |
| Provider schema snapshot regression | 32 focused tests passed, including unload/replacement during context preparation and Solo/Query execution. Two probes using Desktop's real ToolRegistry preserved the original schema and rejected stale execution after unload or replacement. Scoped lint and all 37 architecture/style checks passed for the changed files. |
| Target package versions | Listed in this document; publication evidence pending. |
| Registry visibility and packed public exports | Pending release verification. |
| Desktop, Workbench, and Termel official-package installation | Pending consumer manifest, lockfile, and frozen-install evidence. |
| Official installed-package behavior and consumer checks | Pending results tied to the published versions; candidate source and earlier patch validation do not establish these results. |
| Real application and live-model acceptance | Performed by the product user after receiving the candidate build. |

Release verification should cover primary and worker execution, lifecycle persistence ordering, safe retry and fallback, cancellation, tool-call identity and results, shared schema/permission discovery, scenario outputs, and standalone versus tree-enabled memory mounting. Preserve the earlier storage receipt and stream recovery regression coverage when replacing the patch. Add actual package versions, registry receipts, consumer lock evidence, and check results to this section when available.
