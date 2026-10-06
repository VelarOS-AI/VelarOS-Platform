# @velaros-ai/velaros/sandbox

演练沙箱：代码面 `velaros:sandbox` 的 `create`、`run`、`diff`、`apply`、`discard`，把一个目录镜像到临时区，命令在镜像里跑、写不到外面，看过差量再落回源目录。系统空间和项目空间挂同一份实现，作用域由空间端口定；本机沙箱在 `./local`，项目里的端口用 `@velaros-ai/velaros/project` 的 `projectCapabilityPorts.sandbox`。

## 用法

```ts
import { createCapabilityModule } from '@velaros-ai/velaros'
import type { ApprovalPort } from '@velaros-ai/kernel'
import { sandboxOperations, type SandboxOperationContext, type SandboxSurfacePort } from '@velaros-ai/velaros/sandbox'
import { VelarSandboxModule } from '@velaros-ai/velaros/sandbox/contracts'
import { createLocalSandboxHost } from '@velaros-ai/velaros/sandbox/local'

// 镜像里的危险命令经它问用户
declare const approval: ApprovalPort
// 作用域由宿主定：交回绝对路径，不给就是这个空间的根，越界抛 PERMISSION
declare function resolveSystemPath(path?: string): string

// 空间端口 = 本机沙箱的五件 + 这个空间的作用域
const host = createLocalSandboxHost()
const sandbox: SandboxSurfacePort = {
  createSandbox: (options) => host.createSandbox(options),
  runInSandbox: (options, abortSignal) => host.runInSandbox(options, abortSignal),
  diffSandbox: (options) => host.diffSandbox(options),
  applySandbox: (options) => host.applySandbox(options),
  discardSandbox: (sandboxId) => host.discardSandbox(sandboxId),
  resolveSource: async (source) => resolveSystemPath(source),
}

// 宿主自己调用：建镜像 → 在镜像里跑 → 看差量 → 落回 → 丢弃
const context: SandboxOperationContext = { abortSignal: new AbortController().signal, sandbox, approval }
const { id } = await sandboxOperations.create({ source: '~/projects/site' }, context)
const run = await sandboxOperations.run({ id, command: 'npm run build' }, context)
const diff = await sandboxOperations.diff({ id }, context)
console.log(diff.created, diff.modified, diff.deleted)
if (run.success) await sandboxOperations.apply({ id }, context)
await sandboxOperations.discard({ id }, context)

// 挂成模型程序里可以 import 的 velaros:sandbox
export const sandboxModule = createCapabilityModule({
  surface: VelarSandboxModule,
  implementation: sandboxOperations,
  instanceId: 'system-sandbox',
  context: (call) => ({ abortSignal: call.signal, sandbox, approval }),
})
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/sandbox` | 任何进程 | `sandboxOperations`、落回核对 `rehearsalSandboxRules`、宿主端口与调用上下文、本机沙箱的接口与配置（只有类型） |
| `@velaros-ai/velaros/sandbox/contracts` | 任何进程 | 上限 `RehearsalSandboxLimits`、错误码 `SandboxErrorCodes`、可移植数据、模型面 `VelarSandboxModule` |
| `@velaros-ai/velaros/sandbox/local` | Node | 本机演练沙箱 `createLocalSandboxHost` |

## 约定

- `resolveSource` 要交回绝对路径；本机沙箱不替空间补相对路径，给相对路径抛 `VALIDATION`。
- 镜像里的命令由 `@velaros-ai/velaros/execution` 的受约束执行器钉在镜像根，只能写镜像和沙箱自己的临时目录，网络缺省断开；没有约束后端的宿主建不出沙箱（`SHELL_CONFINEMENT_UNAVAILABLE`），Windows 要在配置里注入 `confinementProvider`。
- 镜像里的危险命令照 execution 宿主的判定经 `approval` 问，被拒就抛错、不起进程；`apply` 不问用户。
- `apply` 先按完整差量核对再落：点名了没变化的路径抛 `VALIDATION`，源目录自建沙箱以来变过抛 `SANDBOX_CONFLICT`，镜像在核对之后又变过抛 `SANDBOX_CHANGED`，三种都是一个文件都没写；落到一半出错时错误的 `context.applied` 点名已落的路径；`.git` 的变化永远不落。
- 同时最多 `RehearsalSandboxLimits.sandboxes` 个沙箱，源目录超过 `RehearsalSandboxLimits.files` 个文件或 `RehearsalSandboxLimits.bytes` 字节建不出；差量与输出不折叠，只守内存上限，超出的点名没附差量或标 `truncated`。
- 镜像落在沙箱基目录（缺省是系统临时目录下的 `velaros-sandbox`），宿主重启后按 id 从清单重新认出；`dispose()` 只停镜像里的进程、保留镜像，删镜像要 `discard`。
