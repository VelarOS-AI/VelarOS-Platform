# @velaros-ai/computer

[中文接口文档](./docs/api.zh-CN.md)

## Responsibility

`@velaros-ai/computer` is the computer-control capability package. It ships two **independently
importable slices** behind one install unit; there is deliberately **no root export**, so a host that
only composes the sidecar runtime never drags the agent tool collection (and its zod schema surface)
into its graph.

| Subpath | Slice | Responsibility |
| --- | --- | --- |
| `@velaros-ai/computer/runtime` | `src/runtime` | injectable OS-level sidecar manager + JSON-lines protocol |
| `@velaros-ai/computer/tools` | `src/tools` | host-injected observation / input-control agent tools |

The bundled Python helper scripts stay at the package root under `runtime/` (published asset
directory, unrelated to the `src/runtime` slice) and are resolved from host-provided resource roots.

Per-slice responsibility, boundaries and examples stay in `docs/<slice>/README.md` and
`docs/<slice>/api.zh-CN.md` — they moved verbatim from the two pre-merge packages.
