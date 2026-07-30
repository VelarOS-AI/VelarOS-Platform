// 域：拦截 seam 派发器（裁决 9 机制②——「改变运行时行为」的贡献面）。
//
// 三条不可协商的性质：
//  ① **两阶段**：注册只发生在 registration 阶段；`seal()` 之后写入即抛（防运行中改注册表）。
//  ② **权限不可旁路**：钩子结果面只有「拦下」和「改写入参/结果」，**没有放行字段**——
//     被策略门拒绝的调用，任何钩子都无法把它变成允许；入参改写发生在策略门**之前**，
//     改写后的入参照样走完整策略/校验管线。
//  ③ **异常隔离**：单个钩子抛错只记诊断并跳过该钩子，绝不冒泡打断主链。
//
// 闭集在 `@velaros-ai/agent/protocol` 的 mods 契约（`AgentModSeamKinds`）——mod 只能挂接，
// 不能发明新钩子。当前**真接线**的派发点见 docs/agent-mod-trunk.md；其余 kind 只有注册面与类型。
import { compareStableStrings } from '../agent/context/residency/determinism'
import type { AgentModDiagnostic, AgentModSeamKind } from '../protocol'

// ─── 已接线 seam 的事件/结果契约 ──────────────────────────────────────────────

/** 工具调用前（策略门之前）。 */
interface AgentModToolCallBeforeEvent {
  readonly toolCallId: string
  readonly toolName: string
  readonly args: Readonly<Record<string, unknown>>
  readonly sessionId: Nullable<string>
}

/**
 * 工具调用前结果。
 *
 * `block` 只能**减少**可执行面；没有任何「允许」语义的字段（性质②）。
 * `args` 改写后仍要过完整策略门与参数校验。
 */
interface AgentModToolCallBeforeOutcome {
  block?: { reason: string }
  args?: Record<string, unknown>
}

/** 工具结果收敛后（结果已产生，尚未交回调用方）。 */
interface AgentModToolResultAfterEvent {
  readonly toolCallId: string
  readonly toolName: string
  readonly args: Readonly<Record<string, unknown>>
  readonly result: unknown
  readonly error: Nullable<string>
  readonly sessionId: Nullable<string>
}

interface AgentModToolResultAfterOutcome {
  result?: unknown
  error?: string
}

/** 回合上下文组装：段已排序、预算裁剪之前。 */
interface AgentModTurnContextSegmentView {
  readonly id: string
  readonly stability: 'stable' | 'dynamic'
  readonly source: string
  readonly priority: number
}

interface AgentModTurnContextAssembleEvent {
  readonly stableSegments: readonly AgentModTurnContextSegmentView[]
  readonly dynamicSegments: readonly AgentModTurnContextSegmentView[]
}

/** 追加的动态段；与内置段同样计入预算裁剪（不得绕过治理预算）。 */
interface AgentModTurnContextAppendage {
  id: string
  text: string
  label?: string
  priority?: number
}

interface AgentModTurnContextAssembleOutcome {
  append?: readonly AgentModTurnContextAppendage[]
}

/** 会话生命周期（托管执行的进入/离开）。 */
interface AgentModSessionLifecycleEvent {
  readonly phase: 'start' | 'end'
  readonly executionId: Nullable<string>
  readonly sessionId: Nullable<string>
  readonly status: Nullable<string>
}

interface AgentModSeamGenericEvent {
  readonly payload: unknown
}

interface AgentModSeamEventMap {
  'session:start': AgentModSessionLifecycleEvent
  'session:end': AgentModSessionLifecycleEvent
  'turn:start': AgentModSeamGenericEvent
  'turn:end': AgentModSeamGenericEvent
  'turn-context:assemble': AgentModTurnContextAssembleEvent
  'prompt:compose': AgentModSeamGenericEvent
  'tool-call:before': AgentModToolCallBeforeEvent
  'tool-call:after': AgentModSeamGenericEvent
  'tool-result:after': AgentModToolResultAfterEvent
  'model-request:before': AgentModSeamGenericEvent
  'model-response:after': AgentModSeamGenericEvent
  'sub-agent:dispatch': AgentModSeamGenericEvent
  'compaction:before': AgentModSeamGenericEvent
  'skill:select': AgentModSeamGenericEvent
  'diagnostic:publish': AgentModSeamGenericEvent
}

interface AgentModSeamOutcomeMap {
  'session:start': void
  'session:end': void
  'turn:start': void
  'turn:end': void
  'turn-context:assemble': AgentModTurnContextAssembleOutcome
  'prompt:compose': void
  'tool-call:before': AgentModToolCallBeforeOutcome
  'tool-call:after': void
  'tool-result:after': AgentModToolResultAfterOutcome
  'model-request:before': void
  'model-response:after': void
  'sub-agent:dispatch': void
  'compaction:before': void
  'skill:select': void
  'diagnostic:publish': void
}

