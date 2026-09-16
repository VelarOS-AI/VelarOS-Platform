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
// 不能发明新钩子。当前**真接线**的派发点由本文件的 `WiredSeamKindsByDispatcher` 逐条登记
// （叙述见 VelarOS-Platform 的 docs/agent/agent-mod-trunk.md）；其余 kind 只有注册面与类型，
// 注册它们会当场收到 `mod.seam-not-wired` 诊断。
import { isEmpty, isFunction, isString, optionalWhen, toNullable } from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { AgentModDiagnostic, AgentModSeamKind } from '../../types/agent.js'
import type { AgentModSeamDispatchMethodName,AgentModSeamHandler, AgentModSeamRegistration, AgentModSeamRegistrationInput, AgentModSessionLifecycleEvent, AgentModToolCallBeforeEvent, AgentModToolCallBeforeOutcome, AgentModToolResultAfterEvent, AgentModToolResultAfterOutcome, AgentModTurnContextAppendage, AgentModTurnContextAssembleEvent, AgentModTurnContextAssembleOutcome } from '../../types/mods.js'
import { createHookContext, isThenable, matchesHook, readErrorMessage, resolveHookTimeoutMs } from '../../utils/mods/seams'
import { compareStableStrings } from '../../utils/residency/determinism'

// ─── 已接线 seam 的事件/结果契约 ──────────────────────────────────────────────

const MaxSeamDiagnostics = 200




/**
 * 派发方法 → 它真正读取 handlers 的 kind（**已接线名单的唯一来源**）。
 *
 * 闭集 `AgentModSeamKinds` 是「mod 能挂哪些钩子」的类型面，本表是「今天哪些钩子真会被调用」
 * 的事实面。两者的差集不静默：{@link AgentModSeamDispatcher.register} 命中差集即记
 * `mod.seam-not-wired` 诊断，沿 `getReport().diagnostics` 回到宿主的 mod 注册表页。
 */
const WiredSeamKindsByDispatcher = {
  dispatchToolCallBefore: ['tool-call:before'],
  dispatchToolResultAfter: ['tool-result:after'],
  dispatchTurnContextAssemble: ['turn-context:assemble'],
  dispatchTurnContextAssembleAsync: ['turn-context:assemble'],
  dispatchSessionLifecycle: ['session:start', 'session:end'],
} as const satisfies Record<AgentModSeamDispatchMethodName, readonly AgentModSeamKind[]>

/** 已接线 kind 的扁平闭集（派生自 {@link WiredSeamKindsByDispatcher}，不许手写第二份）。 */
const WiredSeamKinds: ReadonlySet<AgentModSeamKind> = new Set<AgentModSeamKind>(
  Object.values(WiredSeamKindsByDispatcher).flat()
)











/**
 * Hook 派发器对外的面：mod 的钩子按事件登记在这里，主链走到各派发点时按优先级逐个调它们。
 *
 * 一个宿主一份，由 Loader 持有；状态（各事件的钩子桶、封存标记、诊断环形缓冲）全在实例内存里。
 * 注册只在 registration 阶段，`seal()` 之后再写即抛。缺省实例零钩子，所有 `dispatch*` 走空数组
 * 快路径返回空结果，主链零开销、行为逐字节不变。
 *
 * 结果面只有「拦下」和「改写入参/结果」，**没有放行字段**——被策略门拒绝的调用，任何钩子都翻不了案。
 * 单个钩子抛错或超时只记一条诊断并跳过它，绝不冒泡打断主链。实现是 `AgentModSeamDispatcher`。
 */
