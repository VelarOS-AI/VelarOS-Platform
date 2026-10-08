# Repository topology

VelarOS Platform is a flat Bun workspace with nine published packages. `velaros.domainPackages` in the root manifest owns package identity; `docs/generated/package-catalog.json` is its generated projection.

## Packages and dependencies

| Package               | Responsibility                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/core`       | Domain-neutral primitives; platform, text-files and path-rules units                                 |
| `packages/kernel`     | Operation contracts, module bindings, permissions, invocation receipts and host-neutral transport    |
| `packages/model`      | Provider adapters, request compilation, token accounting and multimodal requests                     |
| `packages/script`     | ScriptAct program validation, versioned programs, isolated JavaScript execution and Kernel calls     |
| `packages/context`    | Immutable inputs and evidence, task state, context projections, storage ports and the SQLite adapter |
| `packages/agent`      | ActLoop, durable ActRunService and bounded AgentSupervisor                                           |
| `packages/velaros`    | Runtime assembly, model tools, system operations and domain capability implementations               |
| `packages/agent-lab`  | Deterministic and real-model evaluation infrastructure                                               |
| `packages/skill-jsts` | Installable JavaScript and TypeScript Skill with a fixed package environment                         |

Velaros composes Agent, Context, Script, Model and Kernel through their public contracts. Agent consumes Model, Context and Kernel contracts; protocol decoding, execution and context preparation enter through its injected ports. These lower layers do not import Velaros. Core remains below domain runtimes.

## Source layout and capability spaces

Governed modules use `contract/types/impl/utils`. Ordinary packages use `src/`; Core units and Velaros capability units use their own directory as source root. Registry entries specify implementation layers, source assets and browser-safe exports. See [module ownership](module-ownership.md).

Velaros keeps the complete implementation of a domain together: files, images, shell, sandbox, project, computer, memory, office and browser. Project also owns language services and code queries. A domain may expose several model modules, such as `velaros:project` / `velaros:code` or `velaros:browser` / `velaros:devtools`.

Act has four responsibility groups: `act/runtime` composes sessions and requests; `act/system` supplies model self-management through `velaros:system`; `act/search` implements bounded search; `act/agents` exposes child tasks and interaction. The generated [Act catalog](../../packages/velaros/act/README.md) lists actual operations, effects and templates.

Host package subpaths and model import names have different consumers. For example, a host imports `createRuntime` from `@velaros-ai/velaros`; a model script imports `memory` from `velaros:system`. Runtime determines the currently discoverable and callable projection.

## Product ownership

VelarOS UI owns shared components, HTML artifacts and its component catalog. VelarOS Desktop owns its document renderer and desktop composition. VelarOS Termel owns the CLI and terminal product. Products provide native resources, credentials, storage roots, authorization policy and UI through published contracts. See [Platform boundaries](platform-boundaries.md) and [ADR 0016](../decisions/0016-project-language-and-cli-ownership.md).

## Shared infrastructure

| Path                                   | Responsibility                                                       |
| -------------------------------------- | -------------------------------------------------------------------- |
| `scripts/build/`                       | Build dependency ordering and reproducible generation                |
| `scripts/release/`                     | Package identity, safe packing, consumer verification and publishing |
| `scripts/ownership/`                   | Module registration and shared structural checks                     |
| `scripts/script/`                      | Generated operation declarations, schemas and Act catalog            |
| `scripts/<domain>/`, `tests/<domain>/` | Domain checks and cross-package tests                                |
| `baselines/<domain>/`                  | Reviewed compatibility and gate baselines                            |
| `eslint/`                              | Shared and domain lint rules                                         |
| `docs/`                                | Current guides, architecture decisions and dated validation records  |

## Changing topology

Update the root workspace/domain map, package exports and files, build/release ordering, ownership gates, packed-consumer checks and affected documentation together. Regenerate the catalog with `bun run generate:package-catalog` and verify it with `bun run check:package-catalog`. Temporary workspace links are development aids; publishable contracts require packed-consumer verification.
