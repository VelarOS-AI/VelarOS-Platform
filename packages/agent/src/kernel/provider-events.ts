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
import { isEmpty,isPresent, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
export type ProviderTurnStatus = 'pending' | 'completed'
export type ProviderTurnToolStatus = 'pending' | 'succeeded' | 'failed'

export const ProviderTurnInterruptedToolError = 'Tool execution interrupted'

export interface ProviderTurnUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

/**
 * Ring 0 出核请求指纹（`assertProviderRequestInvariants` 同层地板产物）。
 * 定义住 kernel 层:请求事件/快照与观测域都以它为契约,agent 层编译器只是生产者。
 */
export interface ProviderRequestFingerprint {
  id: string
  systemHash: string
  toolSurfaceHash: string
  prefixHash: string
  toolSchemaCharsTotal: number
  messageCount: number
  roleSequence: string[]
  availableToolNames: string[]
  historyToolNames: string[]
  missingHistoryToolNames: string[]
  toolChoiceName: Nullable<string>
  toolChoiceVisible: Nullable<boolean>
  contextRefCount: number
  historyToolCallIds: string[]
  historyToolResultIds: string[]
}

export interface ProviderTurnRequestSnapshot {
  availableToolNames: string[]
  toolChoiceName: Nullable<string>
  requestFingerprint?: ProviderRequestFingerprint
  toolSchemaChars?: Record<string, number>
  toolSchemaHashes?: Record<string, string>
  contextUsage?: {
    estimatedTokens: number
    tokenPercent: number
    usableContextWindow: number
  }
}

export type ProviderTurnEvent =
  | { type: 'turn-started' }
  | {
      type: 'request'
      availableToolNames: string[]
      toolChoiceName?: LooseOptional<string>
      requestFingerprint?: ProviderRequestFingerprint
      toolSchemaChars?: Record<string, number>
      toolSchemaHashes?: Record<string, string>
      contextUsage?: ProviderTurnRequestSnapshot['contextUsage']
    }
  | { type: 'assistant-text-delta'; text: string }
  | { type: 'assistant-reasoning-delta'; text: string }
  | { type: 'tool-started'; toolCallId: string; toolName: string; args?: unknown }
  | { type: 'tool-succeeded'; toolCallId: string; output: unknown }
  | { type: 'tool-failed'; toolCallId: string; error: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; totalTokens?: number }
  | { type: 'diagnostic'; code: string; message: string; details?: Record<string, unknown> }

export interface ProviderTurnToolSnapshot {
  toolCallId: string
  toolName: string
  status: ProviderTurnToolStatus
  args?: unknown
  output?: unknown
  error?: string
}

export interface ProviderTurnSnapshot {
  turnId: string
  status: ProviderTurnStatus
  assistantText: string
  reasoningText: string
  request?: ProviderTurnRequestSnapshot
  tools: ProviderTurnToolSnapshot[]
  diagnostics: Array<{ code: string; message: string; details?: Record<string, unknown> }>
  usage?: ProviderTurnUsage
}

export interface ProviderTurnEventReducerOptions {
  turnId: string
}

export interface CompleteProviderTurnSnapshotOptions {
  interruptPendingTools?: boolean
  interruptedToolError?: string
}

export interface CompleteProviderTurnSnapshotResult {
  snapshot: ProviderTurnSnapshot
  interruptedToolCallIds: string[]
}

function cloneTool(tool: ProviderTurnToolSnapshot): ProviderTurnToolSnapshot {
  return { ...tool }
}

/**
 * 请求快照的**唯一构造器**（事件入账与快照外发共用）。
 *
 * 全部可选字段一律浅拷贝而非引用透传：快照要在回合收敛后仍可被读侧安全持有，
 * 引用透传会让调用方后续改自己的对象时把已发出的快照一起改掉。
 * 出核统一 `Nullable`（`toNullable`），入参两种缺席形态都收——归一只在这一处发生（§1.5）。
 */
function buildRequestSnapshot(source: {
  availableToolNames: readonly string[]
  toolChoiceName?: LooseOptional<string>
  requestFingerprint?: ProviderRequestFingerprint
  toolSchemaChars?: Record<string, number>
  toolSchemaHashes?: Record<string, string>
  contextUsage?: ProviderTurnRequestSnapshot['contextUsage']
}): ProviderTurnRequestSnapshot {
  const snapshot: ProviderTurnRequestSnapshot = {
    availableToolNames: [...source.availableToolNames],
    toolChoiceName: toNullable(source.toolChoiceName),
  }
  if (source.requestFingerprint) snapshot.requestFingerprint = { ...source.requestFingerprint }
  if (source.toolSchemaChars) snapshot.toolSchemaChars = { ...source.toolSchemaChars }
  if (source.toolSchemaHashes) snapshot.toolSchemaHashes = { ...source.toolSchemaHashes }
  if (source.contextUsage) snapshot.contextUsage = { ...source.contextUsage }
  return snapshot
}

function buildInterruptedToolsDiagnostic(
  toolCallIds: string[]
): { code: string; message: string; details?: Record<string, unknown> } {
  return {
    code: 'provider-turn-tools-interrupted',
    message: `Interrupted ${toolCallIds.length} pending provider tool call${toolCallIds.length === 1 ? '' : 's'}.`,
    details: { toolCallIds },
  }
}

export class ProviderTurnEventReducer {
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
          throw new AppError('INVARIANT', `Provider turn "${this.options.turnId}" has already started`)
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
          throw new AppError('INVARIANT', `Provider turn tool call "${event.toolCallId}" already exists`)
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
      throw new AppError('INVARIANT', 
        `Provider turn "${this.options.turnId}" has unsettled tool call "${unsettled.toolCallId}"`
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
      throw new AppError('INVARIANT', `Provider turn "${this.options.turnId}" has not started`)
    }
  }

  private requirePendingTool(toolCallId: string): ProviderTurnToolSnapshot {
    this.assertStarted()
    const tool = this.tools.get(toolCallId)
    if (!tool) {
      throw new AppError('INVARIANT', `Provider turn tool call "${toolCallId}" was not started`)
    }
    if (tool.status !== 'pending') {
      throw new AppError('INVARIANT', `Provider turn tool call "${toolCallId}" is already settled`)
    }
    return tool
  }
}

