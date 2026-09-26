# @velaros-ai/kernel

VelarOS 的库优先微内核：只管模块生命周期、能力寻址、权限门与调用信封，不认识任何具体能力。能力包用它写内核模块，宿主在进程内 `createKernel()` 装配（正式产品经 `@velaros-ai/velaros` 的 `createRuntime` 间接使用），守护进程、瘦客户端与远程节点只是同一条调用路径的可选部署；ScriptAct 的模块调用主链、审批端口与中立模型端口 `ModelDriver`（供应商实现在 `@velaros-ai/model`）也在这里。

## 用法

```ts
import {
  createKernel,
  kernelModules,
  KernelCallErrorCodes,
  KernelVersionAxes,
  type KernelPermissionBroker,
} from '@velaros-ai/kernel'

// 能力包：一枚令牌加一个模块，模块激活时把操作表注册成可调用服务
const Notes = kernelModules.token('example.notes', '1.0.0')

export const notesModule = kernelModules.define({
  manifest: {
    id: 'example.notes.module',
    version: '1.0.0',
    apiVersion: KernelVersionAxes.moduleApi,
    provides: [Notes],
    requires: [],
    optionalRequires: [],
    permissions: ['notes:read'],
    isolation: 'in-process',
  },
  activate(context) {
    context.registerService(
      Notes,
      kernelModules.callable({
        read: {
          metadata: { permissions: ['notes:read'], reason: '读一条笔记' },
          invoke: (_scope, input) => `note ${(input as { id: string }).id}`,
        },
      })
    )
  },
})

// 宿主：带上自己的权限策略装内核，登记模块后启动
declare const permissionBroker: KernelPermissionBroker
const kernel = createKernel({ permissionBroker, lifecycleFailureMode: 'degrade' })
kernel.registerModule(notesModule)
await kernel.start()

try {
  const note = await kernel.invokeCapability({
    capabilityId: Notes.id,
    operation: 'read',
    input: { id: 'n1' },
    signal: AbortSignal.timeout(5_000),
  })
  console.log(note)
} catch (error) {
  if ((error as { code?: string }).code !== KernelCallErrorCodes.permissionDenied) throw error
  console.warn('用户没有授权读笔记')
}
await kernel.dispose()
```

ScriptAct 的模块调用走 `createOperationRuntime`：操作按 JSON Schema 声明，宿主给持久日志，每次调用交回已经落盘的回执。

```ts
import {
  createOperationRuntime,
  type InvocationJournal,
  type OperationModuleDefinition,
} from '@velaros-ai/kernel'

// 宿主的持久日志；@velaros-ai/context 的 createContextInvocationJournal 是一份现成实现
declare const journal: InvocationJournal

const notes: OperationModuleDefinition = {
  binding: { moduleId: 'example:notes', instanceId: 'notes-1', generation: 1, schemaRevision: '1' },
  summary: '读笔记',
  operations: {
    read: {
      summary: '按 id 读一条笔记',
      input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      output: { type: 'string' },
      effects: 'none',
      run: (input) => `note ${(input as { id: string }).id}`,
    },
  },
}

const runtime = createOperationRuntime({ modules: [notes], journal })
const receipt = await runtime.invoke({
  id: 'call-1',
  sessionId: 'session-1',
  executionId: 'run-1',
  binding: runtime.bind('session-1', 'example:notes'),
  operation: 'read',
  input: { id: 'n1' },
})
if (receipt.outcome === 'succeeded') console.log(receipt.value)
else console.warn(receipt.error?.code, receipt.retry)
await runtime.dispose()
```

附着到本机已经在跑的守护进程（serve 部署）：

