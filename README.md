# VelarOS Platform

[简体中文](README.zh-CN.md)

VelarOS is being built as a personal AI operating system and an ecosystem of AI applications. VelarOS Platform is the shared foundation for that ecosystem: it provides the Kernel and reusable packages for execution, capabilities, memory, permissions, context, state, models, and agent-facing APIs.

VelarOS Desktop is the first shipping product, the desktop shell, and the reference integration. It validates the Platform, but it does not define the final boundary of VelarOS.

## Project status

This repository is being prepared for its public release. New work is held to public-source standards now: no private product assumptions, machine-specific paths, credentials, undocumented authority, or hidden build requirements may enter the Platform.

The source code is licensed under the [Apache License 2.0](LICENSE). Third-party software retains its original licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Repository structure

VelarOS Platform is a Bun workspace with 19 packages. Packages are versioned independently and declare a shared `velaros.platform` generation for cross-package compatibility.

| Domain | Packages |
| --- | --- |
| Kernel | `@velaros-ai/kernel` |
| Agent runtime | `@velaros-ai/agent` |
| Shared primitives | `@velaros-ai/core` |
| Model providers | `@velaros-ai/model` |
| Capabilities | `@velaros-ai/browser`, `@velaros-ai/cli`, `@velaros-ai/computer`, `@velaros-ai/development`, `@velaros-ai/game`, `@velaros-ai/office`, `@velaros-ai/project`, `@velaros-ai/system` |
| Memory | `@velaros-ai/memory` |
| UI | `@velaros-ai/ui` |
| HTML artifacts | `@velaros-ai/html-artifacts` |
| Hosts | `@velaros-ai/remote-host`, `@velaros-ai/serve-host` |
| Surface protocol | `@velaros-ai/surface-protocol` |
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
The independently installable, terminal-first Host product and its native release flow are documented in
[`docs/host-release.md`](docs/host-release.md).

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and project ownership is described in [GOVERNANCE.md](GOVERNANCE.md).

Do not report security vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md) instead.

## License

Copyright 2026 VelarOS-AI contributors.

Licensed under the [Apache License, Version 2.0](LICENSE).
