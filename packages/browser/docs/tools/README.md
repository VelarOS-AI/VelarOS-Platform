# @velaros-ai/browser/tools

[中文接口文档](./api.zh-CN.md)

## Responsibility

`@velaros-ai/browser/tools` owns agent-facing browser tools and browser recipes. It depends on injected browser context/runtime capabilities and exposes tool collections that a host can register with an agent runtime.

## Public Imports

- `@velaros-ai/browser/tools`
- `@velaros-ai/browser/tools/cli`

## Boundary

This package must not depend on `@velaros-ai/agent` or product IPC. It defines tools and their context contracts only. Runtime execution, session ownership, and UI are composed by the host.

## Example

```ts
import { browserTools } from '@velaros-ai/browser/tools'
```