```ts
import { KernelVersionAxes } from '@velaros-ai/kernel'
import { kernelDaemons } from '@velaros-ai/kernel/client'

const { client } = await kernelDaemons.connect()
const session = await client.openCapabilitySession({
  requires: [{ capabilityId: 'example.notes', operations: ['read'], scope: null }],
})
const response = await session.call({
  protocolVersion: KernelVersionAxes.protocol,
  callId: crypto.randomUUID(),
  capabilityId: 'example.notes',
  operation: 'read',
  scope: null,
  input: { id: 'n1' },
})
if (response.status === 'ok') console.log(response.output)
else console.warn(response.error.code, response.error.message)
await session.dispose()
await client.dispose()
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/kernel` | 任何进程 | 进程内内核 `createKernel`、模块 SDK `kernelModules`、模块调用主链 `createOperationRuntime`、审批与模型请求的中立合同、全部常量表；部署形态的接口也从这里以类型出包 |
| `@velaros-ai/kernel/contracts` | 任何进程 | 根入口的可移植子集：常量表与数据形状，不含任何实现 |
| `@velaros-ai/kernel/client` | Node | `kernelDaemons`：找到并连上本机已经在跑的守护进程 |
| `@velaros-ai/kernel/serve` | Node | 装起守护进程 `bootKernelDaemon`、可执行文件那一侧 `kernelDaemonProcess`、起或附着共享进程 `createKernelLauncher`、装或升级共享 Runtime `createKernelUpdater` |
| `@velaros-ai/kernel/remote` | Node（依赖 `ws`） | 远程能力节点两端：Node 侧 `createRemoteNodeServer` 与凭据、审计存储；Client 侧 `createRemoteNodeClient`、`createRemoteNodeProjection`、`createRemoteNodeIsolationAdapter` |

## 约定

- 错误类不出包：一律按 `error.code` 对常量表判断（能力调用 `KernelCallErrorCodes` 进程内与 wire 同码，模块宿主 `KernelErrorCodes`，客户端 `KernelClientErrorCodes`，更新器 `KernelUpdaterErrorCodes`，远程节点 `RemoteNodeErrorCodes`），`message` 只给人看，出事的能力、操作与权限挂在 `details` 上。
- 不给 `permissionBroker` 就是全拒；操作要的权限位必须同时写进模块清单的 `permissions`，没写的一律拒绝；未知操作在求权限之前就失败，任何一条被拒 provider 代码都不会运行。
- 模块只能在 `start()` 之前登记；`start()` 与 `dispose()` 只真正跑一次，启动先按依赖序全部激活、再全部就绪，任一步失败按逆序回滚；`lifecycleFailureMode: 'degrade'` 时失败不抛，只交给 `onLifecycleFailure`。
- `describeComposition()` 是只读观测面：能力的 `active: false` 表示只是声明了、这一代还没注册服务，依赖图解析不了的原因在 `resolutionError`；没有反向改写运行时的入口。
- `createOperationRuntime`：模块 id 写成 `域:名`（如 `velaros:files`）；调用前先 `bind(sessionId, moduleId)`；操作自己的失败不抛，落在回执的 `outcome` 与 `error.code` 里，调用本身不成立（没绑定、未知操作、参数不合 schema、调用号冲突）才抛。
- 同一 `(sessionId, id)` 再调一次交回已存的回执、不会重跑，换了参数抛 `IDEMPOTENCY_CONFLICT`；`retry` 不是 `safe` 的调用别盲目重跑，效果未知的可以用 `reconcile` 按领域登记的核对器只读确认。
- `InvocationJournal.claim` 必须跨进程原子去重，`settle` 失败必须抛错；没有审批界面的宿主用 `defaultDenyApprovalPort`，需要审批的操作一律拒绝。
- 守护进程的 wire 协议只接受完全相同的版本，异版本抛 `PROTOCOL_VERSION_MISMATCH` 并给出升级方向；会话之外的能力调用一律 `CAPABILITY_NOT_GRANTED`，会话不跨连接。
- 远程节点装配顺序固定：`createRemoteNodeClient(...).connect()` 拿清单 → `createRemoteNodeProjection` 投影成本地代理模块 → `createRemoteNodeIsolationAdapter` 作为 `isolationAdapters` 交给内核，再登记投影出的模块；清单变更时从投影起整份重来。
- 远程调用失败先看错误的 `resultUnknown`：为真表示调用已经上线却拿不到终态，重试可能造成第二次副作用。
