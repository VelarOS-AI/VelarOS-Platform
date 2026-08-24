# 0001: Common kernel for Agent products

- Status: accepted and implemented
- Date: 2026-08-24
- Owners: Kernel, Agent, Model, Development, product hosts

## Context

VelarOS Desktop and VelarOS Termel are independent Agent products. Both consume Platform packages,
but Termel has accumulated reusable runtime implementations inside its product repository while
Desktop has separate implementations of the same mechanisms. This makes a third Agent product pick
one of two wrong dependencies: copy a product implementation, or depend on another product repository.

The boundary is not “everything shared lives in one process”. Platform remains library-first and
process-optional. A product owns its final composition root, user-facing policy, persistence adapter,
native lifecycle, data root, and UI. Platform owns host-neutral mechanisms, protocols, state machines,
and reusable capability implementations.

## Decision

Platform is the sole source owner for reusable Agent-product mechanisms. Related public surfaces are
added as subpaths of the existing domain package; no new top-level package is created merely to hold a
slice of Kernel, Agent, Model, or Development.

The target dependency shape is:

```text
Desktop / Termel / future Agent product
  -> product composition and adapters
  -> @velaros-ai/agent session, bridge, MCP, execution, skills and mod mechanisms
  -> @velaros-ai/model profile and usage mechanisms
  -> @velaros-ai/kernel serve, client and remote-node transport
  -> capability packages, including @velaros-ai/development language services
```

Platform code never imports product source. Product-specific types must not appear in public Platform
APIs. A Platform service that needs persistence, secrets, native process control, UI, workspace
selection, or policy receives an explicit host port.

### Complete ownership and migration inventory

| Current implementation | Decision | Required action |
| --- | --- | --- |
| Termel `packages/remote-host/src/{shared,client,node}` | Kernel-owned remote-node transport | Move to `@velaros-ai/kernel/remote`, `/remote/client`, and `/remote/node`; remove the Termel package implementation. |
| Termel `packages/remote-host/src/composition` | Agent-owned projection of remote manifests into tools | Move to `@velaros-ai/agent/remote`; keep approval in the normal Agent tool path. |
| Termel `packages/remote-host/src/mcp` | Agent-owned MCP adapter over remote-node transport | Move to `@velaros-ai/agent/remote/mcp`; keep the executable entry in the product package. |
| Termel `serve-host/host.ts`, `attached-host.ts`, management IPC, config, paths and CLI | Product Host composition | Keep in Termel. They select capabilities, data roots, permissions, process shape, and user commands. |
| Termel `serve-host/remote-node.ts` | Product adapter | Keep only configuration, audit-path, permission, and tool-gateway binding; consume Platform remote-node transport. |
| Termel `serve-host/extension-bridge.ts` and Desktop `ExternalAgentBridgeService.ts` | Shared bridge server plus two product surface adapters | Move pairing, authenticated WebSocket lifecycle, bounded command queue, device state, cancellation, and protocol validation to `@velaros-ai/agent/bridge`; keep workspace selection, transcript projection, Kernel tool binding, and product status/UI in each product. |
| Platform stdio-only `McpClientConnection`, Termel `mcp.ts` and `mcp-oauth.ts`, Desktop `McpServerManager` | Agent-owned MCP runtime | Platform owns stdio, Streamable HTTP, SSE, resources, OAuth ports, connection state, refresh/retry, and tool projection. Products own server configuration UI, secret persistence, browser opening, callback presentation, and approval defaults. |
| Termel direct AI SDK orchestration in `agent-service.ts` | Existing Platform Agent runtime must be consumed | Replace direct `generateText`/`streamText`/tool loop composition with Platform model request and Agent runner/control-plane APIs. Keep Termel identity text, TUI events, and product controls as injected surface ports. |
| Termel `goals.ts`, `plans.ts`, `provider-retry.ts` | Duplicate of existing Platform mechanisms | Migrate to Platform goal/plan artifacts and `AgentConnectionRetryHelper`; delete the Termel state machines. |
| Termel `skills.ts` | Platform mechanism plus product discovery policy | Use `AgentSkillRepository` and file providers. Keep only Termel root discovery, auto-load defaults, and session selection adapter. |
| Termel `plugins.ts` and `termel.plugin.json` | Forked public extension protocol | Replace with the standard `.velarmod` envelope, scan/trust/install flow, Kernel pack catalog, and `AgentModLoader`. Keep Termel install commands and TUI. Do not keep a second manifest generation. |
| Termel `session-store.ts`, Desktop `ChatStateStore`, Platform session lane/ledger/protocol | Shared session lifecycle with product persistence adapters | Add `@velaros-ai/agent/session` catalog, metadata, lineage, archive, lease, recovery, and detached-task contracts/state machines. Termel SQLite and Desktop manifest/chunk stores remain adapters; no shared product database or product session-kind enum enters Platform. |
| Termel `questions.ts`, `permissions.ts`, `tool-policy.ts`, Desktop interaction/policy services | Existing Platform interaction, approval, and execution-policy mechanisms | Consume Platform ports and policy engine. Keep user-facing defaults, remembered decisions, headless behavior, and UI rendering in each product. |
| Termel detached/background Agents and worktree workers; Desktop background jobs/subagents | Shared lifecycle contracts, product process adapters | Put task identity, state, send/wait/stop, ownership, lease, and recovery contracts under Agent session. Keep OS detach/spawn and worktree creation in product/Project adapters. |
| Termel `providers.ts`, Desktop config normalizer and `ModelService` | Shared model profile and connection lifecycle | Add `@velaros-ai/model/profiles` with injected profile store, credential store, environment snapshot, catalog/probe ports, and explicit fallback policy. Products keep configuration layout, secure-storage choice, settings UI, and account policy. |
| Termel `usage.ts` and Desktop usage/observability projections | Shared normalization and pricing, product analytics | Put provider-neutral usage normalization and price calculation in Model; keep per-product event aggregation and presentation in products. |
| Termel `serve-host/language-service.ts` and Platform Development language runtime | Duplicate capability implementation | Move reusable external-language-server lifecycle and bounded diagnostics/navigation adapters into `@velaros-ai/development`; Termel keeps binary/resource discovery and Host status projection. |
| Termel `kernel-tools.ts`, `session-resources.ts`, `capabilities.ts` | Product adapters and policy | Keep in Termel, but route execution through Platform `ToolContractExecutionFacade`, Kernel client, and Project scope ports. Do not move Termel confirmation profiles or filesystem grants into Platform defaults. |
| Termel Browser/Remote session recorders | Product projection | Keep in Termel. The bridge and remote protocols are Platform-owned; the choice to materialize them as Termel sessions is a product decision. |
| Termel config, paths, safe mode, commands, TUI, accessibility, clipboard/editor, packaging/release | Product shell | Keep in Termel. |
| Desktop Electron IPC, windows, folders/spaces, renderer routes, settings, notifications and file/chunk layout | Product shell | Keep in Desktop. |

