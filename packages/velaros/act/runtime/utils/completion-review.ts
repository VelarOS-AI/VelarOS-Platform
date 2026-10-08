import { createHash } from 'node:crypto'

import { isArray, isEmpty, isNonBlankString, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  CompletionOriginal,
  CompletionReviewRequirement,
  CompletionReviewVerdict,
} from '../types/completion-review.js'

import { CompletionReviewLimits } from './tuning.js'

/** 内容指纹只用于字节等价；外部变化代次和授权仍由宿主快照负责。 */
export function completionHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 严格核对原文锚点、完整清单及路径身份；无法覆盖的输入保持未核查。 */
export function completionRequirements(
  value: unknown,
  originals: readonly CompletionOriginal[]
): readonly CompletionReviewRequirement[] {
  // @arch-guard:suspend code-style/forbid-redundant-strict-literal-comparison 理由：外部模型值必须是布尔 true，字符串与缺失值均不能证明清单完整。
  if (
    !isPlainObject(value) ||
    value.complete !== true ||
    !isArray(value.requirements) ||
    isEmpty(value.requirements) ||
    value.requirements.length > CompletionReviewLimits.requirements
  )
    throw new AppError('PROTOCOL', '需求提取没有返回完整、有界的清单')
  const identities = new Set<string>()
  const artifacts = new Set<string>()
  return value.requirements.map((item) => {
    if (
      !isPlainObject(item) ||
      !boundedText(item.id, 128) ||
      identities.has(item.id) ||
      !boundedText(item.label, 1000) ||
      !isArray(item.artifacts) ||
      isEmpty(item.artifacts) ||
      item.artifacts.length > CompletionReviewLimits.artifacts ||
      !isArray(item.anchors) ||
      isEmpty(item.anchors) ||
      item.anchors.length > 8
    )
      throw new AppError('PROTOCOL', '需求身份、说明、产物或原文锚点无效')
    identities.add(item.id)
    const expected = item.artifacts.map((identity) => {
      if (
        !boundedText(identity, 1024) ||
        (identity !== 'response:final' &&
          identity !== 'execution:recent' &&
          !/^file:.+/u.test(identity))
      )
        throw new AppError('PROTOCOL', '核查只支持明确的文件身份、实际执行记录与最终答复')
      artifacts.add(identity)
      return identity
    })
    if (
      new Set(expected).size !== expected.length ||
      artifacts.size > CompletionReviewLimits.artifacts
    )
      throw new AppError('LIMIT', '需求产物重复或总数超过核查上限')
    const refs = new Map<string, CompletionOriginal['ref']>()
    const anchors = item.anchors.map((anchor) => {
      if (
        !isPlainObject(anchor) ||
        !boundedText(anchor.sourceId, 256) ||
        !boundedText(anchor.quote, 2048)
      )
        throw new AppError('PROTOCOL', '需求原文引文无效')
      const source = originals.find((original) => original.ref.id === anchor.sourceId)
      if (!source?.text.includes(anchor.quote))
        throw new AppError('PROTOCOL', '需求引文不在当前任务的完整用户原文中')
      refs.set(source.ref.id, source.ref)
      return { sourceId: anchor.sourceId, quote: anchor.quote }
    })
    return {
      id: item.id,
      label: item.label,
      artifacts: expected,
      sourceRefs: [...refs.values()],
      anchors,
    }
  })
}

/** 每一必需项都需回答；通过项必须逐产物引用实际提供的完整正文。 */
export function completionVerdicts(
  value: unknown,
  requirements: readonly CompletionReviewRequirement[],
  materials: ReadonlyArray<{ readonly identity: string; readonly text: string }>
): readonly CompletionReviewVerdict[] {
  if (
    !isPlainObject(value) ||
    !isArray(value.checks) ||
    value.checks.length !== requirements.length
  )
    throw new AppError('PROTOCOL', '完成复核遗漏了必需项')
  const seen = new Set<string>()
  return value.checks.map((item) => {
    if (
      !isPlainObject(item) ||
      !boundedText(item.id, 128) ||
      seen.has(item.id) ||
      !isString(item.status) ||
      !['passed', 'failed', 'unknown'].includes(item.status) ||
      !boundedText(item.reason, 2048) ||
      !isArray(item.evidence) ||
      item.evidence.length > CompletionReviewLimits.artifacts
    )
      throw new AppError('PROTOCOL', '完成复核事实格式无效')
    const requirement = requirements.find((entry) => entry.id === item.id)
    if (!requirement) throw new AppError('PROTOCOL', '完成复核返回了清单之外的项目')
    seen.add(item.id)
    const evidence = item.evidence.map((entry) => {
      if (
        !isPlainObject(entry) ||
        !boundedText(entry.identity, 1024) ||
        !boundedText(entry.quote, 4096) ||
        !materials.some(
          (material) =>
            material.identity === entry.identity &&
            completionQuotePresent(material.text, entry.quote as string)
        )
      )
        throw new AppError('PROTOCOL', `完成复核引文没有对应的真实产物，检查项：${item.id}`)
      return { identity: entry.identity, quote: entry.quote }
    })
    if (
      item.status === 'passed' &&
      requirement.artifacts.some(
        (identity) => !evidence.some((entry) => entry.identity === identity)
      )
    )
      throw new AppError('PROTOCOL', `通过主张没有覆盖全部预期产物，检查项：${item.id}`)
    return {
      id: item.id,
      status: item.status as CompletionReviewVerdict['status'],
      reason: item.reason,
      evidence,
    }
  })
}

/** JSON 原文中的字符串值也是原始材料；只接受真实值的连续引文，不重写数字或结构。 */
function completionQuotePresent(text: string, quote: string): boolean {
  if (text.includes(quote)) return true
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
    // @arch-guard:suspend code-style/require-error-logging 理由：普通非 JSON 材料合法；解析失败只表示不能按 JSON 字符串字段匹配。
  } catch {
    return false
  }
  const remaining: unknown[] = [decoded]
  while (!isEmpty(remaining)) {
    const value = remaining.pop()
    if (isString(value) && value.includes(quote)) return true
    if (isString(value) && (value.startsWith('{') || value.startsWith('['))) {
      try {
        remaining.push(JSON.parse(value))
        // @arch-guard:suspend code-style/require-error-logging 理由：以括号开头的普通字符串合法，解析失败保留其已执行的字面匹配。
      } catch {
        // arch-guard:silent-catch-ok 普通字符串并非 JSON，保留其字面匹配结果。
      }
    }
    if (isArray(value)) remaining.push(...value)
    else if (isPlainObject(value)) remaining.push(...Object.values(value))
  }
  return false
}

/** 输入边界按字符与非空白文本核对，不让异常对象进入提示词。 */
function boundedText(value: unknown, maximum: number): value is string {
  return isNonBlankString(value) && value.length <= maximum
}