type AgentModSeamHandler<TKind extends AgentModSeamKind = AgentModSeamKind> = (
  event: AgentModSeamEventMap[TKind]
) =>
  | AgentModSeamOutcomeMap[TKind]
  | void
  | Promise<AgentModSeamOutcomeMap[TKind] | void>

interface AgentModSeamRegistrationInput<
  TKind extends AgentModSeamKind = AgentModSeamKind,
> {
  readonly modId: string
  readonly id: string
  readonly seam: TKind
  readonly priority?: number
  readonly handler: AgentModSeamHandler<TKind>
}

interface AgentModSeamRegistration {
  readonly modId: string
  readonly id: string
  readonly seam: AgentModSeamKind
  readonly priority: number
  readonly handler: AgentModSeamHandler
}

const MaxSeamDiagnostics = 200

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'then') === 'function'
  )
}

/**
 * seam 派发器。
 *
 * 缺省实例零钩子——所有 `dispatch*` 走空数组快路径返回空结果，主链零开销、行为逐字节不变。
 */
class AgentModSeamDispatcher {
  private readonly handlers = new Map<AgentModSeamKind, AgentModSeamRegistration[]>()
  private sealed = false
  private readonly diagnostics: AgentModDiagnostic[] = []
  private readonly onDiagnostic: Nullable<(diagnostic: AgentModDiagnostic) => void>

  constructor(
    options: { onDiagnostic?: (diagnostic: AgentModDiagnostic) => void } = {}
  ) {
    this.onDiagnostic = options.onDiagnostic ?? null
  }

  /** 打开 registration 阶段（Loader 装载前调用）。 */
  public beginRegistration(): void {
    this.sealed = false
  }

  /** 关闭 registration 阶段；此后写入即抛（性质①）。 */
  public seal(): void {
    this.sealed = true
  }

  public isSealed(): boolean {
    return this.sealed
  }

  public register<TKind extends AgentModSeamKind>(
    input: AgentModSeamRegistrationInput<TKind>
  ): void {
    if (this.sealed) {
      throw new Error(
        `seam 注册面已封存：mod「${input.modId}」的钩子「${input.id}」不能在运行阶段注册。`
      )
    }
    const bucket = this.handlers.get(input.seam) ?? []
    if (bucket.some((entry) => entry.modId === input.modId && entry.id === input.id)) {
      throw new Error(
        `seam 钩子重复注册：mod「${input.modId}」已在 ${input.seam} 上注册过「${input.id}」。`
      )
    }
    bucket.push({
      modId: input.modId,
      id: input.id,
      seam: input.seam,
      priority: input.priority ?? 100,
      handler: input.handler as unknown as AgentModSeamHandler,
    })
    bucket.sort((left, right) =>
      left.priority === right.priority
        ? compareStableStrings(left.id, right.id)
        : left.priority - right.priority
    )
    this.handlers.set(input.seam, bucket)
  }

  /** 摘除某 mod 的全部钩子（deactivate 用）。 */
  public removeMod(modId: string): number {
    if (this.sealed) {
      throw new Error(`seam 注册面已封存：不能在运行阶段摘除 mod「${modId}」的钩子。`)
    }
    let removed = 0
    for (const [kind, bucket] of this.handlers) {
      const next = bucket.filter((entry) => entry.modId !== modId)
      removed += bucket.length - next.length
      this.handlers.set(kind, next)
    }
    return removed
  }

  public has(kind: AgentModSeamKind): boolean {
    return (this.handlers.get(kind)?.length ?? 0) > 0
  }

  public list(kind: AgentModSeamKind): readonly AgentModSeamRegistration[] {
    return this.handlers.get(kind) ?? []
  }

  public listDiagnostics(): readonly AgentModDiagnostic[] {
    return this.diagnostics
  }

  private record(diagnostic: AgentModDiagnostic): void {
    this.diagnostics.push(diagnostic)
    if (this.diagnostics.length > MaxSeamDiagnostics) this.diagnostics.shift()
    this.onDiagnostic?.(diagnostic)
  }

  private recordHandlerFailure(
    entry: AgentModSeamRegistration,
    error: unknown
  ): void {
    this.record({
      code: 'mod.seam-handler-failed',
      message: `seam ${entry.seam} 的钩子「${entry.id}」抛出异常并被隔离：${readErrorMessage(error)}`,
      modId: entry.modId,
    })
  }

