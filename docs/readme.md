# VelarOS Platform documentation

This directory is the authoritative documentation entry point for VelarOS Platform. Public contracts, architecture decisions, and contributor-facing constraints must be reviewable in this repository. A private consumer repository may document its own adapters, but it cannot redefine Platform behavior.

## Start here

| Document | Read it when |
| --- | --- |
| [Platform boundaries](architecture/platform-boundaries.md) | Deciding whether behavior belongs to Platform, a host, or a product |
| [Repository topology](architecture/repository-topology.md) | Adding a package, changing a dependency direction, or working across domains |
| [Module ownership](architecture/module-ownership.md) | Using the unified contract/types/impl/utils layout, class APIs, injection ports, model operation definitions, templates, implementation layers and export checks |
| [Act runtime](architecture/platform-runtime.md) | Following session input, ScriptAct execution, context assembly and model requests |
| [Browser ScriptAct Bridge design](engineering/browser-scriptact-bridge-design-20261007.md) | Current daily-task CLI Host, external web ModelDriver, approval UI and durable recovery |
| [Long-running context](architecture/long-running-context.md) | Keeping one session running indefinitely: cache-stable request layout, segments, folding by remaining turns |
| [System space](architecture/act-system-space.md) | Using modules, memory, shared stores and durable messages |
| [Observation output](architecture/script-output-observation.md) | Controlling recurring script output, budgets and derived presentations |
| [Storage adapters](architecture/storage.md) | Replacing persistence through ContextStorage and StoreStorage |
| [Act API catalog](../packages/velaros/act/README.md) | Inspecting generated operation names, effects and templates |
| [Runtime assurance and observability](architecture/runtime-assurance.md) | Inspecting composition, model requests, or process confinement without changing authority |
| [Engineering standard](engineering/code-standard.md) | Writing or reviewing code, tests, comments, generated artifacts, or documentation |
| [Decision records](decisions/README.md) | Changing public protocols, storage, permissions, package ownership, or compatibility policy |
| [Gate coverage matrix](gate-coverage-matrix.md) | Finding the checks that cover a package or identifying a missing gate |
| [Platform 0.6.18 package source release](engineering/platform-0.6.18-package-source-release.md) | Reviewing the metadata-only package update that makes GitHub source association durable |
| [Platform 0.6.17 open-source release](engineering/platform-0.6.17-open-source-release.md) | Reviewing the first public release, package versions, history boundary, and release verification |
| VelarOS Termel | Independent terminal product, Host composition, remote nodes, packaging, and release |

The root [README](../README.md) contains the human-readable package inventory, setup instructions, and
merge-gate commands. The [generated package catalog](generated/package-catalog.json) is the deterministic
machine-readable projection of the root manifest and package manifests.

The [module structure refresh report](engineering/module-structure-refresh-delta.md) records the unified layout migration and current-document refresh. Refactor-plan records are dated evidence; start with the architecture guides above for current integration.

## Local validation and release

| Document | Purpose |
| --- | --- |
| [Local release and validation](engineering/local-package-release.md) | Run the full local gate and publish Platform packages |
| [Consumer repository updates](engineering/platform-consumer-updates.md) | Align a consumer with published Platform packages and verify its frozen dependency graph |

## Mod development

| Document | Purpose |
| --- | --- |
| [Mod developer guide](mod-dev/README.md) | Current Kernel envelope, explicit Act capability assembly and host responsibilities |
| [Getting started](mod-dev/getting-started.md) | Create and mount a minimal operation module; validate distributable envelopes |
| [Contribution axes](mod-dev/axes/README.md) | Choose the actual injection port for each extension responsibility |
| [Runtime seams](mod-dev/seams.md) | Use explicit execution, context, authorization and lifecycle ports |
| [Capabilities](mod-dev/capabilities.md) | Use capability tokens and the permission broker across mod boundaries |
| [Distribution](mod-dev/distribution.md) | Package and distribute bundled or installed mods |
| [Conventions](mod-dev/conventions.md) | Ownership, data lifecycle, i18n, semantic vocabulary, and drift prevention |

