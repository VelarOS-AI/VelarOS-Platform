import { isArray } from '@velaros-ai/core'

import { DefaultContextViewLimits } from '../contract/constants.js'
import type {
  ContextGap,
  ContextTarget,
  ContextTaskState,
  ContextViewLimits,
  RegisteredViewIntent,
} from '../types/context.js'

import { checkModelBudget } from './model-budget.js'
import { contextFailure } from './state.js'

/** 合并有限预算，零只允许用于关闭重取。 */
export function resolveViewLimits(input: Partial<ContextViewLimits> = {}): ContextViewLimits {
  const limits = { ...DefaultContextViewLimits, ...input }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (key === 'refreshes' ? 0 : 1))
      throw contextFailure('VIEW_BUDGET', `预算必须为有限整数：${key}`)
  }
  return Object.freeze(limits)
}

/** 内容指纹使用平台 WebCrypto，浏览器入口不依赖 Node。 */
export async function contextHash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

/** 构造缺口而不是伪造证据或静默满足请求。 */
export function contextGap(intent: RegisteredViewIntent, code: string, detail: string): ContextGap {
  return { intentId: intent.id, required: intent.request.importance !== 'preferred', code, detail }
}

/** 资源目标保持由宿主登记的源身份。 */
export function resourceTarget(
  target: ContextTarget
): Extract<ContextTarget, { kind: 'resource' }> {
  if (target.kind !== 'resource') throw contextFailure('VIEW_TARGET', '操作需要资源目标')
  return target
}

/**
 * 读回任务检查点：结构不完整就拒，避免把损坏记录解释为新任务。
 * 旧版本写下的「待核对」（needs-reconcile）已经没有这一态，按 context-pending 读。
 */
export function readContextTask(stored: ContextTaskState): ContextTaskState {
  const value =
    stored && (stored.status as string) === 'needs-reconcile'
      ? { ...stored, status: 'context-pending' as const }
      : stored
  if (
    !value ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    ![
      'ready',
      'executing',
      'context-pending',
      'view-ready',
      'context-blocked',
      'completed',
      'cancelled',
      'failed',
    ].includes(value.status) ||
    !isArray(value.goals) ||
    !isArray(value.intents) ||
    !isArray(value.mandatory) ||
    !isArray(value.artifacts) ||
    !value.capsule ||
    !value.usage
  )
    throw contextFailure('TASK_STATE', '任务检查点结构无效')
  // 计数都是非负整数；每小时分桶的起点与两桶用量同样是非负整数
  const { hourly, ...counts } = value.usage
  for (const count of [...Object.values(counts), ...Object.values(hourly ?? {})])
    if (!Number.isSafeInteger(count) || count < 0)
      throw contextFailure('TASK_STATE', '任务用量无效')
  checkModelBudget(value)
  return value
}

/** 有界等待适配器；迟到结果不能越过取消边界发布。 */
export async function awaitContextOperation<T>(
  pending: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  let cancel: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason ?? contextFailure('CANCELLED', '上下文读取已取消'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
