import { isNull, toNullable } from '@velaros-ai/core'

import type { RuntimeReminderProducer } from '../../contract/requires.js'
import type { ReminderTrigger, RuntimeReminderConsumeResult,RuntimeReminderInput } from '../../types/session.js'
import { resolveReminderScopeKey } from '../../utils/session/reminder-scope'

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
export interface RuntimeReminderSchedulerApi {
  /** 注册一个 producer；同 id 覆盖旧的。宿主装配时把本产品的全套提醒一次性灌进来。 */
  register(producer: RuntimeReminderProducer): void
  /** 摘掉一个 producer 并清掉它的已发账；主要给测试用，产品运行期一般不摘。 */
  unregister(producerId: string): void
  /**
   * 在某个触发点取一条提醒并**标记已发**：按 priority 选第一条可注入的，返回 producerId 与渲染文本。
   *
   * 每个触发点最多出一条（理由见类说明）；没有可发的返回 null。拿到结果后调用方必须回头调
   * `finalizeReminderConsumeResult`，否则跟踪器那边的旁路标记会和这里的已发账漂移。
   */
  consume(
    trigger: ReminderTrigger,
    input: RuntimeReminderInput
  ): Nullable<RuntimeReminderConsumeResult>
  /**
   * 指名消费某个 producer（「我知道我要哪条」的兼容入口），不挑触发点，其余流程与 `consume` 一致。
   *
   * producer 不存在、scope 判定为已发过、`when` 不成立或渲染为空时返回 null。
   */
  consumeProducer(producerId: string, input: RuntimeReminderInput): Nullable<string>
  /** 只看这个触发点此刻有没有可发的提醒，**不标已发**；用于「先看再决定要不要真发」。 */
  peek(trigger: ReminderTrigger, input: RuntimeReminderInput): Nullable<string>
  /** 同 `peek`，但连 producerId 一起返回，供调用方比对是不是它关心的那一条。 */
  peekWithProducer(
    trigger: ReminderTrigger,
    input: RuntimeReminderInput
  ): Nullable<RuntimeReminderConsumeResult>
  /** 清掉某个 producer 的已发账，让它下次重新可发；`one-shot` 的提醒要再发一次只能走这条。 */
  resetScope(producerId: string): void
  /** 列出已注册的全部 producer 及其触发点；调试与自检用，不参与选择逻辑。 */
  listRegisteredProducers(): Array<{ id: string; triggers: readonly ReminderTrigger[] }>
}

export class RuntimeReminderScheduler implements RuntimeReminderSchedulerApi {
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
    const scopeKey = resolveReminderScopeKey(producer.scope, input)
    if (this.hasIssued(producer.id, scopeKey)) return null

    if (!producer.when(input)) return null

    const text = producer.render(input)?.trim()
    if (!text) return null

    return { scopeKey, text }
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
