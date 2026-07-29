# @velaros-ai/browser/core

[中文接口文档](./api.zh-CN.md)

## Responsibility

`@velaros-ai/browser/core` owns the **host-agnostic** half of the browser runtime: the `BrowserPageDriver` contract, the CDP page driver (`CdpBrowserPageDriver` + `CdpWebSocketTransport`), the external/bundled browser launchers (`CdpExternalBrowserLauncher`, `CloakBrowserLauncher`, `CloakBrowserRuntimeResolver`), every page **script builder** (`BrowserPageScriptBuilder` and friends), the CDP network / emulation / performance-tracing controllers, the pending-events broker, the workspace artifact manager, the shared pure helpers, and the net-new `CdpBrowserRuntime` assembly. Nothing here imports Electron — not even as a type.

## Public Imports

- `@velaros-ai/browser/core`
- `@velaros-ai/browser/core/contracts` — browser-safe DTOs and deterministic policies

## Boundary

This package must never import `electron` (value or type); the arch-guard `electron` rule and the bare `require('@velaros-ai/browser/core')` smoke test enforce that no eager host value import leaks in. The Electron half — the embedded WebContents driver (`ElectronWebContentsBrowserPageDriver`), `ElectronBrowserRuntime`, session/partition management, and the embedded branches of the three engines — lives in `@velaros-ai/browser/runtime`, which depends on this package. Browser automation flows through `BrowserPageDriver` so the same inspection/action protocol runs on embedded WebView and external CDP drivers; the driver-based half of each engine and the `BrowserPageDriverKernel` seam are host-neutral, while the WebContents-only branches stay in the host package. CDP profile storage is keyed by member/site under a host-injected data root and never bridges an Electron partition — the two login stores are intentionally non-interoperable. This package must not register agent tools, own product IPC, own chat/session orchestration, or import renderer code. Agent-facing tools live in `@velaros-ai/browser/tools`; Electron host composition lives in the consuming application's composition root.

Renderer、Web Worker、RPC 和前端测试只能需要共享 DTO 与纯策略时，应使用
`@velaros-ai/browser/core/contracts`。该入口不包含 CDP 传输、浏览器启动器、文件
访问或 Node.js 内置模块；Node 宿主的完整自动化运行时仍位于包根入口。

## Engine split

The three domain engines are split external/embedded by inheritance:

- `CdpInteractionEngine` / `CdpPageDataEngine` (browser-core) hold the **external/CDP-driver branches** + `BrowserPageDriverKernel`-driven / driver-unified methods + all shared-pure helpers. The Electron `BrowserInteractionEngine` / `BrowserPageDataEngine` (browser-runtime) **extend** them: each dual method probes the external session and delegates to `super` for the CDP path, keeping only the `webContents`/`nativeImage` embedded branch locally. Branch logic moved verbatim (byte-for-byte behavior).
- `CdpScreenshotEngine` (browser-core) is a **degraded net-new** counterpart: the Electron `BrowserScreenshotEngine` stays whole because even its external path is `nativeImage`-coupled (crop/annotate/model-image/diff) and it renders model views via a hidden `BrowserWindow` — capabilities with no CDP equivalent (see matrix). The CDP core captures via `driver.captureScreenshot` and saves bytes; the rich features are honestly absent, not fabricated.

## CdpBrowserRuntime

`CdpBrowserRuntime` assembles the host-agnostic pieces (actionQueue + the three external engine cores + `BrowserPerformanceOrchestrator` + `BrowserPendingEventsBroker` + workspace file access + the dual launchers) into a no-Electron browser automation runtime. `bindBrowserApi(sessionId, context)` returns a session-bound object structurally satisfying `@velaros-ai/browser/tools`' `ToolBrowserApi` (`BrowserToolContext.browser`) — verified at compile time by `packages/browser/src/tools/CdpBrowserRuntimeContract.ts` (direction browser-tools → browser-core, no cycle) and by a construction smoke test (all 50 required methods present).

`CdpBrowserRuntime` is package-level validated by build, typecheck, lint, schema,
construction, and release dry-run gates. A product host still owns the
real-machine journey battery, credentials, lifecycle, and production assembly.

## Domain contracts

Browser DTOs and policies are exported here rather than from Kernel Core. This
includes page/interaction/network/screenshot/emulation contracts plus
`BrowserActionPolicy`, `BrowserAddressHelper`, `BrowserScreenshotPolicy`, and
`BrowserLoginDetection`. Other Browser packages import these contracts from
`@velaros-ai/browser/core`; Core remains a generic utility dependency only.

## CDP-side honest-absence capability matrix

| Capability | Electron (`browser-runtime`) | CDP (`browser-core` / `CdpBrowserRuntime`) |
|---|---|---|
| Page inspect / query / evaluate / storage / wait | full (webview `executeJavaScript`) | full (driver `executeJavaScript`) |
| Target action / self-heal / effect fingerprint | full | full (driver) |
| Type / press-key / click / drag / move | full (webview input synthesis) | full (driver `typeText`/`pressKey`/`clickCoordinates`/`dragCoordinates`) |
| Network control / response body / request details / emulation | full (driver-unified) | full (driver-unified) |
| Performance trace / insight / heap snapshot | full | full (`BrowserPerformanceOrchestrator`, driver CDP) |
| PDF export / fetch-resource / upload-file | full | full (driver `printToPdf` / `fetchResource` / `setFileInputFiles`) |
| Screenshot **capture + save** | full | degraded — driver PNG bytes, dimensions from capture region |
| Screenshot **annotate / model-image / diff** | full (`nativeImage`) | **honestly absent** — needs a raster codec, not fabricated |
| Screencast **recording** | full | recording via driver, but… |
| Screencast **GIF synthesis** | full (`nativeImage` frame decoder) | **honestly absent** — GIF needs a PNG→RGBA raster decoder |
| Hidden-`BrowserWindow` model-view overlay render | full | **honestly absent** — no CDP equivalent |
| Virtual-pointer / zoom-HUD / target-highlight overlays | full (webview page scripts) | absent (headless has no preview UI) |
| Windowed-host preview / picture-in-picture stream | full | n/a (headless) |
| User-script store | full (`BrowserUserScriptManager`) | absent by default — host injects a store per member data root |

## Example

```ts
import {
  CdpBrowserPageDriver,
  CdpExternalBrowserLauncher,
  BrowserPageScriptBuilder,
  CdpBrowserRuntime,
  type BrowserPageDriver,
} from '@velaros-ai/browser/core'
```
