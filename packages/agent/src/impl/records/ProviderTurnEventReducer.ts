// 域：一次 provider 生成回合的**事件归约器**（把流式事件收敛成一份可落盘、可回放的回合快照）。
//
// ## 状态机与合法迁移
// 回合只有 `pending → completed` 一条边，且**必须先 `turn-started`**：所有其它事件都过
// `assertStarted`。工具子状态机同理 `pending → succeeded | failed`，`requirePendingTool` 把
// 「没开始过」与「已收敛过」两种误用都挡在写入之前。
//
// **为什么这些是抛错而不是容错**：归约器是快照的唯一生产者，一旦允许乱序写入，产出的快照就会与真实
// 回合不一致——而快照正是事后唯一能复原「模型那一轮到底看到/做了什么」的证据。证据错了比没有更坏，
// 所以这里选 fail-fast（§2.8 运行期不变量破损立刻炸）。
//
// ## 中断路径是唯一的例外，且刻意收在一处
// 流被中止时会留下 pending 的工具调用，此时直接 `complete()` 必然抛错。`completeProviderTurnSnapshot`
// 捕获该错误、把 pending 工具标记为 failed 并记一条诊断，再重新收敛——这条降级**只在显式传入
// `interruptPendingTools` 时发生**，正常路径仍然是严格的。
// `emitCompletedProviderTurnSnapshot` 是其上的单源发射器：StreamTurn / QueryTurn 曾各抄一份逐字
// 相同的「收敛 + 发射 + 吞错」，快照 bug 绝不冒泡进回合主路这条纪律现在只有一个落地点。
//
// ## 快照是拷贝，不是视图
// `snapshot()` / `buildRequestSnapshot` / `cloneTool` 全部浅拷贝出去。读侧（观测、调试面板、账本）
// 会长期持有这些对象；返回内部引用会让归约器后续的写入把已发出的快照一起改掉。
//
import { isEmpty, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ProviderTurnEvent, ProviderTurnRequestSnapshot, ProviderTurnSnapshot, ProviderTurnStatus, ProviderTurnToolSnapshot, ProviderTurnUsage } from '../../types/records.js'
import { buildInterruptedToolsDiagnostic, buildRequestSnapshot, cloneTool } from '../../utils/records/provider-turn-event-reducer'

/** 回合中止时尚未拿到结果的工具，在快照里统一记这句；对外承诺的是「不代表工具失败」这层语义。 */
export const ProviderTurnInterruptedToolError: string = '工具执行被打断：回合中止时这次调用还没拿到结果，不代表工具本身失败。'

/** 建归约器时要交代的身份。 */
export interface ProviderTurnEventReducerOptions {
  /** 这一次 provider 生成回合的 id；快照上带着它，也是所有不变量报错里指认「是哪一轮出的问题」的那个值。 */
  turnId: string
}

/**
 * 一次 provider 生成回合的事件归约器：把流式事件收敛成一份可落盘、可回放的回合快照。
 * 回合只有 `pending → completed` 一条边，且必须先收到 `turn-started`；工具子状态机是 `pending → succeeded | failed`。
 *
 * 违反顺序一律抛 `INVARIANT` 而不是容错：快照是事后唯一能复原「模型那一轮到底看到、做了什么」的证据，
 * 错的证据比没有更坏。唯一的降级路径是流被中止后把在途工具按「被打断」收尾，且只在调用方显式要求时发生。
 * 交出去的快照全是浅拷贝，读侧可以长期持有，不会被后续写入改掉。
 */
export interface ProviderTurnEventReducerApi {
  /** 吃进一条回合事件并更新内部状态。除 `turn-started` 外都要求回合已经开始，否则抛 `INVARIANT`；重复 `turn-started`、同一个 toolCallId 重复开始、给没开始或已收敛的工具报结果，都是同样的抛错。 */
  apply(event: ProviderTurnEvent): void
  /** 收束本回合并交出快照：还有 `pending` 的工具时抛 `INVARIANT`（回合不许带着悬空工具收尾）。回合没开始过同样抛错。 */
  complete(): ProviderTurnSnapshot
  /** 当前还没拿到结果的工具调用 id；中止路径用它判断该不该走打断收尾。 */
  pendingToolCallIds(): string[]
  /** 这一回合是否已经收到过 `turn-started`。 */
  hasStarted(): boolean
  /** 这一回合是否攒下过诊断；发射器用它决定错误分支要不要发快照。 */
  hasDiagnostics(): boolean
  /** 中止路径专用：把所有 `pending` 工具按 `error` 记成 failed，补一条 `provider-turn-tools-interrupted` 诊断，再走 `complete`。`error` 是写进每个工具的失败原因，默认「工具执行被打断」那句。 */
  completeWithInterruptedPendingTools(error?: string): ProviderTurnSnapshot
  /** 取当前快照但不收束回合，随时可调；返回的是浅拷贝，工具与诊断都另起了数组。 */
  snapshot(): ProviderTurnSnapshot
}

export class ProviderTurnEventReducer implements ProviderTurnEventReducerApi {
  private status: ProviderTurnStatus = 'pending'
  private started = false
  private assistantText = ''
  private reasoningText = ''
  private request?: ProviderTurnRequestSnapshot
  private usage?: ProviderTurnUsage
  private readonly tools = new Map<string, ProviderTurnToolSnapshot>()
  private readonly diagnostics: Array<{
    code: string
    message: string
    details?: Record<string, unknown>
  }> = []

  constructor(private readonly options: ProviderTurnEventReducerOptions) {}

