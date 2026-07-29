# @velaros-ai/browser-runtime

[中文接口文档](./docs/api.zh-CN.md)

## Responsibility

`@velaros-ai/browser-runtime` owns the Electron-backed browser host: embedded
page drivers, navigation/session management, diagnostics, screenshots, preview
streaming, and lifecycle composition. Host-neutral scripts, DTOs, CDP drivers,
policies, and artifact contracts live in `@velaros-ai/browser-core`.

## Public Imports

- `@velaros-ai/browser-runtime`

## Boundary

This package may contain Electron-backed browser runtime code. Browser automation should pass through `BrowserPageDriver` where possible so the same inspection/action protocol can run on embedded WebView and external browser drivers such as `CdpBrowserPageDriver`. Existing external CDP hosts should connect through `CdpWebSocketTransport` or `CdpBrowserPageDriver.connect(webSocketDebuggerUrl)`. Fresh external Chrome/Chromium windows should launch through `CdpExternalBrowserLauncher`, which reads `DevToolsActivePort`, selects a page target from `/json/list`, and returns a page driver plus a host disposal function. External CDP page driver disposal only closes the current page connection; runtime/session disposal owns the launched browser process and temporary profile cleanup. External CDP target switching reconnects the page driver by target id while preserving the browser host. External CDP drivers may expose browser-level capabilities such as cookie jar reads, target inventory reads, target switching, network diagnostics/request detail/body reads, downloads, PDF export, and file upload behind optional `BrowserPageDriver` methods. It must not register agent tools, own product IPC, own chat/session orchestration, or import renderer code. Agent-facing tools live in `@velaros-ai/browser-tools`; host composition lives in the consuming application's composition root.

## Example

```ts
import { BrowserSessionManager, CdpExternalBrowserLauncher, ElectronBrowserRuntime, type BrowserPageDriver } from '@velaros-ai/browser-runtime'
```
