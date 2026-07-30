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
 * 运行时提醒调度器。
 *
 * - 接收声明式生产器注册。
 * - 消费时挑选最高优先级、范围满足、条件谓词通过且渲染非空的生产器。
 * - 按范围做去重：每编辑版本以编辑版本为键；一次性提醒永久标记；始终提醒不去重。
 * - 查看与消费等价，但不更新已发标记，用于“先看再决定要不要走”的场景。
 *
 * 该调度器是每会话实例。编码会话跟踪器内部持有一个；
 * 其它编排器需要时也可以为特定能力作用域独立构造。
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
