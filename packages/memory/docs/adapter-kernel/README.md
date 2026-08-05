# @velaros-ai/memory/adapter-kernel

> `@velaros-ai/memory` 的一个导入切片(`packages/memory/src/adapter-kernel`)。包总览见
> [包 README](../../README.md)。

## 这个切片是什么

内核(`@velaros-ai/agent`)与记忆产品(`@velaros-ai/memory`)之间**唯一合法的双向胶水点**。

它拥有三个宿主策略服务,负责把内核 / 会话活动翻译成记忆产品调用,反之亦然:

- **`MemoryEvidenceBridge`** —— 会话 / 执行 / 工作区事件 → `capture`(采集端口)。
- **`MemoryTurnRecallCoordinator`** —— 回合开始时的异步召回 → 一个 `turn-context` delta 源
  (`memory.recall`,第八源;对 renderer 不可见)。
- **`MemoryDreamScheduler`** / **`MemoryService`** —— 后台 Dream 调度 + 薄治理门面
  (诊断 / 立即运行 / warmup / close)。

## 三端口接缝:这个切片为什么存在

按 Desktop 仓 `docs/kernel-contract.md` §7,内核对记忆的**全部**接口就是三个端口,
而且内核持有**零个** `@velaros-ai/memory` 的 `import`:

1. **turn-context 源注册** —— `turnRecall.createTurnContextSource()` 把 `memory.recall`
   注册成一个 turn-context 源;**内核从不直接查询记忆**。
2. **工具注册** —— 记忆 / 知识工具由 `@velaros-ai/memory` 提供,经共享 ToolContext DI 注册。
3. **会话事件订阅** —— 采集端口:重要会话事件经 `MemoryEvidenceBridge` 流进证据层。

> **想加"第四个端口"的冲动必须拒绝**(例如让治理管线直接查记忆)。
> 记忆对上下文的每一份贡献都必须走 turn-context 源——否则两个域会重新长回一起。

## `mountMemoryAdapter(...)` —— 单一装配入口

宿主一次调用完成接线:传入记忆领域 + 三个窄宿主端口,拿回三个挂载点。

```ts
import { mountMemoryAdapter } from '@velaros-ai/memory/adapter-kernel'

const memory = mountMemoryAdapter({
  domain: memoryRuntime.memoryDomainService,
  idleSignal: createDesktopMemoryHostIdleSignal(), // Electron 实现留在宿主胶水里
  config: { isEnabled, isBackgroundGrowthEnabled, allowBatteryGrowth, isAutomaticDeepRecallEnabled },
  hostContext: {
    turnContextScopes: ['system', 'project', 'browser'],
    resolveScope: ({ sessionId, workspaceRoot, contextId }) =>
      hostMemoryScopePolicy.resolve({ sessionId, workspaceRoot, contextId }),
    environmentContextBlockOpenTag: '<environment-context>',
  },
})

turnContextFanIn.register(memory.turnRecall.createTurnContextSource())
// memory.evidenceBridge → 聊天采集;memory.service → IPC / warmup / close
```

`MemoryAdapterRuntime` 是它的 class 形态,`mountMemoryAdapter` 是兼容工厂。

## 后端解析(`velaros.memory.store.*`)

自记忆后端 mod 化判决(kernel-contract §15.7 / 蓝图 §九)起,适配器**不再为采集与召回直接
跟记忆树对话**。它经一族 capability token 解析出**一个** `MemoryStoreBackend`
(`@velaros-ai/memory/backend` 里那个实现无关的动词端口):

```ts
host.registerModule(createMemoryStoreKernelModule({
  backend: createMemoryFilesBackend({ roots, io }),
}))

const memory = mountMemoryAdapter({
  domain,                                   // 仍是树的治理门面(warmup / Dream)
  store: { registry: host, preference: ['files', 'tree'] },
  /* idleSignal, config, hostContext … */
})
memory.storeDescriptor.id // 'files'
```

- **每档后端一个 token**(`velaros.memory.store.files` / `.tree` / `.vector`)。
  内核服务存储对同一 capability id 只允许一个活动服务,而三档必须能**叠加**、不能互相顶掉
  ——所以是三个 token,不是一个。
- 省略 `store` → 回落到把 `domain` 包成 `tree` 后端,逐字转发每个动词(**行为保持**的默认)。
- 什么都解析不到 → `undefined`,即 partial activation 的「**缺席,不是降级**」语义。
- 采集桥与回合召回协调器**只消费那个窄端口**,所以没有整合管线的后端(如 `memory-files`)
  单纯没有 `dream` 动词,不需要假装有。

接线图与宿主挂载点见
[`docs/memory/memory-backends.md`](../../../../docs/memory/memory-backends.md)。

## 宿主信号端口

`MemoryDreamScheduler` 需要三个宿主运行时读数:系统空闲秒数、是否用电池、前台焦点。
Desktop 上它们来自 Electron(`powerMonitor` / `BrowserWindow`),但**适配器本身是 host 无关的**
——读数经窄端口 `HostIdleSignalPort` 注入,Electron 实现留在宿主胶水里,
headless 宿主注入一个常量实现即可。

## 边界

- 本切片**可以** import `@velaros-ai/core` 与 `@velaros-ai/memory`——它就是胶水。
- Core 的 import **限于**通用值 / 错误 / turn-context 契约。
  聊天、Workspace、Browser、记忆 scope 与会话存储 DTO 必须**先归一成本切片自己的 host contract**
  才能跨边界。
- **不许** import `electron` / `@electron/*`、Desktop IPC(`@velaros-ai/ipc`)
  或任何 `apps/desktop` 的 renderer / main 路径。
- **`@velaros-ai/agent`(内核)不许 import 本切片,也不许 import `@velaros-ai/memory`。**

以上由 arch-guard 棘轮 `velaros/memory-product-boundary` 执法(基线:零违规)。

## 生命周期与并发

每个记忆 domain 建**一个**适配器实例。宿主 ready 后 `service.warmup()`,退出前 `service.close()`。
Dream scheduler 由实例持有,**不使用进程全局计时器**;同一 domain 不应挂多个并发 scheduler。

## 错误模型

领域校验错误沿用 `AppError`。默认 warmup 对后台整理失败采取「记日志并继续」,
诊断留在 Memory run ledger;**显式治理调用的错误直接返回给调用方**,不吞。

## 扩展点

- 自定义 `MemoryHostScopeResolver` → 适配任意租户 / 项目模型;
- 从消息队列、HTTP 或本地事件源调用 `MemoryEvidenceBridge`;
- 自定义 `HostIdleSignalPort` → 接服务器负载、移动端电量或前台状态;
- `createMemoryStoreKernelModule` → 把一个记忆后端档注册进其他兼容 Kernel 宿主
  (`velaros.memory.store.<id>` token 族,与 bundled 默认档同一条注册路径)。
