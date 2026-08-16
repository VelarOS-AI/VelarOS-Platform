# Repository topology

VelarOS Platform is a flat Bun workspace. Every publishable package lives directly under `packages/`; domain ownership is declared by `velaros.domainPackages` in the root manifest rather than inferred from directory depth.

## Domains

| Domain | Directories |
| --- | --- |
| Kernel | `packages/kernel` |
| Agent | `packages/agent` |
| Core | `packages/core` |
| Model | `packages/model` |
| Capabilities | `packages/browser`, `packages/cli`, `packages/computer`, `packages/development`, `packages/game`, `packages/office`, `packages/project`, `packages/system` |
| Memory | `packages/memory` |
| UI | `packages/ui` |
| HTML artifacts | `packages/html-artifacts` |
| Host | `packages/remote-host`, `packages/serve-host` |
| Surface | `packages/surface-protocol` |
| Evaluation | `packages/agent-lab` |

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

## Adding or moving a package

An approved topology change must update:

1. the root workspace and `velaros.domainPackages` declaration;
2. the package manifest, exports, license, repository metadata, and files list;
3. build and release topology;
4. domain ownership and architecture gates;
5. isolated packed-consumer tests;
6. this document and the root package inventory;
7. affected consumers through released package versions.

Temporary local links are useful for debugging but are not release evidence. Published packages must be tested from packed artifacts without ambient workspace declarations, private registries, or absolute paths.
