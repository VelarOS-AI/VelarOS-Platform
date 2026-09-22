# VelarOS Platform

正式执行主干：[Platform 统一执行架构](docs/architecture/platform-runtime.md)。主线与按需模型工具共用 Act 主干，能力经 ScriptAct、Kernel 回执和五分区上下文推进。

[简体中文](README.zh-CN.md)

VelarOS is being built as a personal AI operating system and an ecosystem of AI applications. VelarOS Platform is the shared foundation for that ecosystem: it provides the Kernel and reusable packages for execution, capabilities, memory, permissions, context, state, models, and agent-facing APIs.

VelarOS Desktop is the first shipping product, the desktop shell, and the reference integration. It validates the Platform, but it does not define the final boundary of VelarOS.

## Project status

This is the public source repository for VelarOS Platform. New work is held to public-source standards: no private product assumptions, machine-specific paths, credentials, undocumented authority, or hidden build requirements may enter the Platform.

The source code is licensed under the [Apache License 2.0](LICENSE).

## Repository structure

VelarOS Platform has 8 package workspaces, all published independently. Published
packages declare a shared `velaros.platform` generation for cross-package compatibility.

| Domain | Packages |
| --- | --- |
| Kernel | `@velaros-ai/kernel` |
| Agent runtime | `@velaros-ai/agent` (Act loop, run lifecycle and child-task supervision) |
| Shared primitives | `@velaros-ai/core` (base primitives, plus the `platform`, `text-files` and `path-rules` units) |
| Shared capability foundations | `@velaros-ai/script`, `@velaros-ai/context`, `@velaros-ai/velaros` |
| Model providers | `@velaros-ai/model` |
| Evaluation | `@velaros-ai/agent-lab` |

Language services are part of `@velaros-ai/velaros/project`. The `velaros` CLI is maintained in VelarOS-Termel; UI and component-library in VelarOS-UI; document-renderer in VelarOS-Desktop.

The package inventory in the root `package.json` is the machine-checked source of truth. The
[generated package catalog](docs/generated/package-catalog.json) exposes the same inventory, package
versions, descriptions, and public export subpaths to tooling without creating a second configuration
surface. Public package APIs live in package manifests and package READMEs; architecture and protocol
decisions live in this repository's `docs/` tree.

## Requirements

- [Bun](https://bun.sh/) 1.3.13
- Node.js 22.13 or newer for the full workspace and the default SQLite storage adapter
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

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and project ownership is described in [GOVERNANCE.md](GOVERNANCE.md).

Do not report security vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md) instead.

## License

Copyright 2026 VelarOS-AI contributors.

Licensed under the [Apache License, Version 2.0](LICENSE).

Shared UI and the component catalog are maintained in `VelarOS-UI`. The Document Renderer package and standalone product are maintained in `VelarOS-Desktop`.
