import { isNull, toNullable } from '@velaros-ai/core'

import type {
  ReminderScope,
  ReminderTrigger,
  RuntimeReminderInput,
  RuntimeReminderProducer,
} from './types'

/** consume 命中 producer 时的元信息，便于调用方同步 CodingSessionTracker 等旁路状态。 */
export interface RuntimeReminderConsumeResult {
  producerId: string
  text: string
}

/**
 * 运行时提醒调度器：**每触发点最多注入一条**提醒的仲裁者。
 *
 * ## 为什么是「选一条」而不是「全发」
 * 提醒是插进模型上下文的软指令。一次塞多条会互相冲突（"先去验证" vs "先去检查改动"），模型只会挑一条
 * 执行、另一条变成纯 token 浪费；更糟的是它们每轮都可能重新命中，累积成噪音。所以调度器按 priority
 * 取**第一条**可注入的就返回。新增 producer 时要问的是「它该排在谁前面」，不是「它该不该发」。
 *
 * ## 生命周期：scope 决定一条提醒能发几次
 *  - `one-shot`：整个会话一次；
 *  - `per-edit-version`：每批新编辑一次（`editVersion` 变化即自动解锁，不需要谁去 reset）；
 *  - `always`：不去重（`resolveScopeKey` 返回 null）。
 * **`peek` 与 `consume` 必须走同一条选择逻辑**（`selectCandidate`），只在标不标「已发」上分叉——两条
 * 各写一份判定，会长出「peek 说有、consume 拿到 null」这种没人能复现的偏差。
 *
 * ## 与 tracker 旁路状态的关系
 * scope 去重只管本调度器自己的账；调用方还有 `reminderIssuedForCurrentEdits` 一类旁路标记，靠
 * `finalizeReminderConsumeResult(producerId)` 同步。**consume 成功后必须调它**，否则两套账会漂移。
 *
 * 每会话一实例；生命周期跟着会话走，不跨会话共享（`issued` 是会话内的已发账）。
 */
export class RuntimeReminderScheduler {
  private readonly producers = new Map<string, RuntimeReminderProducer>()
  /** producer id -> 已发 key 集合；key 由 scope 派生（version 号 / 'one-shot'）。 */
  private readonly issued = new Map<string, Set<string>>()

  constructor(initialProducers: readonly RuntimeReminderProducer[] = []) {
    initialProducers.forEach((producer) => this.register(producer))
  }

  /** 注册或覆盖一个 producer。 */
  public register(producer: RuntimeReminderProducer): void {
    this.producers.set(producer.id, producer)
  }

  /** 注销一个 producer；少用，主要用于测试。 */
  public unregister(producerId: string): void {
    this.producers.delete(producerId)
    this.issued.delete(producerId)
  }

  /** 找到首个匹配的 producer 并返回渲染文本与 producerId；按 scope 标记已发。 */
  public consume(trigger: ReminderTrigger, input: RuntimeReminderInput): Nullable<RuntimeReminderConsumeResult> {
    const candidate = this.selectCandidate(trigger, input)
    if (!candidate) return null

    this.markIssued(candidate.producer, candidate.scopeKey)
    return { producerId: candidate.producer.id, text: candidate.text }
  }

  /**
   * 针对单个 producer 消费，主要用于"我知道我要哪条"的兼容入口。
   * 仍然走 scope/when/render 完整流程；触发器集合不限。
   */
  public consumeProducer(producerId: string, input: RuntimeReminderInput): Nullable<string> {
    const producer = this.producers.get(producerId)
    if (!producer) return null

    const candidate = this.evaluateProducer(producer, input)
    if (!candidate) return null

    this.markIssued(producer, candidate.scopeKey)
    return candidate.text
  }

  /** 不标记已发，仅返回当前是否有匹配；用于"先看再决定"。 */
  public peek(trigger: ReminderTrigger, input: RuntimeReminderInput): Nullable<string> {
    return toNullable(this.selectCandidate(trigger, input)?.text)
  }

  /** 与 consume 相同的选择逻辑，但不标记已发；返回 producerId 供调用方比对。 */
  public peekWithProducer(trigger: ReminderTrigger, input: RuntimeReminderInput): Nullable<RuntimeReminderConsumeResult> {
    const candidate = this.selectCandidate(trigger, input)
    if (!candidate) return null

    return { producerId: candidate.producer.id, text: candidate.text }
  }

  /** 重置某个 producer 的已发标记，让它下一次可以再次触发。 */
  public resetScope(producerId: string): void {
    this.issued.delete(producerId)
  }

  /** 调试用：列出所有已注册 producer id 与触发器。 */
  public listRegisteredProducers(): Array<{ id: string; triggers: readonly ReminderTrigger[] }> {
    return [...this.producers.values()].map((producer) => ({
      id: producer.id,
      triggers: producer.triggers,
    }))
  }

  /** 内部：选出排在最前的匹配 producer 并组装上下文。 */
  private selectCandidate(
    trigger: ReminderTrigger,
    input: RuntimeReminderInput
  ): Nullable<{ producer: RuntimeReminderProducer; scopeKey: Nullable<string>; text: string }> {
    const matched = [...this.producers.values()]
      .filter((producer) => producer.triggers.includes(trigger))
      .sort((left, right) => left.priority - right.priority)

    for (const producer of matched) {
      const evaluation = this.evaluateProducer(producer, input)
      if (evaluation) return { producer, ...evaluation }
    }

    return null
  }

  /** 评估单个 producer 是否可注入。 */
  private evaluateProducer(
    producer: RuntimeReminderProducer,
    input: RuntimeReminderInput
  ): Nullable<{ scopeKey: Nullable<string>; text: string }> {
    const scopeKey = this.resolveScopeKey(producer.scope, input)
    if (this.hasIssued(producer.id, scopeKey)) return null

    if (!producer.when(input)) return null

    const text = producer.render(input)?.trim()
    if (!text) return null

    return { scopeKey, text }
  }

  /**
   * scope → 去重键。`null` = **本 scope 不参与去重**（`always`：每次匹配都重新渲染）。
   *
   * 曾用 `floating:${Math.random()}` 前缀把「不去重」编码进字符串、再靠 `startsWith` 嗅回来——
   * 控制流藏在字符串里，且给一个纯判定函数塞了随机源（§3.4 纯函数优先）。现在语义直接进类型。
   */
  private resolveScopeKey(scope: ReminderScope, input: RuntimeReminderInput): Nullable<string> {
    switch (scope) {
      case 'one-shot':
        return 'one-shot'
      case 'per-edit-version':
        return `edit-version:${input.editVersion}`
      case 'always':
      default:
        return null
    }
  }

  private hasIssued(producerId: string, scopeKey: Nullable<string>): boolean {
    if (isNull(scopeKey)) return false

    return !!this.issued.get(producerId)?.has(scopeKey)
  }

  private markIssued(producer: RuntimeReminderProducer, scopeKey: Nullable<string>): void {
    if (isNull(scopeKey)) return

    let bucket = this.issued.get(producer.id)
    if (!bucket) {
      bucket = new Set<string>()
      this.issued.set(producer.id, bucket)
    }

    bucket.add(scopeKey)
  }
}
