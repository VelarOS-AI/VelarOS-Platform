# @velaros-ai/cli

[中文接口文档](./docs/api.zh-CN.md)

## Responsibility

`@velaros-ai/cli` owns the extensible VelarOS command-line composition entrypoint. The package bundles Workspace, System, Office, and Agent namespaces. Products register Browser, Memory, Computer, or other capability namespaces without making this repository depend on those implementations.

## Public Imports

- `@velaros-ai/cli`
- `@velaros-ai/cli/cli`

## Boundary

This package is orchestration-only. It must not own tool implementations, storage adapters, product IPC, renderer UI, or host-specific runtime state. Domain packages expose their own CLI runners; an application distribution composes them with `createVelarosCliRouter()`.

The `0.2.10` release composes `@velaros-ai/workspace@1.2.5`,
`@velaros-ai/system-tools@0.2.8`, and `@velaros-ai/office-tools@0.2.7`.
Browser-safe consumers should import domain contracts directly rather than
routing them through the CLI.

## Example

```ts
import { createVelarosCliRouter } from '@velaros-ai/cli'

const runVelarosCli = createVelarosCliRouter({
  namespaces: {
    browser: runBrowserCli,
    memory: runMemoryCli,
  },
})
```

```bash
velaros help
velaros agent manifest --json
velaros agent status --workspace-root . --json
```
