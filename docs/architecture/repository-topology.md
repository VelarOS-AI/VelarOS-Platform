# Repository topology

VelarOS Platform is a flat Bun workspace. Every publishable package lives directly under `packages/`; domain ownership is declared by `velaros.domainPackages` in the root manifest rather than inferred from directory depth. `docs/generated/package-catalog.json` is a read-only projection of that declaration and each package manifest; it is never edited as a second source of truth.

## Domains

| Domain | Directories |
| --- | --- |
| Kernel | `packages/kernel` |
| Agent | `packages/agent` |
| Core | `packages/core` (base primitives in `src/`, plus the `platform`, `text-files` and `path-rules` units) |
| Foundations | `packages/code-surface`, `packages/velar`, `packages/tool-contract` |
| Model | `packages/model` |
| Capabilities | `packages/cli`, `packages/development` |
| UI | `packages/ui` |
| HTML artifacts | `packages/html-artifacts` |
| Evaluation | `packages/agent-lab` |

## Target topology

The repository is converging on three rules; packages move one at a time, each move keeping every gate green.

1. **Tool packages move into `@velaros-ai/velar` whole.** Every capability the model imports is a unit there (`packages/velar/<unit>`,
   imported as `velar:<unit>`), and the package that carried it moves in with its implementation, not as a projection over a package
   left outside: the project kernel behind `velar:project` and `velar:code`, the helper sidecar behind `velar:computer`, the memory
   store behind `velar:memory`, the document engines behind `velar:office`, and the CDP drivers, page engines and Electron session
   runtime behind `velar:browser` and `velar:devtools`, and the local machine host behind `velar:shell` and `velar:sandbox`. The old
   package is then deleted — there is never a second copy. A package with no model face is not a tool and stays outside `velar`,
   grouped by responsibility: `development`, the language services a host plugs into `velar:code`, is one.
2. **Core execution stays outside `velar`**: `kernel`, `agent`, `model`, `code-surface` (the program gate), `tool-contract`,
   and the cross-domain foundation `core`. Low-level libraries with no domain runtime are units of `core`, below the kernel so the
   kernel can use them too; packages nobody in the repository uses are deleted, not moved ([ADR 0014](../decisions/0014-packages-by-responsibility.md)).
3. **Product assembly is not in this repository.** A space (which capabilities are mounted, with which ports and policies)
   is assembled by each product (Desktop, Workbench, Termel). The implementations those products share are the capabilities'
   own and live with them: each unit's Node-only `./local` entry gives its port on this machine (the local shell host, the rehearsal
   sandbox, machine files, machine images), and `velar/project` gives the ports the project hands to the shared capabilities
   ([ADR 0013](../decisions/0013-spaces-leave-platform.md)). `tests/support/spaces.ts` shows how a product assembles the two spaces.

| Package | Destination | Status |
| --- | --- | --- |
| `development` | stays `packages/development`: language services a host plugs into `velar:code`, not a tool | done |
| `system` | space assembly → products; the local machine host → `velar/shell/local` (commands, background tasks, consoles, shell selection, process confinement, the Windows process host, plus the processes, ports, metrics and environment report a host UI shows) and `velar/sandbox/local` (the rehearsal sandbox); the machine file and image ports → `velar/files/local`, `velar/images/local`, the global search a host UI shows → `velar/files/local` (ADR 0013); `packages/system` deleted | done |
| `project` | space assembly → products; the ports the project hands to shell, sandbox and images, and the verification policy → `velar/project` (ADR 0013); `packages/project` deleted | done |
| `platform`, `text-files`, `path-rules` | units of `core` (`@velaros-ai/core/platform`, `/text-files`, `/path-rules`): domain-free libraries below the kernel, not tools ([ADR 0014](../decisions/0014-packages-by-responsibility.md)); the three packages deleted | done |
| `surface-protocol` | deleted: no package in the repository used it, and the external-agent wire format gets rewritten on the code surface (ADR 0014); products keep the published version until then | done |
| `computer` | `velar/computer` (`velar:computer`, with the helper sidecar runtime and its bundled Python helpers) | done |
| `knowledge` | deleted with its vector and full-text indexes ([ADR 0010](../decisions/0010-memory-slimming.md)): each space searches and reads its own files | done |
| `memory` | `velar/memory` (`velar:memory`: one directory of Markdown per host-given scope, [ADR 0010](../decisions/0010-memory-slimming.md)); `packages/memory` deleted | done |
| `office` | whole → `velar/office` (`velar:office`, with the document engines, converters and the renderer primitives underneath); `packages/office` deleted; `document-renderer` now builds on `@velaros-ai/velar/office/renderer` | done |
| `browser` | whole → `velar/browser` (`velar:browser` to drive and read pages, `velar:devtools` for console, network, storage, performance, recording, emulation and user scripts; with the CDP drivers, page engines, Electron session runtime and site workspace underneath); recipes, the site artifact manager and the tool-era mod manifest dropped (ADR 0011); `packages/browser` deleted | done |
| `html-artifacts` | into `ui` (ADR 0014) | pending |
| `cli`, `agent-lab`, `document-renderer` | stay: distribution, evaluation and a product package | done |

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
