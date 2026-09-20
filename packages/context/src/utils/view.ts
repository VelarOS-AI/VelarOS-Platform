import { Ajv } from 'ajv'

import type { ContextGap, ContextTarget, ContextTaskState, ContextViewLimits, RegisteredViewIntent } from '../contract/context.js'
import { DefaultContextViewLimits } from '../contract/context.js'

import { contextFailure } from './state.js'

/** 严格校验边界 JSON，不默认填充或转换模型输入。 */
export function assertViewSchema(schema: object, value: unknown): void {
  const validate = new Ajv({ strict: true, strictRequired: false, allErrors: true }).compile(schema)
  if (!validate(value)) throw contextFailure('VIEW_SCHEMA', `观察协议不合法：${  JSON.stringify(validate.errors).slice(0, 1200)}`)
}

/** 合并有限预算，零只允许用于关闭规划和重取。 */
export function resolveViewLimits(input: Partial<ContextViewLimits> = {}): ContextViewLimits {
  const limits = { ...DefaultContextViewLimits, ...input }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (['plannerCalls', 'refreshes'].includes(key) ? 0 : 1)) throw contextFailure('VIEW_BUDGET', `预算必须为有限整数：${  key}`)
  }
  return Object.freeze(limits)
}

/** 内容指纹使用平台 WebCrypto，浏览器入口不依赖 Node。 */
export async function contextHash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('')
}

/** 构造缺口而不是伪造证据或静默满足请求。 */
export function contextGap(intent: RegisteredViewIntent, code: string, detail: string): ContextGap {
  return { intentId: intent.id, required: intent.request.importance !== 'preferred', code, detail }
}

/** 资源目标保持由宿主登记的源身份。 */
export function resourceTarget(target: ContextTarget): Extract<ContextTarget, { kind: 'resource' }> {
  if (target.kind !== 'resource') throw contextFailure('VIEW_TARGET', '操作需要资源目标')
  return target
}

/** 恢复任务必须包含结构完整的状态，避免把损坏记录解释为新任务。 */
export function assertContextTask(value: ContextTaskState): void {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 1 || !['ready', 'executing', 'context-pending', 'view-ready', 'needs-reconcile', 'context-blocked', 'completed', 'cancelled', 'failed'].includes(value.status) || !Array.isArray(value.goals) || !Array.isArray(value.intents) || !Array.isArray(value.mandatory) || !Array.isArray(value.artifacts) || !value.capsule || !value.usage) throw contextFailure('TASK_STATE', '任务检查点结构无效')
  for (const count of Object.values(value.usage)) if (!Number.isSafeInteger(count) || count < 0) throw contextFailure('TASK_STATE', '任务用量无效')
}

/** 有界等待适配器；迟到结果不能越过取消边界发布。 */
export async function awaitContextOperation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason ?? contextFailure('CANCELLED', '上下文读取已取消'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
  try { return await Promise.race([pending, aborted]) }
  finally { signal.removeEventListener('abort', cancel) }
}
