# VelarOS Platform documentation

This directory is the authoritative documentation entry point for VelarOS Platform. Public contracts, architecture decisions, and contributor-facing constraints must be reviewable in this repository. A private consumer repository may document its own adapters, but it cannot redefine Platform behavior.

## Start here

| Document | Read it when |
| --- | --- |
| [Platform boundaries](architecture/platform-boundaries.md) | Deciding whether behavior belongs to Platform, a host, or a product |
| [Repository topology](architecture/repository-topology.md) | Adding a package, changing a dependency direction, or working across domains |
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

## Local validation and release

| Document | Purpose |
| --- | --- |
| [Local release and validation](engineering/local-package-release.md) | Run the full local gate, publish Platform packages, or build, sign, attest, finalize, and upload one native Document Renderer platform |
| [Consumer repository updates](engineering/platform-consumer-updates.md) | Align a consumer with published Platform packages and verify its frozen dependency graph |

## Mod development

| Document | Purpose |
| --- | --- |
| [Mod developer guide](mod-dev/README.md) | Authoritative public entry point for the mod envelope, registration, trust, lifecycle, and contribution axes |
| [Getting started](mod-dev/getting-started.md) | Build, install, activate, diagnose, and remove a minimal mod |
| [Contribution axes](mod-dev/axes/README.md) | Select the supported Agent or UI extension axis |
| [Runtime seams](mod-dev/seams.md) | Intercept Agent behavior without bypassing permission checks |
| [Capabilities](mod-dev/capabilities.md) | Use capability tokens and the permission broker across mod boundaries |
| [Distribution](mod-dev/distribution.md) | Package and distribute bundled or installed mods |
| [Conventions](mod-dev/conventions.md) | Ownership, data lifecycle, i18n, semantic vocabulary, and drift prevention |

Host products own their adapters, installation UI, and product-specific policies. Those details are intentionally outside the public Platform contract.

## Agent and evaluation

| Document | Purpose |
| --- | --- |
| [Agent mod trunk](agent/agent-mod-trunk.md) | Runtime ownership and the second-level registration model in `@velaros-ai/agent` |
| [Agent Lab architecture](agent-lab/architecture.md) | Package boundaries, continuous journeys, drivers, verifiers, and trust boundaries |
| [Agent Lab methodology](agent-lab/methodology.md) | Reproducibility, comparison, variance, and evaluation validity |
| [Agent Lab integration](agent-lab/integration.md) | Add an execution engine, journey, verifier, detector, or CLI runtime |
| [Legacy equivalence](agent-lab/legacy-equivalence.md) | Understand historical behavior that the current package intentionally preserves or changes |

## Memory

| Document | Purpose |
| --- | --- |
| [Memory backend contract](memory/memory-backends.md) | Backend ports, capability ownership, and integration boundaries |
| [Memory tree specification freeze](memory/memory-tree-spec-freeze.md) | Canonical serialization, hashing, domain strings, and TreeDiff construction |
| [Memory tree architecture](memory/memory-tree-product-architecture.md) | Evidence, Dream, TreeDiff, erasure, encryption, and meaning-model design |
| [Memory tree requirements](memory/memory-tree-product-requirements.md) | Product behavior and privacy requirements |
| [Memory migration guide](memory/0.3-migration.md) | Historical migration into the current package boundary |

Historical review and revision documents remain evidence of prior decisions. They must be clearly labeled as historical and cannot override current schemas, tests, architecture documents, or accepted decision records.

## Documentation rules

- Add every maintained document to this index.
- Keep public API names, package paths, and implementation status aligned with the current tree.
- Describe unavailable work as planned, not shipped.
- Replace stale plans; keep history in Git or in an explicitly labeled historical record.
- Link to public, stable sources. Do not make private repositories or local files a prerequisite for understanding Platform behavior.
- Update documentation in the same change as the contract or behavior it describes.
