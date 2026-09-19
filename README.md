# VelarOS Platform

[简体中文](README.zh-CN.md)

VelarOS is being built as a personal AI operating system and an ecosystem of AI applications. VelarOS Platform is the shared foundation for that ecosystem: it provides the Kernel and reusable packages for execution, capabilities, memory, permissions, context, state, models, and agent-facing APIs.

VelarOS Desktop is the first shipping product, the desktop shell, and the reference integration. It validates the Platform, but it does not define the final boundary of VelarOS.

## Project status

This is the public source repository for VelarOS Platform. New work is held to public-source standards: no private product assumptions, machine-specific paths, credentials, undocumented authority, or hidden build requirements may enter the Platform.

The source code is licensed under the [Apache License 2.0](LICENSE).

## Repository structure

VelarOS Platform has 11 package workspaces, 10 of which are published independently. Published
packages declare a shared `velaros.platform` generation for cross-package compatibility.

| Domain | Packages |
| --- | --- |
| Kernel | `@velaros-ai/kernel` |
| Agent runtime | `@velaros-ai/agent` (with the tool contract at `@velaros-ai/agent/tool-contract`) |
| Shared primitives | `@velaros-ai/core` (base primitives, plus the `platform`, `text-files` and `path-rules` units) |
| Shared capability foundations | `@velaros-ai/code-surface`, `@velaros-ai/velar` |
| Model providers | `@velaros-ai/model` |
| Capabilities | `@velaros-ai/cli`, `@velaros-ai/development` |
| UI | `@velaros-ai/ui` (components, conversation UI, and the `html-artifacts` unit) |
| Evaluation | `@velaros-ai/agent-lab` |

The package inventory in the root `package.json` is the machine-checked source of truth. The
[generated package catalog](docs/generated/package-catalog.json) exposes the same inventory, package
versions, descriptions, and public export subpaths to tooling without creating a second configuration
surface. Public package APIs live in package manifests and package READMEs; architecture and protocol
decisions live in this repository's `docs/` tree.

## Requirements

- [Bun](https://bun.sh/) 1.3.13
- Node.js 20 or newer for Node-based scripts and consumers
- Native build tools required by `better-sqlite3` and Electron rebuilds

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
The independently installable VelarOS Termel product owns its Host composition, remote-node
transport, and native release lifecycle.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and project ownership is described in [GOVERNANCE.md](GOVERNANCE.md).

Do not report security vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md) instead.

## License

Copyright 2026 VelarOS-AI contributors.

Licensed under the [Apache License, Version 2.0](LICENSE).
