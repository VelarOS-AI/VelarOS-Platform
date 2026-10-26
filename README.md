# VelarOS Platform

[简体中文](README.zh-CN.md)

VelarOS is being built as a personal AI operating system and an ecosystem of AI applications. VelarOS Platform is the shared foundation for that ecosystem: it provides the Kernel and reusable packages for execution, capabilities, memory, permissions, context, state, models, and agent-facing APIs.

VelarOS Desktop is the first shipping product, the desktop shell, and the reference integration. It validates the Platform, but it does not define the final boundary of VelarOS.

## Project status

This is the public source repository for VelarOS Platform. New work is held to public-source standards: no private product assumptions, machine-specific paths, credentials, undocumented authority, or hidden build requirements may enter the Platform.

The source code is licensed under the [Apache License 2.0](LICENSE).

## Repository structure

VelarOS Platform has 9 package workspaces, published independently. Published
packages declare a shared `velaros.platform` generation for cross-package compatibility.

| Domain | Packages |
| --- | --- |
| Kernel | `@velaros-ai/kernel` |
| Agent runtime | `@velaros-ai/agent` (Act loop, run lifecycle and child-task supervision) |
| Shared primitives | `@velaros-ai/core` (base primitives, plus the `platform`, `text-files` and `path-rules` units) |
| Shared capability foundations | `@velaros-ai/script`, `@velaros-ai/context`, `@velaros-ai/velaros` |
| Model providers | `@velaros-ai/model` |
| Evaluation | `@velaros-ai/agent-lab` |
| Installable JS/TS Skill | `@velaros-ai/skill-jsts` |

Language services are part of `@velaros-ai/velaros/project`. The `velaros` CLI is maintained in VelarOS-Termel; UI and component-library in VelarOS-UI; document-renderer in VelarOS-Desktop.

The package inventory in the root `package.json` is the machine-checked source of truth. The
[generated package catalog](docs/generated/package-catalog.json) exposes the same inventory, package
versions, descriptions, and public export subpaths to tooling without creating a second configuration
surface. Public package APIs live in package manifests and package READMEs; architecture and protocol
decisions live in this repository's `docs/` tree.

## Requirements

- [Bun](https://bun.sh/) 1.3.13
- Node.js 22.15 or newer for the complete workspace, including the JS/TS Skill; Node.js 24.22.0 is the current Windows verification environment. The SQLite adapter alone requires Node.js 22.13 or newer.
- Individual consumers must also follow each package’s engines and host dependencies

## Development

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run test
bun run check
```

`bun run check` is the merge gate. It builds all packages, type-checks, lints, runs tests, validates architectural boundaries, and checks public-release invariants.

Start with the [documentation index](docs/readme.md) for architecture, package boundaries, and developer guides.
The independently installable VelarOS Termel product owns its Host composition and native release lifecycle. Shared remote-node transport belongs to Kernel.

## Start here

- [Runtime integration](packages/velaros/act/runtime/README.md): create a runtime, supply host ports, submit input and consume events.
- [Script](packages/script/README.md): execute standard Node.js programs with an authorized Kernel capability bridge.
- [Skills](packages/velaros/skills/README.md): install packages and load instructions and capabilities on demand.
- [Architecture](docs/architecture/platform-runtime.md) and [package catalog](docs/generated/package-catalog.json): the current execution chain and public imports.

This repository is public under Apache-2.0. That license does not apply to separate product repositories merely because they consume Platform. The root workspace remains private in package.json to prevent publishing the monorepo root.

Packages are distributed through GitHub Packages under the @velaros-ai scope. Reading the source needs no account; registry access uses the NODE_AUTH_TOKEN referenced by .npmrc. Source development uses workspace dependencies and the committed lockfile. Product hosts provide model credentials, storage, process execution and authorization; do not import their private source trees.

## Validation boundaries

[Testing and platform support](docs/engineering/testing.md) explains the test runners, Windows limitations and targeted checks. Bun is the repository tool and TypeScript test runner; the application execution engine is Node.js. A Bun test failure is not automatically a failure in the Node host, and a passing type check is not runtime verification.

The dependency-security gate verifies installed patch bytes before applying its documented audit exceptions. See the [dependency policy](docs/engineering/dependency-security.md). CI and official package releases run on GitHub Actions with the pinned toolchain and complete quality gates. Release tarballs and their source/hash manifest are publicly downloadable from GitHub Releases; see the [release procedure](docs/engineering/local-package-release.md).

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and project ownership is described in [GOVERNANCE.md](GOVERNANCE.md).

Do not report security vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md) instead.

## License

Copyright 2026 VelarOS-AI contributors.

Licensed under the [Apache License, Version 2.0](LICENSE).

Shared UI and the component catalog are maintained in `VelarOS-UI`. The Document Renderer package and standalone product are maintained in `VelarOS-Desktop`.
