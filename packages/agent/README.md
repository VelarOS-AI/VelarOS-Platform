# @velaros-ai/agent

Act 执行核心：一个会话的持久运行控制（`createActRunService`）、单一模型循环，以及有界的子任务调度（`createAgentSupervisor`）。正式宿主经 `@velaros-ai/velaros` 的 `createRuntime` 使用它，那里已装好 ScriptAct 协议、上下文帧策略、执行入口与预算；自己装配的宿主按下面的端口接入，界面只要数据时用 `./contracts`。

## 用法

```ts
import {
  createActRunService,
  type ActContextPort,
  type ActExecutionPort,
  type ActInteraction,
  type ActProtocolPort,
} from '@velaros-ai/agent'
import { createContextRuntime, createContextView, type ContextStorage } from '@velaros-ai/context'
import type { ModelDriver } from '@velaros-ai/kernel'

// 宿主提供：存储、模型驱动（@velaros-ai/model 造）、ScriptAct 协议、上下文帧策略、统一执行入口
declare const storage: ContextStorage
declare const model: ModelDriver
declare const protocol: ActProtocolPort
declare const frames: ActContextPort
declare const execution: ActExecutionPort
declare function askUser(request: ActInteraction): Promise<unknown>

const sessionId = 'session-1'
const context = createContextRuntime({ sessionId, storage })
const view = createContextView({ sessionId, storage, context, sources: [] })
const session = createActRunService({
  sessionId,
  storage,
  context,
  view,
  model,
  protocol,
  frames,
  execution,
  instructions: '你是这个项目里的执行助手。',
  limits: {
    turns: 200,
    outputTokens: 4_096,
    safetyTokens: 1_024,
    projectionChars: 400_000,
    recoveryChars: 6_000,
    timeoutMs: 3_600_000,
  },
})

for await (const event of session.submit({ text: '修好 README 里的错别字', task: 'new' })) {
  if (event.type === 'text') console.log(event.text)
  else if (event.type === 'interaction')
    await session.answer({
      id: event.request.id,
      runId: event.runId,
      value: await askUser(event.request),
    })
  else if (event.type === 'state' && event.status === 'context_blocked')
    console.warn('上下文容量不够，这一轮停在这里')
}
await session.close()
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/agent` | Node | 运行服务 `createActRunService`、子任务调度 `createAgentSupervisor`、宿主要实现的端口，以及 `./contracts` 的全部数据 |
| `@velaros-ai/agent/contracts` | 任何进程 | 输入、事件、运行快照、交互、预算与子任务句柄等可移植数据 |

## 约定

- 一个会话同一时刻只有一个运行：运行中再 `submit` 抛 `CLOSED`；运行中的补充用 `steer`，它从到达起抢占还没被接受的模型响应，在轮边界递交，没有活动运行时抛 `UNAVAILABLE`。
- 提前退出 `submit` 的迭代就是取消这次运行；终态的 `state` 事件要等执行、租约与帧的收尾全部完成才发出。
- 执行端口要问用户时调 `request(kind, message, signal)`，它发出 `interaction` 事件并等 `answer`；回答只认当前运行的那一次交互，重复或过期抛 `CONFLICT`，运行结束时没回答的一律拒绝。
- 效果不明的操作不挡运行：它照实留在结算事实里给模型看，运行照常推进、照常收尾，不等宿主核对。
- `verification` 事件的可选 `report` 是领域真实核查的范围与依据，包含通过、失败或未知项及检查时刻；宿主按 `verified` 和报告范围展示结果，不能把单项通过解释成整题证明。原事件持久化并可重放。
- 完成失败后的恢复提示列出状态、原因、恢复动作与 `reportAvailable`；完整报告由领域事件与任务归档保留，当前视图按实际预算提供有来源的报告目录。
- `task: 'new'` 开新的逻辑任务与总预算（旧任务归档保留），缺省 `continue` 沿用原任务。
- `inputId` 只是宿主的消息身份，原样回到 `input`、`input-applied`、`input-retained` 回执里，不做重复提交去重；`input-applied` 只说明输入进了某次已归档的模型请求，不证明供应商已经收到。
- 输入或已接受的响应落不了盘时，不派发模型也不执行脚本：`submit` 的迭代抛出原错误，运行记为可恢复的 `failed`。
- 运行事件与状态都在 `ContextStorage` 里：`events(after)` 按持久序号重放，重启后 `inspect()` 给出恢复的状态；运行服务自己只持有本进程的取消权与待回答的交互。
- 模型报告的缓存读写用量同时保存在 `usage` 事件和 `model-response` 审计中；缺省表示供应商没有报告，不能当作零命中。
- `createAgentSupervisor` 在启动子任务前就核对额度：累计超过 `maxChildren` 抛 `LIMIT`（跨重启与继续不重置，显式新任务才重新计数），并发已满抛 `CONFLICT`；父运行结束或取消时由宿主调 `cancelParent` 收束它的子任务。
- 子任务的 `job.result` 指向父会话里的一条结果摘要：只内嵌有界的事件尾部并报告略去条数（`omittedEvents`），完整事件在子会话里。
- 完整且通过协议校验的模型延续状态单独归档，由已接受响应引用；截断、协议拒绝或保存失败不会派发脚本，也不会把不透明状态交给宿主展示。
- 协议修复重发沿用当前实测校准，对追加诊断后的完整请求重新核对预算；供应商拒绝超窗时清空校准并重组。未通过协议的响应不会执行，修复估算也服从运行取消和截止时间。
- 活动运行的 `validateContext` 以相同实测校准、工作窗口和输出预留验收候选请求，不调用模型或推进回合；无活动运行时抛 `UNAVAILABLE`，估算服从调用方与运行自身的取消。无图片的推理延续请求也提供保守校准样本，其不透明状态容量仍单独预留。
- 容量校准分别估计固定开销和正文增长，并用安全余量覆盖滚动窗口内全部实测样本；样本不足或趋势不可用时采用保守比例，校准不超过原始文本估算，也不影响精确计数、图片或不透明状态预留。
- 相邻封段过近时暂缓预测性的提前封段；实际请求超出工作窗口时仍尝试封存可回收的历史，每次组帧最多成功封段一次。无可回收历史时继续走有界整理与恢复投影，仍超窗则报告容量受阻。
- 专项原生工具执行成功后，宿主可通过 `frames.deliveryReady` 请求进入普通完成核查，省去最终产物已受理后的模型确认轮。该决定独立记入 `execution-completion` 审计；执行失败、待处理工作、用户补充和领域核查仍阻止完成。
