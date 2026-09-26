# @velaros-ai/velaros/act/agents

子任务与用户交互：模型用 `velaros:agents` 在同一运行时上派子任务（子任务继承父任务的能力与权限；等结果、回答它的提问、收束后续跑），用 `velaros:interaction` 向对方要信息、要确认或说明缺什么能力，用 `velaros:widget` 在对话里给用户显示小部件（图表、示意图、可交互的小工具）。宿主经 `createRuntime` 的 `agents` 开放子任务配置，主线的交互请求以 `interaction` 事件交给宿主回答，给了 `widgets` 显示端口才有小部件。

## 用法

```ts
import { createRuntime, type VelarosAgentsOptions } from '@velaros-ai/velaros'
import type { WidgetView } from '@velaros-ai/velaros/act/agents'
import type { ModelDriver } from '@velaros-ai/model'

// 宿主给：主模型与便宜些的模型、项目目录与状态目录（绝对路径），以及怎么问用户
declare const model: ModelDriver
declare const cheapModel: ModelDriver
declare const projectRoot: string
declare const stateDir: string
declare function askUser(kind: string, message: string, detail: unknown): Promise<unknown>
declare function showInConversation(widget: WidgetView, sessionId: string): void

// 配置名由宿主定：模型用 profiles() 看到说明、模块与预算；start 不给 profile 就用第一个
const agents: VelarosAgentsOptions = {
  profiles: {
    reviewer: { description: '只读审查代码，交回问题清单', model: cheapModel, modules: ['velaros:project'], budget: { modelCalls: 64 } },
    implementer: { description: '按批准的计划改代码', model, modules: ['velaros:project'] },
  },
  concurrency: 2,
  maxChildren: 32,
}
// 模型用 velaros:widget 的 show 交来的小部件由宿主显示在对应会话里
const widgets = { show: showInConversation }
const runtime = await createRuntime({ workspace: projectRoot, dataDir: stateDir, model, agents, widgets })
const session = await runtime.openSession('main')
for await (const event of session.submit('先审查登录模块，再按审查结论修复')) {
  // 主线的 ask、confirm 交给宿主；子任务的提问先交给父任务的模型，由它 reply。
  // ask 带选项或表单时 detail 是 { options, multiple, allowText, fields }，回答给 { choices } 或 { values }
  if (event.type === 'interaction')
    await session.answer({ id: event.request.id, runId: event.request.runId, value: await askUser(event.request.kind, event.request.message, event.request.detail) })
}

// 子任务是主会话的支线：追踪的 branches 里 kind 为 agent，按 sessionId 读各自的请求与回执
const page = await runtime.trace('main')
console.log(page.branches.filter((branch) => branch.kind === 'agent').map((branch) => branch.status))
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/act/agents` | Node | 运行时用的装配 `agentsModule`、`interactionModule`、`widgetModule`，它们要的宿主端口与每次调用的上下文，交给宿主显示的小部件 `WidgetView`，配置目录的数据 `AgentProfileInfo`，宿主读提问的 `interactionQuestions.read`（带选项或表单的问题返回 `InteractionRequest`，否则 null）；子任务配置的类型 `VelarosAgentsOptions`、`AgentProfile` 在包根入口 |

## 约定

- 不给 `agents` 时，工作区预设在有模型时开一个 `worker` 配置，能用全部已挂的业务能力（开了搜索还有 `velaros:search`）；`agents: true` 缺模型抛 `VALIDATION`，`agents: false` 关掉。
- 只有主线能派子任务，子任务里没有 `velaros:agents`；`velaros:interaction` 主线与子任务都有，搜索与整理支线没有。
- `start` 只要 `task`，立刻交回 job，子任务在后台开会话；不给 `profile` 用宿主给的第一个配置。配置的 `modules` 是子任务能用的模块，超出父任务实际有的能力时子任务直接失败，原因在 job 的 `error` 里；续跑时重新核对。
- 子任务继承父任务的权限：能写的与父任务一样，不用声明写入范围；共享空间按父任务此刻能用的全部空间和读写范围继承（续跑时重新继承），父任务能建空间它也能建，建的归它自己。几个子任务可以同时跑同一类事，写同一处的先后由各领域自己的版本核对把关。
- `concurrency` 是同时在跑的子任务上限，满了 `start` 当场抛 `CONFLICT`、不排队；同一逻辑任务派满 `maxChildren` 抛 `LIMIT`；模型请求另受 `modelTools` 的并发上限约束。
- 不给 `budget`、`limits` 用运行时的缺省额度；子任务的用量都受全部祖先的剩余额度约束。
- `ask` 可以给 `options`（2 到 8 个，最多一个 `recommended`；`multiple` 多选，`allowText` 另可自由作答）或 `fields`（1 到 8 项，`text`、`number`、`boolean`、`choice`），二者不同时给；形状不对当场抛 `VALIDATION`、不发起交互。宿主在 `interaction` 事件的 `detail` 里拿到选项与表单。
- 回答回到模型前按问题整理：`ask` 得到 `{ text?, choices?, values?, declined?, reason? }`，字符串当自由作答，问题里没有的选项、字段和类型不对的值丢掉；`confirm` 得到 `{ approved, reason? }`，只有布尔值或带 `approved` 的对象算数，其余回答一律按不同意、原文当理由。
- 交互的回答不授予任何权限：`confirm` 不代替具体操作的确认；子任务要换配置等它收束后由父任务 `resume`，已用预算保留。
- 子任务的请求与结果先持久化再唤醒父任务，结果随父任务的下一轮交回；父运行取消时子任务一起取消。
- 给了 `widgets` 才挂 `velaros:widget`：`show` 只在 execute 里调，核对标题（1 到 200 个字符）与代码（1 到 120000 个字符），高度收进 120 到 900（缺省 400）后带着调用身份交给宿主，立即返回。沙箱、主题变量、`sendPrompt` 回传都由宿主的显示负责。
- `agentsModule`、`interactionModule`、`widgetModule` 是运行时自己用的装配；只有自己拼 Kernel 的宿主才直接用，传 `AgentsHost`、`InteractionHost`、`WidgetHost`。
