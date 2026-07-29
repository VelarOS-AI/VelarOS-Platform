# @velaros-ai/browser

[中文接口文档](./docs/api.zh-CN.md)

## Responsibility

`@velaros-ai/browser` is the browser capability package. It ships four **independently importable
slices** behind one install unit — there is deliberately **no root export**, because the slices do
not share one runtime face: `./core` and `./tools` are host-agnostic, `./composition` is React, and
`./runtime` is Electron. A renderer bundle must never be able to reach Electron code by importing
the package root.

| Subpath | Slice | Runtime face |
| --- | --- | --- |
| `@velaros-ai/browser/core` | `src/core` | host-agnostic CDP automation runtime, drivers, policies, script builders |
| `@velaros-ai/browser/core/contracts` | `src/core/contracts.ts` | browser-safe DTOs + deterministic policies (no Node built-ins) |
| `@velaros-ai/browser/tools` | `src/tools` | host-injected agent tool collection |
| `@velaros-ai/browser/tools/cli` | `src/tools/cli.ts` | tool CLI entry |
| `@velaros-ai/browser/composition` | `src/composition` | React composition boundary (peer `react`) |
| `@velaros-ai/browser/runtime` | `src/runtime` | Electron-backed session/automation runtime (peer `electron`) |

Per-slice responsibility, boundaries and examples stay in `docs/<slice>/README.md` and
`docs/<slice>/api.zh-CN.md` — they moved verbatim from the four pre-merge packages.

## Boundary

Electron may only be imported under `src/runtime/**`; the capability arch gate enforces it. The
other three slices stay host-agnostic. Cross-slice access is by relative import inside the package
(`src/tools` → `../core`), never by package specifier.
