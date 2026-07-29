# @velaros-ai/computer-tools

[中文接口文档](./docs/api.zh-CN.md)

## Responsibility

`@velaros-ai/computer-tools` owns the agent-facing OS-level desktop-control tools (Computer Use, Phase 1): `computer_screenshot`, `computer_screen_size`, `computer_move`, `computer_click`, `computer_type`, and `computer_key`. Screenshot/screen-size are read-tier; move/click/type/key are high-risk control-tier and route every actuation through the host confirmation flow. It depends on an injected `computer` context API (adapting `@velaros-ai/computer-runtime`) and exposes a tool collection a host can register with an agent runtime.

## Public Imports

- `@velaros-ai/computer-tools`

Key exports: `computerTools`, the `ComputerObserveCapability` / `ComputerControlCapability` capability schemas, and the `ToolComputerApi` / `ComputerToolContext` context contracts.

## Boundary

This package must not depend on `@velaros-ai/agent-runtime` or product IPC. It defines tools and their context contracts only. Runtime execution (sidecar ownership), the confirmation flow, and UI are composed by the host. The whole `computer-control` tool category is off by default and is opt-in like browser mode.

## Example

```ts
import { computerTools } from '@velaros-ai/computer-tools'
```
