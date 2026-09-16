// KernelPrefixShapeTracker 用到的纯函数（不碰实例状态）。
import { isString } from '@velaros-ai/core'
import { isEmpty, isPresent } from '@velaros-ai/core'

import type { KernelPrefixShape, KernelPrefixShapeDiagnostic, KernelPrefixShapeInput, RecordKernelPrefixShapeDiagnosticInput } from '../../types/loop.js'
import type { ProviderTurnRecorder } from '../../types/records.js'
import { stableStringify } from '../../utils/residency/determinism'
import { UnknownGovernanceSessionId } from '../../utils/residency/session-key'
import { compareStableStrings } from '../residency/determinism'

/**
 * 前缀形状哈希（P7-3）。
 *
 * 名字里的 stable 过去只是愿望：`JSON.stringify` 按**插入序**输出键，同一份 toolSchemaChars
 * 由不同代码路径构造出来键序就不同，哈希跟着变 —— 于是"前缀变了"的诊断会报出根本不存在的漂移。
 * 现在走 `stableStringify`（逐层键排序 + 丢 undefined），同内容必同字节必同哈希。
 * FNV-1a 32 位保持不变：这是**诊断指纹**不是安全摘要，量级足够且短。
 */
export function stableHash(value: unknown): string {
  const text = isString(value) ? value : stableStringify(value)
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/** 把一串数字里的有限正数加起来，其余忽略。 */
export function sumPositive(values: Iterable<number>): number {
  let total = 0
  for (const value of values) {
    if (Number.isFinite(value) && value > 0) {
      total += value
    }
  }
  return total
}

/** 去掉标签两端空白；全空就用兜底值。 */
export function normalizeTrackerLabel(value: string, fallback: string): string {
  const trimmed = value.trim()
  return trimmed || fallback
}

/** 去掉指纹两端空白；全空当作没有指纹。 */
export function normalizeOptionalFingerprint(value: LooseOptional<string>): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

/** 前缀形状账本的索引键：会话 + 阶段 + 模型；无身份会话不入账（返回 undefined）。 */
export function resolvePrefixShapeTrackerKey(
  input: { sessionId?: LooseOptional<string>; phase: string; model: string }
): LooseOptional<string> {
  // 无身份会话不进前缀形状账本：兜底键是所有无身份会话共用的那一个，按它索引会把不同会话的
  // 前缀混成一条。判据与 `resolveGovernanceSessionKey` 的兜底值同源，不再各写一份字面量。
  const sessionId = input.sessionId?.trim()
  if (!sessionId || sessionId === UnknownGovernanceSessionId) return undefined

  return JSON.stringify([
    sessionId,
    input.phase,
    normalizeTrackerLabel(input.model, 'unknown-model'),
  ])
}

/** 把这一轮的工具清单与 schema 体积折成前缀形状（顺序稳定，禁 locale 比较）。 */
export function buildKernelPrefixShape(input: KernelPrefixShapeInput): KernelPrefixShape {
  // P7-2：工具清单顺序进哈希也进 prompt，禁 locale 相关比较（ICU 数据一变顺序就变）。
  const toolNames = [...new Set(input.availableToolNames)].sort(compareStableStrings)
  const toolSchemaChars = Object.fromEntries(
    Object.entries(input.toolSchemaChars ?? {})
      .filter(([toolName]) => toolNames.includes(toolName))
      .sort(([left], [right]) => compareStableStrings(left, right))
      .map(([toolName, chars]) => [toolName, Math.max(0, chars)])
  )
  const toolSchemaHashes = Object.fromEntries(
    Object.entries(input.toolSchemaHashes ?? {})
      .filter(([toolName]) => toolNames.includes(toolName))
      .sort(([left], [right]) => compareStableStrings(left, right))
      .map(([toolName, hash]) => [toolName, hash])
  )
  const systemHash = stableHash(input.systemPrompt)
  const toolsHash = stableHash({ toolNames, toolSchemaChars, toolSchemaHashes })
  const toolSchemaTokens = Math.ceil(sumPositive(Object.values(toolSchemaChars)) / 4)
  const historyRewriteFingerprint = normalizeOptionalFingerprint(input.historyRewriteFingerprint)

  const shape: KernelPrefixShape = {
    prefixHash: stableHash({ systemHash, toolsHash }),
    systemHash,
    toolsHash,
    toolSchemaTokens,
  }
  if (historyRewriteFingerprint) {
    shape.historyRewriteFingerprint = historyRewriteFingerprint
  }
  return shape
}

/** 比较前后两次前缀形状，得出这一轮前缀有没有漂移与缓存命中情况。 */
export function compareKernelPrefixShape(
  previous: LooseOptional<KernelPrefixShape>,
  current: KernelPrefixShape,
  cache: {
    cacheHitTokens?: LooseOptional<number>
    cacheMissTokens?: LooseOptional<number>
  } = {}
): KernelPrefixShapeDiagnostic {
  const prefixChangeReasons: string[] = []
  if (previous) {
    if (previous.systemHash !== current.systemHash) {
      prefixChangeReasons.push('system')
    }
    if (previous.toolsHash !== current.toolsHash) {
      prefixChangeReasons.push('tools')
    }
    if (
      normalizeOptionalFingerprint(previous.historyRewriteFingerprint) !==
      normalizeOptionalFingerprint(current.historyRewriteFingerprint)
    ) {
      prefixChangeReasons.push('log_rewrite')
    }
  }

  const diagnostic: KernelPrefixShapeDiagnostic = {
    ...current,
    prefixChanged: previous ? !isEmpty(prefixChangeReasons) : false,
    prefixChangeReasons,
  }
  if (isPresent(cache.cacheHitTokens)) {
    diagnostic.cacheHitTokens = cache.cacheHitTokens
  }
  if (isPresent(cache.cacheMissTokens)) {
    diagnostic.cacheMissTokens = cache.cacheMissTokens
  }
  return diagnostic
}

/** 把一条前缀形状诊断写进回合事件归约器。 */
export function recordKernelPrefixShapeDiagnostic(
  reducer: ProviderTurnRecorder,
  input: RecordKernelPrefixShapeDiagnosticInput
): void {
  const diagnostic = compareKernelPrefixShape(input.previous, input.current, input.cache)
  reducer.apply({
    type: 'diagnostic',
    code: 'cache-prefix-shape',
    message: diagnostic.prefixChanged
      ? `发往供应方的稳定前缀变了：${diagnostic.prefixChangeReasons.join(', ')}；前缀一变，供应方那边的前缀缓存这一轮就命中不了。`
      : '已记下这次发往供应方的前缀形状：与上一轮相同，或这是本条会话的第一份。',
    details: {
      prefixHash: diagnostic.prefixHash,
      systemHash: diagnostic.systemHash,
      toolsHash: diagnostic.toolsHash,
      toolSchemaTokens: diagnostic.toolSchemaTokens,
      historyRewriteFingerprint: diagnostic.historyRewriteFingerprint,
      prefixChanged: diagnostic.prefixChanged,
      prefixChangeReasons: diagnostic.prefixChangeReasons,
      cacheHitTokens: diagnostic.cacheHitTokens,
      cacheMissTokens: diagnostic.cacheMissTokens,
    },
  })
}
