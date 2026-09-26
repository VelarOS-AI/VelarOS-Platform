# @velaros-ai/velaros/act/runtime

Act 运行时：把模型、脚本执行、Kernel 与上下文存储装成一条执行链，宿主用 `createRuntime` 开会话、交用户输入、收运行事件。它承载 velaros 包的根入口；模型自管理的 `velaros:system` 在 [act/system](../system/README.md)，搜索与子任务在 [act/search](../search/README.md)、[act/agents](../agents/README.md)。

## 用法

```ts
import { createRuntime } from '@velaros-ai/velaros'

// 宿主给：模型凭据，项目目录与状态目录（都是绝对路径，状态目录在项目之外），以及怎么问用户
declare const apiKey: string
declare const projectRoot: string
declare const stateDir: string
declare function askUser(message: string): Promise<string>

const runtime = await createRuntime({
  workspace: projectRoot,
  dataDir: stateDir,
  model: { provider: 'openai', model: 'your-model', baseURL: 'https://api.openai.com/v1', apiKey },
  // 其余能力经 modules 挂进来（createCapabilityModule 等），见各单元的 README
})
try {
  const session = await runtime.openSession('main')
  let status = 'idle'
  for await (const event of session.submit('找出登录失败的原因并修好')) {
    if (event.type === 'accepted') console.log(event.text) // 这一轮被接纳的正文；流式预览在 text、program 事件里
    else if (event.type === 'interaction')
      // 模型的 ask、confirm、capability：一个请求只收一次答案
      await session.answer({ id: event.request.id, runId: event.request.runId, value: await askUser(event.request.message) })
    else if (event.type === 'error') console.error(event.message)
    else if (event.type === 'state') status = event.status
  }
  if (status !== 'completed') console.warn('运行没有完成：', status)
} finally {
  await runtime.close()
}
```

渲染进程把同一串事件投影成界面状态：

```ts
import type { ActRunEvent } from '@velaros-ai/agent'
import { createActEventProjector } from '@velaros-ai/velaros/renderer'

// 主进程按顺序转来的 submit 事件
declare const liveEvents: AsyncIterable<ActRunEvent>

const projector = createActEventProjector()
for await (const event of liveEvents) {
  const run = projector.applyLive(event).runs[event.runId]
  console.log(run.status, run.messages.at(-1)?.text ?? run.preview) // 接纳过的正文；没接纳的只是预览
}
projector.finish() // 交付结束：清掉没接纳的预览
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros` | Node | `createRuntime` 与会话；把能力挂进来的 `createCapabilityModule`、`createShellCapabilityModule`、`createProjectCapabilityModule`、`createMcpModule` 与 `createMcpClientConnection`；可靠交付 `createEventDelivery` |
| `@velaros-ai/velaros/contracts` | 任何进程 | 上限与代际 `VelarosRunLimits`、`McpLimits`、`ScriptLeaseLimits`、`GoalLimits`（宿主用用户正文建目标前按它截断）、`VelarosRuntimeContract`，目标、笔记、追踪、搜索结果这些可移植数据 |
| `@velaros-ai/velaros/renderer` | 任何进程，含渲染进程 | 事件投影 `createActEventProjector` 与展示快照 `ActPresentation` |

## 约定