export interface AgentModSeamDispatcherApi {
  /** 打开 registration 阶段（解除封存），Loader 装载前调。 */
  beginRegistration(): void
  /** 封存注册面：此后再 `register` / `removeMod` 一律抛错，防运行中改钩子表。 */
  seal(): void
  /** 注册面是不是已经封存。 */
  isSealed(): boolean
  /**
   * 挂一个钩子。同一 mod 在同一事件上重复用同一个 id、或注册面已封存，都当场抛错。
   * handler 不是函数则记 `mod.seam-handler-invalid` 诊断并丢弃这次注册（不抛）。
   * 事件在闭集里但本宿主还没接派发点时照样收下，并记一条 `mod.seam-not-wired`——
   * 否则 mod 作者唯一的线索是钩子一辈子不响。同事件内按 priority 升序、同优先级按 modId/id 码元序排定。
   */
  register<TKind extends AgentModSeamKind>(input: AgentModSeamRegistrationInput<TKind>): void
  /** 摘掉某个 mod 的全部钩子（停用时用），返回摘掉的条数。注册面已封存时抛错。 */
  removeMod(modId: string): number
  /** 这个事件上有没有挂着钩子。派发点用它走快路径。 */
  has(kind: AgentModSeamKind): boolean
  /** 列出这个事件上已排序的钩子登记，顺序即将来的调用顺序；没有则返回空数组。 */
  list(kind: AgentModSeamKind): readonly AgentModSeamRegistration[]
  /** 读累积的诊断（未接线、handler 非法、抛错、超时、同步契约违规），宿主的 mod 页据此给作者反馈。 */
  listDiagnostics(): readonly AgentModDiagnostic[]
  /**
   * 工具调用前派发。第一个给出 `block` 的钩子即短路返回（拦下只减不增，无需继续折叠）；
   * `args` 沿优先级顺序逐个折叠，后一个钩子看到的是前面改过的入参。
   * 改写后的入参照样走完整的策略/校验管线。没钩子时返回空对象。
   */
  dispatchToolCallBefore(event: AgentModToolCallBeforeEvent): Promise<AgentModToolCallBeforeOutcome>
  /**
   * 工具结果派发。`result` 与 `error` 沿优先级顺序折叠，谁都没改就返回空对象（调用方据此保留原结果）。
   */
  dispatchToolResultAfter(event: AgentModToolResultAfterEvent): Promise<AgentModToolResultAfterOutcome>
  /**
   * 回合上下文组装派发（同步入口）。各钩子追加的段取并集，段 id 统一加 `<modId>.` 前缀防撞。
   * 钩子返回 Promise 视为契约违规：记一条诊断并忽略这次结果。
   */
  dispatchTurnContextAssemble(event: AgentModTurnContextAssembleEvent): AgentModTurnContextAssembleOutcome
  /**
   * 回合上下文组装的异步入口，折叠顺序与同步入口逐字一致。
   * 支持外部 command 载体的宿主（如 Desktop）必须走这条，免得为了对齐外部 Hook 在主进程用 spawnSync。
   */
  dispatchTurnContextAssembleAsync(event: AgentModTurnContextAssembleEvent): Promise<AgentModTurnContextAssembleOutcome>
  /**
   * 会话开始/结束派发，纯通知没有结果面。`blocking` 模式的钩子会被等齐，`background` 的发出去就不管。
   */
  dispatchSessionLifecycle(event: AgentModSessionLifecycleEvent): Promise<void>
}

class AgentModSeamDispatcher implements AgentModSeamDispatcherApi {
  private readonly handlers = new Map<AgentModSeamKind, AgentModSeamRegistration[]>()
  private sealed = false
  private readonly diagnostics: AgentModDiagnostic[] = []
  private readonly onDiagnostic: Nullable<(diagnostic: AgentModDiagnostic) => void>