Host products own their adapters, installation UI, and product-specific policies. Those details are intentionally outside the public Platform contract.

## Agent and evaluation

| Document | Purpose |
| --- | --- |
| [Agent mod trunk](agent/agent-mod-trunk.md) | Current ownership of Act assembly and Kernel module loading |
| [Agent Lab architecture](agent-lab/architecture.md) | Package boundaries, continuous journeys, drivers, verifiers, and trust boundaries |
| [Agent Lab methodology](agent-lab/methodology.md) | Reproducibility, comparison, variance, and evaluation validity |
| [Agent Lab integration](agent-lab/integration.md) | Add an execution engine, journey, verifier, detector, or CLI runtime |
| [Legacy equivalence](agent-lab/legacy-equivalence.md) | Understand historical behavior that the current package intentionally preserves or changes |

## Act details

| Document | Purpose |
| --- | --- |
| [Agent integration](architecture/agent-act-consolidation.md) | Loop ownership, injected ports and durable run control |
| [Code surface design](engineering/script-design.md) | Why the model writes programs, how declarations are generated and how capabilities reach the model |
| [ScriptAct implementation and evidence](engineering/scriptact-optimization-implementation.md) | Implementation scope, compatibility, frozen comparisons and next directions |
| [ScriptAct current state decision (ADR 0026)](decisions/0026-scriptact-current-state-and-verification.md) | Current frames, atomic completion and trusted observation coverage |
| [ScriptAct optimization design](engineering/scriptact-optimization-design.md) | Current working view, capability templates, domain verification, observation reuse and evaluation design |
| [ScriptAct next generation design](engineering/scriptact-next-generation-design.md) | Priorities, concrete interfaces, domain reuse boundaries and independent validation for the next generation |
| [ScriptAct next generation evidence](engineering/scriptact-next-generation-implementation.md) | Contract changes, complete mechanism costs, frozen model comparisons and regression diagnosis |
| [ScriptAct final delivery](engineering/scriptact-next-generation-delivery.md) | Committed implementation, current contracts, final checks and complete original model attempts |
| [Text protocol](architecture/scriptact-text-protocol.md) | Frames, streaming, blobs, execution and completion |
| [Result leases](architecture/script-context-leases.md) | Recurring observations and retained one-shot results |
| [Incremental edits](architecture/script-incremental-edit.md) | Version-bound updates to model-maintained programs |
| [Context management](architecture/context-management.md) | Five partitions, model maintenance and overflow recovery |
| [Advanced search](architecture/advanced-search.md) | Bounded search, continuation and its context policy |
| [Shared resources](architecture/shared-resources.md) | Shared structured state, grants and durable messages |

## Memory

| Document | Purpose |
| --- | --- |
| [Memory slimming (ADR 0010)](decisions/0010-memory-slimming.md) | Historical decision establishing host-scoped Markdown memory |
| [Memory module README](../packages/velaros/memory/README.md) | The host memory store used by system.memory.recall/save/remove |

Historical review and revision documents remain evidence of prior decisions. They must be clearly labeled as historical and cannot override current schemas, tests, architecture documents, or accepted decision records.

## Documentation rules

- Add every maintained document to this index.
- Keep public API names, package paths, and implementation status aligned with the current tree.
- Describe unavailable work as planned, not shipped.
- Replace stale plans; keep history in Git or in an explicitly labeled historical record.
- Link to public, stable sources. Do not make private repositories or local files a prerequisite for understanding Platform behavior.
- Update documentation in the same change as the contract or behavior it describes.

- [Project language and CLI ownership (ADR 0016)](decisions/0016-project-language-and-cli-ownership.md): project owns language services; Termel owns the CLI.
