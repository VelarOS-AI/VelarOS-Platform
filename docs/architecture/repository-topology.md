# Repository topology

VelarOS Platform is a flat Bun workspace. Every publishable package lives directly under `packages/`; domain ownership is declared by `velaros.domainPackages` in the root manifest rather than inferred from directory depth. `docs/generated/package-catalog.json` is a read-only projection of that declaration and each package manifest; it is never edited as a second source of truth.

## Domains

| Domain | Directories |
| --- | --- |
| Kernel | `packages/kernel` |
| Agent | `packages/agent` |
| Core | `packages/core`, `packages/platform` |
| Foundations | `packages/code-surface`, `packages/velar`, `packages/text-files`, `packages/path-rules`, `packages/tool-contract` |
| Model | `packages/model` |
| Capabilities | `packages/browser`, `packages/cli`, `packages/development`, `packages/project`, `packages/system` |
| UI | `packages/ui` |
| HTML artifacts | `packages/html-artifacts` |
| Surface | `packages/surface-protocol` |
| Evaluation | `packages/agent-lab` |

## Target topology

The repository is converging on three rules; packages move one at a time, each move keeping every gate green.

1. **Tool packages move into `@velaros-ai/velar` whole.** Every capability the model imports is a unit there (`packages/velar/<unit>`,
   imported as `velar:<unit>`), and the package that carried it moves in with its implementation, not as a projection over a package
   left outside: the project kernel behind `velar:project` and `velar:code`, the helper sidecar behind `velar:computer`, the memory
   store behind `velar:memory`. The old package is then deleted — there
   is never a second copy. A package with no model face is not a tool and stays outside `velar`, grouped by responsibility:
   `development`, the language services a host plugs into `velar:code`, is one.
2. **Core execution stays outside `velar`**: `kernel`, `agent`, `model`, `code-surface` (the program gate), `tool-contract`,
   `surface-protocol`, and the cross-domain foundations `core` and `platform`.
3. **Product assembly is not in this repository.** A space (which capabilities are mounted, with which ports and policies)
   is assembled by each product (Desktop, Workbench, Termel). Reusable host implementations those products share — the local
   machine host behind shell and sandbox, for example — are not tools either: they stay packages of their own.

| Package | Destination | Status |
| --- | --- | --- |
| `development` | stays `packages/development`: language services a host plugs into `velar:code`, not a tool | done |
| `system` | space assembly → products; the local machine host stays a package of its own | pending |
| `project` | space assembly and ports → products; verification policy → `velar/project` | pending |
| `text-files`, `path-rules` | stay foundations: libraries the `velar` units build on, not tools | done |
| `computer` | `velar/computer` (`velar:computer`, with the helper sidecar runtime and its bundled Python helpers) | done |
| `knowledge` | deleted with its vector and full-text indexes ([ADR 0010](../decisions/0010-memory-slimming.md)): each space searches and reads its own files | done |
| `memory` | `velar/memory` (`velar:memory`: one directory of Markdown per host-given scope, [ADR 0010](../decisions/0010-memory-slimming.md)); `packages/memory` deleted | done |
| `office` | whole → `velar/office` (`velar:office`, with the document engines, converters and the renderer primitives underneath); `packages/office` deleted; `document-renderer` now builds on `@velaros-ai/velar/office/renderer` | done |
| `browser` | whole → a `velar` unit with its engine; what cannot move (an execution loop, not a tool) stays a separate package | pending |
| `ui`, `html-artifacts`, `cli`, `agent-lab` | grouped by responsibility after the moves above | pending |

## Shared infrastructure

| Path | Ownership |
| --- | --- |
| `scripts/build/` | Workspace build topology and reproducible generation |
| `scripts/release/` | Package identity, packing, verification, and publishing |
| `scripts/<domain>/` | Domain-specific checks and maintenance |
| `baselines/<domain>/` | Reviewed compatibility or gate baselines |
| `eslint/` | Shared and domain-specific lint configuration |
| `tests/<domain>/` | Cross-package or maintained domain test suites |
| `docs/` | Public architecture, specifications, guides, and decision records |
| `component-library/` | UI component catalog consuming `@velaros-ai/ui` |

Product composition and release repositories depend on these packages through published APIs. The
independent VelarOS Termel product owns its TUI,
final Host composition, product policy, persistence adapters, packaging, and release. Host-neutral
remote-node transport and reusable Agent-product mechanisms remain in their Platform domain packages.
Platform must not import Terminal product source; see
[`0001-agent-product-common-kernel.md`](../decisions/0001-agent-product-common-kernel.md).

## Adding or moving a package

An approved topology change must update:

1. the root workspace and `velaros.domainPackages` declaration;
2. the package manifest, exports, license, repository metadata, and files list;
3. build and release topology;
4. domain ownership and architecture gates;
5. isolated packed-consumer tests;
6. the root package inventory and the generated package catalog (`bun run generate:package-catalog`);
7. affected consumers through released package versions.

Temporary local links are useful for debugging but are not release evidence. Published packages must be tested from packed artifacts without ambient workspace declarations, private registries, or absolute paths.

`bun run check:package-catalog` compares the committed catalog byte for byte with a fresh projection.
The output deliberately contains no timestamp, host path, or dependency-install state, so identical
manifests produce identical output on every supported development host.
