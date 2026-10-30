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

- 当前投影仍包含的图片可随已接受请求前缀复用；按数据、类型、来源、标签和重复次数核对，只追加新附件，不延长展示租约。图片移除、历史改写或容量重建会撤掉相应视觉前缀；另保留纯文本基线供回退。会话关闭时释放两份基线。

- 已接受请求的实际前缀由打开的会话持有，连续用户提交之间沿用；每次仍核对逻辑历史、授权正文与容量，历史变化、历史帧超过独立预算或窗口不足时重建。`frames.policy.retainedFrameRatio` 控制历史帧占输入工作窗口的上限比例，默认 `1`，`0` 每轮重建，`1` 仅受总容量约束。历史帧按同一模型驱动校准后的边际输入估算，重建后重新核对正文覆盖；计量写入 `model-request.retention` 审计，供应商账单仍取真实 usage。进程重启与重新打开会话从持久历史重建。

- 一个会话同一时刻只有一个运行：运行中再 `submit` 抛 `CLOSED`；运行中的补充用 `steer`，它从到达起抢占还没被接受的模型响应，并唤醒执行的前台与后台等待；执行端口的 waitSignal 只控制返回等待，原程序沿运行级 signal 继续，补充内容持久化后在轮边界递交，没有活动运行时抛 `UNAVAILABLE`。
- 提前退出 `submit` 的迭代就是取消这次运行；终态的 `state` 事件要等执行、租约与帧的收尾全部完成才发出。
- 子任务 `send` 在启动期间等待同一运行接纳；可选的调用者取消信号只结束这次等待，父运行取消同时取消子任务。进入收束后的输入会报告当前状态并指向显式 `resume`，续跑沿用原会话与累计预算。
- 执行端口要问用户时调 `request(kind, message, signal)`，它发出 `interaction` 事件并等 `answer`；回答只认当前运行的那一次交互，重复或过期抛 `CONFLICT`，运行结束时没回答的一律拒绝。
- 效果不明的操作不挡运行：它照实留在结算事实里给模型看，运行照常推进、照常收尾，不等宿主核对。
- `verification` 事件的可选 `report` 是领域真实核查的范围与依据，包含通过、失败或未知项及检查时刻；宿主按 `verified` 和报告范围展示结果，不能把单项通过解释成整题证明。原事件持久化并可重放。
- `contextStatus.cache` 只投影上一次请求实际报告的缓存分项；readTokens、writeTokens 缺项表示未知。请求没有缓存用量时清除旧摘要，明确报告的零仍为零；账单继续使用独立的 usage 事件与审计。
- 完成失败后的恢复提示列出状态、原因、恢复动作与 `reportAvailable`；完整报告由领域事件与任务归档保留，当前视图按实际预算提供有来源的报告目录。
- 子任务暂停或失败时，句柄的 `error` 直接保留当前停止原因，完整事件仍从 `result` 读取；后续已接受回合或成功核查会清除已恢复的诊断。恢复同一子任务继续累计原有用量，预算耗尽后需要可用的宿主预算。
- `task: 'new'` 开新的逻辑任务与总预算（旧任务归档保留），缺省 `continue` 沿用原任务。
- `inputId` 只是宿主的消息身份，原样回到 `input`、`input-applied`、`input-retained` 回执里，不做重复提交去重；`input-applied` 只说明输入进了某次已归档的模型请求，不证明供应商已经收到。
- 输入或已接受的响应落不了盘时，不派发模型也不执行脚本：`submit` 的迭代抛出原错误，运行记为可恢复的 `failed`。
- 运行事件与状态都在 `ContextStorage` 里：`events(after)` 按持久序号重放，重启后 `inspect()` 给出恢复的状态；运行服务自己只持有本进程的取消权与待回答的交互。
- 模型报告的缓存读写用量同时保存在 `usage` 事件和 `model-response` 审计中；缺省表示供应商没有报告，不能当作零命中。
- 模型请求审计超过单对象容量时，将原生图片 base64 独立归档为 `model-request:image-data`，审计中的像素使用 `{$velarosType:'context-image', ref, encoding}` 引用；`encoding:'data-url'` 另保留原 `prefix`。按同会话引用回读后可逐字还原原请求及其指纹；审计 `sources` 列出这些引用。发送给模型的请求不变，取消或归档失败时不派发。
- `createAgentSupervisor` 在启动子任务前就核对额度：累计超过 `maxChildren` 抛 `LIMIT`（跨重启与继续不重置，显式新任务才重新计数），并发已满抛 `CONFLICT`；父运行结束或取消时由宿主调 `cancelParent` 收束它的子任务。
- 子任务的 `job.result` 指向父会话里的一条结果摘要：只内嵌有界的事件尾部并报告略去条数（`omittedEvents`），完整事件在子会话里。
- 完整且通过协议校验的模型延续状态单独归档，由已接受响应引用；截断、协议拒绝或保存失败不会派发脚本，也不会把不透明状态交给宿主展示。
- 协议修复重发沿用当前实测校准，对追加诊断后的完整请求重新核对预算；供应商拒绝超窗时清空校准并重组。未通过协议的响应不会执行，修复估算也服从运行取消和截止时间。
- 活动运行的 `validateContext` 以相同实测校准、工作窗口和输出预留验收候选请求，不调用模型或推进回合；无活动运行时抛 `UNAVAILABLE`，估算服从调用方与运行自身的取消。无图片的推理延续请求也提供保守校准样本，其不透明状态容量仍单独预留。
- 容量校准分别估计固定开销和正文增长，并用安全余量覆盖滚动窗口内全部实测样本；样本不足或趋势不可用时采用保守比例，校准不超过原始文本估算，也不影响精确计数、图片或不透明状态预留。
- 相邻封段过近时暂缓预测性的提前封段；实际请求超出工作窗口时仍尝试封存可回收的历史，每次组帧最多成功封段一次。本地重组后请求仍超窗才分配额外压力整理，仍无法容纳时报告容量受阻。预测余量留在宿主诊断；自动封段时模型接收阶段与实际工作集过载、停滞，显式整理在请求边界消费。
- 增量帧在逻辑历史延续且完整请求可发送时保留上次实际接受的请求前缀；预测增长保留为宿主容量诊断。完整请求超窗时先重建当前帧，再尝试退卡与封段；无可延续前缀时继续按剩余轮数规划。帧中的已交付事实与运行状态统一计入容量。
- 专项原生工具执行成功后，宿主可通过 `frames.deliveryReady` 请求进入普通完成核查，省去最终产物已受理后的模型确认轮。该决定独立记入 `execution-completion` 审计；执行失败、待处理工作、用户补充和领域核查仍阻止完成。

- 工作帧超窗时先验证 `recoveryChars` 投影，再至多四次本地试算可容纳的较大正文，保留增长余量并重建选中的投影。试算不请求模型或确认送达，字符密度只从最终完整帧学习；追加状态说明后继续核对工作窗口与模型容量。不可缩减的必需材料仍超窗时报告容量受阻。
