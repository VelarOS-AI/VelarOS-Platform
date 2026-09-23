# @velaros-ai/velaros/act/agents

子任务与用户交互：模型用 `velaros:agents` 在同一运行时上派有界的子任务（选宿主开放的配置、等结果、回答它的提问、收束后续跑），用 `velaros:interaction` 向对方要信息、要确认或说明缺什么能力。宿主经 `createRuntime` 的 `agents` 开放子任务配置，主线的交互请求以 `interaction` 事件交给宿主回答。

## 用法

```ts
import { createRuntime, type VelarosAgentsOptions } from '@velaros-ai/velaros'
import type { ModelDriver } from '@velaros-ai/model'

// 宿主给：主模型与便宜些的模型、项目目录与状态目录（绝对路径），以及怎么问用户
declare const model: ModelDriver
declare const cheapModel: ModelDriver
declare const projectRoot: string
declare const stateDir: string
declare function askUser(kind: string, message: string): Promise<unknown>

// 配置名由宿主定：模型用 profiles() 看到说明、模块与预算，只能按名字选
const agents: VelarosAgentsOptions = {
  profiles: {
    reviewer: { description: '只读审查代码，交回问题清单', model: cheapModel, modules: ['velaros:project'], budget: { modelCalls: 64 } },
    implementer: { description: '按批准的计划改代码', model, modules: ['velaros:project'] },
  },
  concurrency: 2,
  maxChildren: 32,
}
const runtime = await createRuntime({ workspace: projectRoot, dataDir: stateDir, model, agents })
const session = await runtime.openSession('main')
for await (const event of session.submit('先审查登录模块，再按审查结论修复')) {
  // 主线的 ask、confirm、capability 交给宿主；子任务的提问先交给父任务的模型，由它 reply
  if (event.type === 'interaction')
    await session.answer({ id: event.request.id, runId: event.request.runId, value: await askUser(event.request.kind, event.request.message) })
}

// 子任务是主会话的支线：追踪的 branches 里 kind 为 agent，按 sessionId 读各自的请求与回执
const page = await runtime.trace('main')
console.log(page.branches.filter((branch) => branch.kind === 'agent').map((branch) => branch.status))
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/act/agents` | Node | 运行时用的装配 `agentsModule`、`interactionModule`，它们要的宿主端口与每次调用的上下文，配置目录的数据 `AgentProfileInfo`；子任务配置的类型 `VelarosAgentsOptions`、`AgentProfile` 在包根入口 |

## 约定

- 不给 `agents` 时，工作区预设在有模型时开一个 `worker` 配置，能用全部已挂的业务能力（开了搜索还有 `velaros:search`）；`agents: true` 缺模型抛 `VALIDATION`，`agents: false` 关掉。
- 只有主线能派子任务，子任务里没有 `velaros:agents`；`velaros:interaction` 主线与子任务都有，搜索与整理支线没有。
- `start` 立刻交回 job，子任务在后台开会话：配置的 `modules` 是精确白名单，超出父任务实际有的能力、或 `writes` 超出 `modules` 时子任务直接失败，原因在 job 的 `error` 里；续跑时重新核对。
- 子任务要写，得在 `start`、`resume` 的 `writes` 里占用模块，没占用就写抛 `PERMISSION`；两个在跑的子任务写入范围不能重叠（`CONFLICT`）。
- `concurrency` 是同时在跑的子任务上限，满了 `start` 当场抛 `CONFLICT`、不排队；同一逻辑任务派满 `maxChildren` 抛 `LIMIT`；模型请求另受 `modelTools` 的并发上限约束。
- 不给 `budget`、`limits` 用运行时的缺省额度；子任务的用量都受全部祖先的剩余额度约束。
- 交互的回答不授予任何权限：`confirm` 不代替具体操作的权限校验，子任务换能力或写入范围要等它收束后由父任务 `resume`，已用预算保留。
- 子任务的请求与结果先持久化再唤醒父任务，结果随父任务的下一轮交回；父运行取消时子任务一起取消。
- `start` 的 `stores` 只能是父任务空间权限的子集，子任务没有创建权；配置里 `stores: false` 关掉这项共享。
- `agentsModule`、`interactionModule` 是运行时自己用的装配；只有自己拼 Kernel 的宿主才直接用，传 `AgentsHost`、`InteractionHost`。