  public apply(event: ProviderTurnEvent): void {
    switch (event.type) {
      case 'turn-started': {
        if (this.started) {
          throw new AppError(
            'INVARIANT',
            `provider 回合 "${this.options.turnId}" 收到了第二次 turn-started。归约器的回合状态机只允许开启一次，这是事件生产方的实现缺陷，不是用户操作错误。`
          )
        }
        this.started = true
        return
      }
      case 'request': {
        this.assertStarted()
        this.request = buildRequestSnapshot(event)
        return
      }
      case 'assistant-text-delta': {
        this.assertStarted()
        this.assistantText += event.text
        return
      }
      case 'assistant-reasoning-delta': {
        this.assertStarted()
        this.reasoningText += event.text
        return
      }
      case 'tool-started': {
        this.assertStarted()
        if (this.tools.has(event.toolCallId)) {
          throw new AppError(
            'INVARIANT',
            `provider 工具调用 "${event.toolCallId}" 被重复登记为 tool-started。同一个 toolCallId 在一个回合里只能开始一次，这是事件生产方的实现缺陷，不是用户操作错误。`
          )
        }
        const tool: ProviderTurnToolSnapshot = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: 'pending',
        }
        if ('args' in event) {
          tool.args = event.args
        }
        this.tools.set(event.toolCallId, tool)
        return
      }
      case 'tool-succeeded': {
        const tool = this.requirePendingTool(event.toolCallId)
        tool.status = 'succeeded'
        tool.output = event.output
        return
      }
      case 'tool-failed': {
        const tool = this.requirePendingTool(event.toolCallId)
        tool.status = 'failed'
        tool.error = event.error
        return
      }
      case 'usage': {
        const usage: ProviderTurnUsage = {}
        if (isPresent(event.inputTokens)) {
          usage.inputTokens = event.inputTokens
        }
        if (isPresent(event.outputTokens)) {
          usage.outputTokens = event.outputTokens
        }
        if (isPresent(event.totalTokens)) {
          usage.totalTokens = event.totalTokens
        }
        this.usage = usage
        return
      }
      case 'diagnostic': {
        const diagnostic: { code: string; message: string; details?: Record<string, unknown> } = {
          code: event.code,
          message: event.message,
        }
        if (isPresent(event.details)) {
          diagnostic.details = { ...event.details }
        }
        this.diagnostics.push(diagnostic)
        return
      }
    }
  }

  public complete(): ProviderTurnSnapshot {
    this.assertStarted()

    const unsettled = [...this.tools.values()].find((tool) => tool.status === 'pending')
    if (unsettled) {
      throw new AppError(
        'INVARIANT',
        `provider 回合 "${this.options.turnId}" 要收尾，但工具调用 "${unsettled.toolCallId}" 还停在 pending。回合不许带着悬空工具收敛，否则快照会与真实回合对不上；这是调用方的实现缺陷，不是用户操作错误。中止路径应走 completeWithInterruptedPendingTools。`
      )
    }

    if (this.status === 'pending') {
      this.status = 'completed'
    }

    return this.snapshot()
  }

  public pendingToolCallIds(): string[] {
    return [...this.tools.values()]
      .filter((tool) => tool.status === 'pending')
      .map((tool) => tool.toolCallId)
  }

  public hasStarted(): boolean {
    return this.started
  }

  public hasDiagnostics(): boolean {
    return !isEmpty(this.diagnostics)
  }

  public completeWithInterruptedPendingTools(
    error: string = ProviderTurnInterruptedToolError
  ): ProviderTurnSnapshot {
    this.assertStarted()

    const pendingToolCallIds = this.pendingToolCallIds()
    if (!isEmpty(pendingToolCallIds)) {
      for (const toolCallId of pendingToolCallIds) {
        const tool = this.tools.get(toolCallId)
        if (!tool) continue

        tool.status = 'failed'
        tool.error = error
      }
      this.diagnostics.push(buildInterruptedToolsDiagnostic(pendingToolCallIds))
    }

    return this.complete()
  }

  public snapshot(): ProviderTurnSnapshot {
    const snapshot: ProviderTurnSnapshot = {
      turnId: this.options.turnId,
      status: this.status,
      assistantText: this.assistantText,
      reasoningText: this.reasoningText,
      tools: [...this.tools.values()].map(cloneTool),
      diagnostics: this.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    }
    if (isPresent(this.request)) {
      snapshot.request = buildRequestSnapshot(this.request)
    }
    if (isPresent(this.usage)) {
      snapshot.usage = { ...this.usage }
    }
    return snapshot
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new AppError(
        'INVARIANT',
        `provider 回合 "${this.options.turnId}" 还没收到 turn-started 就被写入或收尾。除 turn-started 外的事件都必须排在回合开始之后，这是事件生产方的实现缺陷，不是用户操作错误。`
      )
    }
  }

  private requirePendingTool(toolCallId: string): ProviderTurnToolSnapshot {
    this.assertStarted()
    const tool = this.tools.get(toolCallId)
    if (!tool) {
      throw new AppError(
        'INVARIANT',
        `provider 工具调用 "${toolCallId}" 没有对应的 tool-started 就报了结果。工具子状态机必须从 pending 起步，这是事件生产方的实现缺陷，不是用户操作错误。`
      )
    }
    if (tool.status !== 'pending') {
      throw new AppError(
        'INVARIANT',
        `provider 工具调用 "${toolCallId}" 已经收敛过（当前 ${tool.status}），不能再报一次结果。工具子状态机只允许 pending → succeeded | failed 收敛一次，这是事件生产方的实现缺陷，不是用户操作错误。`
      )
    }
    return tool
  }
}