  /** 异步派发单个钩子；异常被隔离成诊断（性质③）。 */
  private async invoke(
    entry: AgentModSeamRegistration,
    event: never
  ): Promise<unknown> {
    try {
      return await entry.handler(event)
    } catch (error) {
      this.recordHandlerFailure(entry, error)
      return undefined
    }
  }

  /** 同步派发单个钩子；返回 thenable 视为契约违规（同步 seam 不等待）。 */
  private invokeSync(entry: AgentModSeamRegistration, event: never): unknown {
    try {
      const outcome = entry.handler(event)
      if (isThenable(outcome)) {
        this.record({
          code: 'mod.seam-sync-contract-violation',
          message: `seam ${entry.seam} 是同步派发点，钩子「${entry.id}」返回了 Promise；本次结果被忽略。`,
          modId: entry.modId,
        })
        return undefined
      }
      return outcome
    } catch (error) {
      this.recordHandlerFailure(entry, error)
      return undefined
    }
  }

  /**
   * 工具调用前派发。
   *
   * 第一个给出 `block` 的钩子即短路（拦下只减不增，无需继续折叠）；`args` 沿优先级顺序折叠。
   */
  public async dispatchToolCallBefore(
    event: AgentModToolCallBeforeEvent
  ): Promise<AgentModToolCallBeforeOutcome> {
    const bucket = this.handlers.get('tool-call:before')
    if (!bucket || bucket.length === 0) return {}

    let args: Record<string, unknown> | undefined
    for (const entry of bucket) {
      const current: AgentModToolCallBeforeEvent = args
        ? { ...event, args }
        : event
      const outcome = (await this.invoke(entry, current as never)) as
        | AgentModToolCallBeforeOutcome
        | undefined
      if (!outcome) continue
      if (outcome.block) return { block: { reason: outcome.block.reason }, args }
      if (outcome.args) args = { ...outcome.args }
    }
    return args ? { args } : {}
  }

  /** 工具结果派发；`result`/`error` 沿优先级顺序折叠。 */
  public async dispatchToolResultAfter(
    event: AgentModToolResultAfterEvent
  ): Promise<AgentModToolResultAfterOutcome> {
    const bucket = this.handlers.get('tool-result:after')
    if (!bucket || bucket.length === 0) return {}

    let current = event
    let changed = false
    for (const entry of bucket) {
      const outcome = (await this.invoke(entry, current as never)) as
        | AgentModToolResultAfterOutcome
        | undefined
      if (!outcome) continue
      if ('result' in outcome) {
        current = { ...current, result: outcome.result }
        changed = true
      }
      if (typeof outcome.error === 'string') {
        current = { ...current, error: outcome.error }
        changed = true
      }
    }
    if (!changed) return {}
    return {
      result: current.result,
      ...(typeof current.error === 'string' ? { error: current.error } : {}),
    }
  }

  /** 回合上下文组装派发（同步）；各钩子追加的段并集返回。 */
  public dispatchTurnContextAssemble(
    event: AgentModTurnContextAssembleEvent
  ): AgentModTurnContextAssembleOutcome {
    const bucket = this.handlers.get('turn-context:assemble')
    if (!bucket || bucket.length === 0) return {}

    const append: AgentModTurnContextAppendage[] = []
    for (const entry of bucket) {
      const outcome = this.invokeSync(entry, event as never) as
        | AgentModTurnContextAssembleOutcome
        | undefined
      for (const item of outcome?.append ?? []) {
        append.push({ ...item, id: `${entry.modId}.${item.id}` })
      }
    }
    return append.length > 0 ? { append } : {}
  }

  /** 会话生命周期派发（纯通知，无结果面）。 */
  public async dispatchSessionLifecycle(
    event: AgentModSessionLifecycleEvent
  ): Promise<void> {
    const kind: AgentModSeamKind =
      event.phase === 'start' ? 'session:start' : 'session:end'
    const bucket = this.handlers.get(kind)
    if (!bucket || bucket.length === 0) return
    for (const entry of bucket) {
      await this.invoke(entry, event as never)
    }
  }
}

export { AgentModSeamDispatcher }
export type {
  AgentModSeamEventMap,
  AgentModSeamGenericEvent,
  AgentModSeamHandler,
  AgentModSeamOutcomeMap,
  AgentModSeamRegistration,
  AgentModSeamRegistrationInput,
  AgentModSessionLifecycleEvent,
  AgentModToolCallBeforeEvent,
  AgentModToolCallBeforeOutcome,
  AgentModToolResultAfterEvent,
  AgentModToolResultAfterOutcome,
  AgentModTurnContextAppendage,
  AgentModTurnContextAssembleEvent,
  AgentModTurnContextAssembleOutcome,
  AgentModTurnContextSegmentView,
}