### Session boundary

The Platform session layer defines only product-neutral facts: stable session identity, optional parent
identity, timestamps, lifecycle state, owner/lease facts, opaque resource references, portable archive
envelopes, and detached-task state. Product labels such as `browser`, `remote`, Desktop folder/space
taxonomy, renderer state, and database layout remain outside the contract.

Queue/steer admission, the run coordinator, the append-only Agent ledger, and Kernel session controller
already live in Platform and must be reused rather than reimplemented.

### Host boundary

Platform may provide a standard host-neutral assembler, but it is not the product composition root. It
must accept modules, permission brokers, tool registries, bridge surface handlers, persistence paths,
and lifecycle hooks as ports. Termel continues to decide that its standalone Host combines Project,
System, Computer, language navigation, External Agent Bridge, Remote Node, and local management IPC.

### Policy boundary

Platform owns validation order, fail-closed behavior, permission/approval port shapes, tool schema and
lease validation, and protocol limits. Products own which capabilities are enabled, the default
permission mode, remembered user decisions, UI wording, and whether unresolved interaction is shown or
rejected in headless mode. A public service must not silently introduce a fallback provider, auto-
approval, remote endpoint, or credential source.

## Alternatives

1. Keep reusable Host and transport packages in Termel. Rejected because future Agent products would
   depend on another product and Termel would become an accidental Platform repository.
2. Move the entire Termel runtime into Platform. Rejected because it would make TUI behavior, product
   configuration, SQLite layout, and policy defaults into global semantics.
3. Create many top-level packages such as `remote-host`, `agent-session`, and `model-profiles`. Rejected
   because these are slices of existing versioned domains and should use public subpaths.
