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

function cloneRequest(request: ProviderTurnRequestSnapshot): ProviderTurnRequestSnapshot {
  const snapshot: ProviderTurnRequestSnapshot = {
    availableToolNames: [...request.availableToolNames],
    toolChoiceName: toNullable(request.toolChoiceName),
  }
  if (request.requestFingerprint) {
    snapshot.requestFingerprint = { ...request.requestFingerprint }
  }
  if (request.toolSchemaChars) {
    snapshot.toolSchemaChars = { ...request.toolSchemaChars }
  }
  if (request.toolSchemaHashes) {
    snapshot.toolSchemaHashes = { ...request.toolSchemaHashes }
  }
  if (request.contextUsage) {
    snapshot.contextUsage = { ...request.contextUsage }
  }
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
        this.request = {
          availableToolNames: [...event.availableToolNames],
          toolChoiceName: toNullable(event.toolChoiceName),
        }
        if (event.requestFingerprint) {
          this.request.requestFingerprint = { ...event.requestFingerprint }
        }
        if (event.toolSchemaChars) {
          this.request.toolSchemaChars = { ...event.toolSchemaChars }
        }
        if (event.toolSchemaHashes) {
          this.request.toolSchemaHashes = { ...event.toolSchemaHashes }
        }
        if (event.contextUsage) {
          this.request.contextUsage = { ...event.contextUsage }
        }
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
      snapshot.request = cloneRequest(this.request)
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
