import { isArray, isFalse, isNotUndefined, isNumber, isPresent, isRecord, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { AgentWorkflowAgentResult, AgentWorkflowPredicate, AgentWorkflowValuePath } from '../../types/agent.js'
import { compareStableStrings } from '../residency/determinism'

export const Utf8ByteCounter = new TextEncoder()

export const MaxWorkflowValueBytes = 32 * 1024

/**
 * 有界深拷贝：解释器**每一次跨步骤传值都经过这里**，包括步骤输出、管线条目、调用输入与种子值。
 *
 * 两件事一起做，缺一不可：**通过 `JSON` 往返序列化**把值收敛成纯数据，切断原型、闭包和引用共享；
 * 后续步骤必须拿到快照，否则归并器修改一处会回溯改掉上游步骤已记录的输出。
 * **字节上限**挡住"一个 step 返回 10MB 把后续全部撑爆"。字节数按 UTF-8 计而非 `.length`：
 * 中文 `JSON` 的字符数只有字节数的三分之一，按字符限制等于实际放宽三倍。
 */
export function boundedClone<T>(value: T, label: string): T {
  const serialized = JSON.stringify(value)
  if (isUndefined(serialized)) throw new AppError('VALIDATION', `${label} 不是可序列化 JSON。`)
  if (Utf8ByteCounter.encode(serialized).byteLength > MaxWorkflowValueBytes) {
    throw new AppError('VALIDATION', `${label} 超过 ${MaxWorkflowValueBytes} 字节上限。`)
  }
  return JSON.parse(serialized) as T
}

/** 路径取值：数字段只走数组、字符串段只走字典；类型对不上一律 `undefined`（而不是抛错）。 */
export function valueAtPath(value: unknown, path: AgentWorkflowValuePath = []): unknown {
  let current = value
  for (const segment of path) {
    if (!isPresent(current)) return undefined
    if (isNumber(segment)) {
      if (!isArray(current)) return undefined
      current = current[segment]
      continue
    }
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

/**
 * 结构等值的**规范文本**：dedupe 的分组键、majority_vote 的票面键、predicate 的 eq/in 比较全靠它。
 * 键排序钉死是硬要求——同一个对象字面量在两个 step 里键序不同会被判成两票，投票结果随之漂移。
 */
export function stableJson(value: unknown): string {
  if (isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.entries(value)
      .sort(([left], [right]) => compareStableStrings(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}

export function comparePredicate(item: unknown, predicate: AgentWorkflowPredicate): boolean {
  const actual = valueAtPath(item, predicate.path)
  switch (predicate.op) {
    case 'eq':
      return stableJson(actual) === stableJson(predicate.value)
    case 'neq':
      return stableJson(actual) !== stableJson(predicate.value)
    case 'in':
      return isArray(predicate.value) && predicate.value.some(
        (candidate) => stableJson(candidate) === stableJson(actual)
      )
    case 'exists':
      // value:false 是「断言不存在」的写法（`exists` 无第二个操作数可用）。
      return isFalse(predicate.value) ? isUndefined(actual) : isNotUndefined(actual)
    case 'gte':
      return isNumber(actual) && isNumber(predicate.value) && actual >= predicate.value
    case 'lte':
      return isNumber(actual) && isNumber(predicate.value) && actual <= predicate.value
  }
}

export function asArray(value: unknown, label: string): unknown[] {
  if (!isArray(value)) throw new AppError('VALIDATION', `${label} 必须解析为数组。`)
  return value
}

/** 成功 = 收敛且**产出了结构化结果**：没有 structured_output 的"完成"下游 reducer 无从消费。 */
export function isSuccessful(result: AgentWorkflowAgentResult): boolean {
  return result.status === 'completed' && isNotUndefined(result.structured_output)
}

export async function mapWithConcurrency<T>(
  count: number,
  concurrency: number,
  worker: (index: number) => Promise<T>,
  shouldStop: () => boolean
): Promise<Array<T | undefined>> {
  const results: Array<T | undefined> = Array.from({ length: count })
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, count) }, async () => {
    for (;;) {
      if (shouldStop()) return
      const index = cursor
      cursor += 1
      if (index >= count) return
      results[index] = await worker(index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 声明值 → 生效值的钳制：`min(运行时可用额度, 声明值)`，下界由 `floor` 给。
 *
 * 缺省（模型没写）时取"运行时可用额度"而不是某个硬常量——不写等于"给我你能给的"，
 * 而能给多少由派发器说了算。
 *
 * `floor` 两种取法：并发数取 1（0 个 runner 等于什么都不跑，是死锁不是限流）；
 * agent 总量取 0（**总量帽真的可能已经用光**，此时正确行为是第一次 dispatch 就抛
 * `WorkflowBudgetExhaustedError`，让 run 状态落成 `budget_exhausted`，而不是硬塞一个名额
 * 进去、再由派发器回一段"节点失败"的文本把预算耗尽伪装成执行失败）。
 */
export function clampDeclaredLimit(
  declared: LooseOptional<number>,
  runtimeCeiling: number,
  floor: 0 | 1
): number {
  const ceiling = Math.max(floor, Math.floor(runtimeCeiling))
  if (isUndefined(declared) || !isNumber(declared)) return ceiling
  return Math.min(ceiling, Math.max(floor, Math.floor(declared)))
}