4. Preserve old Termel manifests and wrappers indefinitely. Rejected. This migration is a clean break;
   supported persisted user data receives an explicit importer where required, while obsolete public
   APIs and duplicate source owners are removed.

## Security and privacy

- Remote-node private keys, MCP OAuth tokens, model API keys, and pairing codes never enter public
  status, logs, model-visible state, or Platform-owned global storage.
- Remote calls pass the caller-side approval boundary before leaving the machine and the node-side
  Kernel permission broker before capability execution. No third shadow policy is added.
- Bridge and MCP endpoints bind to loopback unless a product explicitly supplies a different bounded
  transport. External messages are schema-validated and size-limited before dispatch.
- Session archives and usage projections use redaction/sanitization ports. Platform does not infer a
  product retention policy.
- Provider fallback is explicit and host-injected because it can change billing, privacy, and data
  residency.

## Compatibility and migration

The owner moves are performed owner-first: Platform APIs and conformance tests land before product
imports change. During local cross-repository validation, packed artifacts or temporary links may be
used; they are not release proof. A Platform package release must precede consumer lockfile upgrades.

`@velaros-ai/remote-host` and `termel.plugin.json` are retired rather than retained as permanent aliases.
Termel user plugins require a one-time explicit conversion/import into `.velarmod`; no package is
enabled without the standard scan, trust, and permission confirmation.

Product session databases are not rewritten into a shared format. Adapters project existing records to
the Platform session contracts, and portable exports use the versioned archive envelope.

## Validation

Completion requires all of the following evidence:

1. Platform build, typecheck, tests, architecture gates, schema snapshots, package catalog, and packed-
   consumer checks pass.
2. Termel typecheck, tests, build, headless/TTY contract tests, attach/remote-node tests, MCP transport and
   OAuth tests, session recovery tests, and plugin migration tests pass against the new Platform APIs.
3. Desktop architecture, migrations, Agent Mod, Kernel assembly, external bridge, MCP, node/web
   typechecks, and maintained tests pass against the same Platform APIs.
4. Repository scans show no product imports in Platform, no remaining `@velaros-ai/remote-host`, no
   live `termel.plugin.json` loader, no Termel direct AI SDK turn driver, and no duplicate Termel
   goal/plan/retry state machine.
5. Scoped diff inventories isolate the migration from unrelated Desktop and Platform worktree changes;
   any later commit must stage the migration's exact files rather than broad worktree state.

## Consequences

Future Agent products can compose the same remote transport, bridge, MCP, session, model-profile,
language, and execution mechanisms without depending on Desktop or Termel. Products retain freedom over
UX, native deployment, storage engines, and policy defaults. Platform packages gain more host ports and
conformance tests, but each reusable behavior has one source owner.

## Implementation record

The clean break landed owner-first in the existing domain packages:

- Kernel now publishes remote-node transport, client, node, authentication, replay, and isolation APIs;
  Termel's `@velaros-ai/remote-host` package and generated output are removed.
- Agent now publishes the External Agent Bridge state/server, multi-transport MCP connection, remote tool
  and MCP projection, product-neutral Session lifecycle/application services/archive, and the standard
  `.velarmod` scan/trust/install transaction.
- Model now owns profile credential resolution, provider-neutral retry planning, and usage normalization/
  pricing. Development now owns the external language-server lifecycle and bounded result projection.
- Termel consumes those APIs and keeps only product persistence, CLI/TUI, safe-mode and approval defaults,
  binary discovery, Host composition, and process adapters. Its public extension format is only
  `.velarmod`; goal/plan/retry compatibility files are re-exports, not second state machines.
- Desktop's external bridge and Mod archive files are product adapters over the same Agent mechanisms;
  its configuration normalizer consumes Model profile credential resolution.

Validation on the migration worktree covered Platform's full 17-package build, workspace typecheck/lint/
tests, schema and architecture gates, package catalog, prepack topology, and imports from real tarballs;
Termel's build/typecheck and all 233 runtime/product plus 11 packaging tests; and Desktop's repository-
wide typecheck, all 71 architecture checks, migration, Agent Mod, Kernel assembly, Mod installer,
external bridge, focused adapter tests, and all 144 maintained test files. Desktop's repository-wide
lint remains red only for import ordering in the concurrent, out-of-scope
`src/renderer/src/hooks/settings/model/useModelSettings.ts`; every migration file passes targeted lint,
and that unrelated renderer change is deliberately not repaired by this decision.
