# @velaros-ai/computer/runtime

[中文接口文档](./api.zh-CN.md)

## Responsibility

`@velaros-ai/computer/runtime` owns the OS-level desktop-control sidecar for VelarOS Computer Use (Phase 1). It spawns a Python helper process, speaks a line-delimited JSON stdio protocol, correlates request/response pairs, manages the sidecar lifecycle (lazy start / dispose), selects the platform helper (macOS / Windows / Linux), and reports graceful "unavailable" status when Python, dependencies, a display, or OS permissions are missing.

The Python helpers and their `requirements*.txt` ship under `runtime/` and are bundled as app resources via the sidecar packaging pattern.

## Public Imports

- `@velaros-ai/computer/runtime`

Key exports: `ComputerSidecarManager`, `resolveComputerHelper`, `encodeComputerRequest` / `decodeComputerResponse`, and the `Computer*` result/availability types.

## Boundary

This package must not depend on `@velaros-ai/agent`, the tool packages, or product IPC. It only manages the helper process and the wire protocol. The host owns a single long-lived `ComputerSidecarManager` and injects it into the tool context.

## Protocol

```
request  (stdin) : {"id": <number>, "command": <string>, "payload": {...}}\n
response (stdout): {"id": <number>, "ok": true,  "result": <any>}\n
                   {"id": <number>, "ok": false, "error": {"code","message"}}\n
```

`id: 0` is reserved for the readiness handshake the helper emits on startup.

## Example

```ts
import { ComputerSidecarManager } from '@velaros-ai/computer/runtime'

const manager = new ComputerSidecarManager()
const availability = await manager.ensureAvailable()
if (availability.available) {
  const shot = await manager.screenshot()
}
manager.dispose()
```