  constructor(
    options: { onDiagnostic?: (diagnostic: AgentModDiagnostic) => void } = {}
  ) {
    this.onDiagnostic = toNullable(options.onDiagnostic)
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
        `Hook 注册面已封存：mod「${input.modId}」的 Hook「${input.id}」不能在运行阶段注册。`
      )
    }
    const bucket = this.handlers.get(input.event) ?? []
    if (bucket.some((entry) => entry.modId === input.modId && entry.id === input.id)) {
      throw new Error(
        `Hook 重复注册：mod「${input.modId}」已在 ${input.event} 上注册过「${input.id}」。`
      )
    }
    // 注册照常受理（闭集里的 kind 都是合法挂点，将来接线即生效），但「今天不会触发」这件事
    // 必须当场说出来——否则 mod 作者唯一的线索是钩子一辈子不响。
    if (!WiredSeamKinds.has(input.event)) {
      this.record({
        code: 'mod.seam-not-wired',
        message: `Hook event ${input.event} 在本宿主的运行链上还没有派发点：mod「${input.modId}」的 Hook「${input.id}」注册成功，但不会被调用。`,
        modId: input.modId,
      })
    }
    if (!isFunction(input.handler)) {
      this.record({
        code: 'mod.seam-handler-invalid',
        message: `Hook 注册被拒：mod「${input.modId}」的 Hook「${input.id}」的 handler 不是函数。`,
        modId: input.modId,
      })
      return
    }
    // 窄化后单次 cast：input.handler 已在上面用 isFunction 验证过 callable；这里的类型收窄
    // 只是把 `AgentModSeamHandler<TKind>`（对具体 TKind 具体化的事件/结果对）落到桶元素的
    // `AgentModSeamHandler`（TKind 默认为整个联合）——两者在结构上兼容，只是逆变位置 TS
    // 认定"不够重叠"（TS2352），拒绝单跳直接 cast。不是「外来数据未经校验」的双跳强转
    // （§12.5 禁绝的是那种）：分两条语句表达同一次已验证窄化，不写成链式 `as unknown as`。
    const validatedHandler: unknown = input.handler
    bucket.push({
      modId: input.modId,
      id: input.id,
      event: input.event,
      priority: input.priority ?? 100,
      matcher: input.matcher,
      mode: input.mode ?? 'blocking',
      timeoutMs: resolveHookTimeoutMs(input.timeoutMs),
      handler: validatedHandler as AgentModSeamHandler,
    })
    bucket.sort((left, right) =>
      left.priority === right.priority
        ? compareStableStrings(left.modId, right.modId) || compareStableStrings(left.id, right.id)
        : left.priority - right.priority
    )
    this.handlers.set(input.event, bucket)
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
      message: `Hook ${entry.event} 的「${entry.id}」抛出异常并被隔离：${readErrorMessage(error)}`,
      modId: entry.modId,
    })
  }

  /** 异步派发单个钩子；异常/超时被隔离成诊断（性质③）。 */
  private async invoke(
    entry: AgentModSeamRegistration,
    event: never
  ): Promise<unknown> {
    const controller = new AbortController()
    const timers = new TimerScope({ name: `AgentModHook.${entry.modId}.${entry.id}` })
    try {
      const timedOut = Symbol('hook-timeout')
      const timeout = new Promise<typeof timedOut>((resolve) => {
        // 这个计时器是被 await 的 race 的一部分，必须保持引用：否则钩子本身永不结束、
        // 事件循环里又没有别的引用中的任务时，Bun 可能让这场 race 永远挂起。
        timers.after(entry.timeoutMs, () => resolve(timedOut))
      })
      const outcome = await Promise.race([
        Promise.resolve(entry.handler(event, createHookContext(entry, controller.signal))),
        timeout,
      ])
      if (outcome === timedOut) {
        controller.abort()
        this.record({
          code: 'mod.hook-timeout',
          message: `Hook ${entry.event} 的「${entry.id}」超过 ${entry.timeoutMs}ms，已中止并隔离。`,
          modId: entry.modId,
        })
        return undefined
      }
      return outcome
    } catch (error) {
      this.recordHandlerFailure(entry, error)
      return undefined
    } finally {
      timers.dispose()
    }
  }

  /** 同步派发单个钩子；返回 thenable 视为契约违规（同步 seam 不等待）。 */
  private invokeSync(entry: AgentModSeamRegistration, event: never): unknown {
    const controller = new AbortController()
    try {
      const outcome = entry.handler(event, createHookContext(entry, controller.signal))
      if (isThenable(outcome)) {
        this.record({
          code: 'mod.seam-sync-contract-violation',
          message: `Hook ${entry.event} 是同步派发点，「${entry.id}」返回了 Promise；本次结果被忽略。`,
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
      if (!matchesHook(entry.matcher, current)) continue
      if (entry.mode === 'background') {
        void this.invoke(entry, current as never)
        continue
      }
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
      if (!matchesHook(entry.matcher, current)) continue
      if (entry.mode === 'background') {
        void this.invoke(entry, current as never)
        continue
      }
      const outcome = (await this.invoke(entry, current as never)) as
        | AgentModToolResultAfterOutcome
        | undefined
      if (!outcome) continue
      if ('result' in outcome) {
        current = { ...current, result: outcome.result }
        changed = true
      }
      if (isString(outcome.error)) {
        current = { ...current, error: outcome.error }
        changed = true
      }
    }
    if (!changed) return {}
    return {
      result: current.result,
      error: optionalWhen(isString, current.error),
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
      if (!matchesHook(entry.matcher, event)) continue
      if (entry.mode === 'background') {
        void this.invoke(entry, event as never)
        continue
      }
      const outcome = this.invokeSync(entry, event as never) as
        | AgentModTurnContextAssembleOutcome
        | undefined
      for (const item of outcome?.append ?? []) {
        append.push({ ...item, id: `${entry.modId}.${item.id}` })
      }
    }
    return !isEmpty(append) ? { append } : {}
  }

  /**
   * 回合上下文组装的异步宿主入口。
   *
   * Desktop 等支持外部 command 载体的宿主必须走此入口，避免为了对齐外部 Hook
   * 而在主进程使用 spawnSync。折叠顺序与同步入口完全一致。
   */
  public async dispatchTurnContextAssembleAsync(
    event: AgentModTurnContextAssembleEvent
  ): Promise<AgentModTurnContextAssembleOutcome> {
    const bucket = this.handlers.get('turn-context:assemble')
    if (!bucket || bucket.length === 0) return {}

    const append: AgentModTurnContextAppendage[] = []
    for (const entry of bucket) {
      if (!matchesHook(entry.matcher, event)) continue
      if (entry.mode === 'background') {
        void this.invoke(entry, event as never)
        continue
      }
      const outcome = (await this.invoke(entry, event as never)) as
        | AgentModTurnContextAssembleOutcome
        | undefined
      for (const item of outcome?.append ?? []) {
        append.push({ ...item, id: `${entry.modId}.${item.id}` })
      }
    }
    return !isEmpty(append) ? { append } : {}
  }

  /** 会话生命周期派发（纯通知，无结果面）。 */
  public async dispatchSessionLifecycle(
    event: AgentModSessionLifecycleEvent
  ): Promise<void> {
    const kind: AgentModSeamKind =
      event.phase === 'start' ? 'session:start' : 'session:end'
    const bucket = this.handlers.get(kind)
    if (!bucket || bucket.length === 0) return
    const blocking: Array<Promise<unknown>> = []
    for (const entry of bucket) {
      if (!matchesHook(entry.matcher, event)) continue
      const task = this.invoke(entry, event as never)
      if (entry.mode === 'blocking') blocking.push(task)
    }
    await Promise.all(blocking)
  }
}

/** 标准 Hook 命名；Seam 常量只作旧调用方的兼容别名。 */
const WiredHookEventsByDispatcher = WiredSeamKindsByDispatcher
const WiredHookEvents = WiredSeamKinds

export {
  AgentModSeamDispatcher as AgentModHookDispatcher,
  AgentModSeamDispatcher,
  WiredHookEvents,
  WiredHookEventsByDispatcher,
  WiredSeamKinds,
  WiredSeamKindsByDispatcher,
}
