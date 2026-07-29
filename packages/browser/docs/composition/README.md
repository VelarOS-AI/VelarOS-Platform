# @velaros-ai/browser/composition

[中文接口文档](./api.zh-CN.md)

## Responsibility

Own the renderer-neutral semantic state and host-rendered boundary for a controlled browser
surface.

## Public Imports

- `@velaros-ai/browser/composition`

## Boundary

The package does not own Electron, WebView, CDP, IPC, chat sessions, navigation drivers, or
browser automation state.

- Runtime and driver primitives remain in `@velaros-ai/browser/runtime`.
- The consuming application owns the renderer implementation.
- Product consumers depend only on `ControlledBrowserSurface`.