- `workspace` 是已有目录的绝对路径，`dataDir` 是绝对路径且按真实路径在工作区之外；不注入 `storage` 时 `dataDir` 必填。不合要求抛 `VALIDATION`。
- 给了 `workspace` 或声明式 `model` 就按工作区预设装：项目能力与项目证据来源、`worker` 子任务、`standard` 搜索档位；给了 `dataDir` 还带 `dataDir/memory` 下的长期记忆。`project`、`agents`、`search`、`memory` 设成 `false` 分别关掉；没有 `workspace`、`model` 又是注入的驱动时，子任务与搜索只在显式配置时才开。
- 声明式 `model` 要有 `model` 与 `apiKey`，`baseURL` 是不带凭据和查询串的 http(s) 地址，`limits` 的输入、输出加安全余量不能超过总窗口；凭据只用来建驱动，不进模型材料与追踪。
- 业务能力经 `modules` 挂；`velaros:system` 及其成员、`velaros:program`、`velaros:context-materials` 是保留身份，长期记忆只能经 `memory(sessionId)` 装；给了 `workspace` 又自己挂 `velaros:project` 或 `project` 来源（没设 `project: false`）也抛 `VALIDATION`。
- 会话 id 第一次 `openSession` 时与工作区真实路径原子绑定，换工作区重开抛 `WORKSPACE_BINDING_MISMATCH`；`project: false` 也保留这份绑定。
- `submit` 在执行、租约与收尾都结束后才交出终态 `state`（`completed`、`cancelled`、`failed`、`context_blocked`、`needs_reconcile`），它是最后一个事件；失败先交一个 `error` 事件，存储这类基础故障在交出这两个事件之后还会从迭代器抛出。
- `needs_reconcile` 表示有写操作效果未决，运行时不会重放脚本；宿主调 `session.reconcile()` 用各能力登记的核对器收束。
- `interaction` 用 `answer` 回答，`runId` 不对、重复回答、运行已结束或取消都会被拒绝；运行中 `steer` 追加输入、抢占还没接纳的模型回复，`cancel()` 立刻取消。
- `authorize` 在每次派发前调用，抛错即拒绝、操作还没执行；写操作默认互斥，`effectResources` 给出完整的冲突资源集合后，互不相交的才并行。
- `instructions` 是宿主可信的产品指令（身份、界面语言、模式），追加到主会话说明并计入预算；它不是授权，专项模型工具不继承，用户输入与文件正文不放这里。
- `residentModules` 列出常驻模块：主会话可用的那些把完整声明与用法示例附在运行说明末尾，模型直接 import 使用，不必先 `modules.list` / `describe`；未挂载的忽略。它随会话配置固定，不影响前缀缓存，但每次请求都计入预算，只放每轮都会用的模块。
- `environment` 返回宿主环境条目（如 `{ os: 'macOS 26.3.1 (arm64)' }`），每帧和运行时自己读的当地时间一起放进 `runtime.environment`：`time` 是带时区偏移的 ISO 时间，`localTime` 带星期，`timezone` 是时区名，这三项宿主不能覆盖。它在帧尾，不影响前缀缓存；主会话、子任务和专项模型工具都会带上，回调抛错或返回的不是文本键值时这一帧只给时间。
- `createRuntime` 成功后接管注入的 `storage`，`runtime.close()` 时关闭，初始化失败时连接仍归调用方；`session.close()` 只关这个会话，同 id 再 `openSession` 恢复持久数据；`runtime.close()` 重复调用安全。
- `runtime.trace(rootSessionId, query)` 分页读原始请求、回复、脚本与回执，支线关闭后也能读，不唤醒模型；运行中的回合要重读。每个回合的 `executions` 按声明顺序列出这一回合派发的 execute：`position` 对应该回合第几个 execute 程序事件，`status` 与 `failure`（带出错行）由持久结果和调用回执推出，租约带进这一帧的旧结果不在里面。宿主画脚本卡直接用它，不要解析 `records` 里的内部记录。
- `onMetric` 只收不含正文的计量，回调要快速返回，抛错不影响业务结果。
- `createShellCapabilityModule` 给了 `output`，前台命令跑着时每吐出一段就回调一次，带上会话、`executionId` 与调用 `invocationId`（与追踪里的同名字段相同），宿主据此把运行中的输出画在对应的脚本卡上；回调要快速返回，抛错只记日志、不打断命令。
- 投影器的 `apply` 收持久事件、按游标去重，`applyLive` 收实时事件、预览不推进游标；交付结束调 `finish()`，重新消费要建新的投影器。
- `createEventDelivery({ persist, deliver })` 先落盘再严格按 append 顺序交付，落盘可以合批；任何一步失败就停止后续交付，首个错误留给 `append`、`flush`、`close`。