export function completeProviderTurnSnapshot(
  reducer: ProviderTurnEventReducer,
  options: CompleteProviderTurnSnapshotOptions = {}
): CompleteProviderTurnSnapshotResult {
  try {
    return {
      snapshot: reducer.complete(),
      interruptedToolCallIds: [],
    }
  } catch (error) {
    const interruptedToolCallIds = reducer.pendingToolCallIds()
    if (!options.interruptPendingTools || isEmpty(interruptedToolCallIds)) {
      throw error
    }

    return {
      snapshot: reducer.completeWithInterruptedPendingTools(options.interruptedToolError),
      interruptedToolCallIds,
    }
  }
}

export interface EmitCompletedProviderTurnSnapshotInput {
  reducer: LooseOptional<ProviderTurnEventReducer>
  onSnapshot: LooseOptional<(snapshot: ProviderTurnSnapshot) => void>
  /**
   * 仅当回合有未收敛工具或诊断时才发（错误/中止分支用）；缺省无条件发（正常收敛分支用）。
   */
  requirePendingTools?: boolean
  /** 调用方的作用域日志（StreamTurn / QueryTurn 各带自己的 tag）。 */
  log: ProviderTurnSnapshotLog
}

interface ProviderTurnSnapshotLog {
  warn(message: string, data?: Record<string, unknown>): void
}

/**
 * provider 回合快照的**单源发射器**：把 reducer 收敛成 {@link ProviderTurnSnapshot} 并交给 onSnapshot。
 * 此前 StreamTurn / QueryTurn 各抄一份逐字相同的收敛+发射+吞错逻辑（三胞胎之二），此处收口——
 * pending-tools 中断诊断与快照失败隔离（快照 bug 绝不冒泡进回合主路）一处表达，连告警文案也收敛为
 * 单源。返回是否真的发出了快照。
 */
export function emitCompletedProviderTurnSnapshot(
  input: EmitCompletedProviderTurnSnapshotInput
): boolean {
  const { reducer, onSnapshot, log } = input
  if (!reducer || !onSnapshot) return false
  if (
    input.requirePendingTools &&
    isEmpty(reducer.pendingToolCallIds()) &&
    !reducer.hasDiagnostics()
  )
    return false

  try {
    const completion = completeProviderTurnSnapshot(reducer, { interruptPendingTools: true })
    if (!isEmpty(completion.interruptedToolCallIds)) {
      log.warn('provider turn snapshot interrupted pending tools', {
        toolCallIds: completion.interruptedToolCallIds,
      })
    }
    onSnapshot(completion.snapshot)
    return true
  } catch (error) {
    log.warn('provider turn snapshot completion failed', { error: AppError.getMessage(error) })
    return false
  }
}
