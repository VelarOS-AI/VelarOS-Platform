import { isEmpty, isPresent,isString } from '@velaros-ai/core'

import { compareStableStrings, stableStringify } from '../agent/context/residency/determinism'

import type { ProviderTurnEventReducer } from './provider-events'

export interface KernelPrefixShapeInput {
  systemPrompt: string
  availableToolNames: readonly string[]
  toolSchemaChars?: Readonly<Record<string, number>>
  toolSchemaHashes?: Readonly<Record<string, string>>
  historyRewriteFingerprint?: LooseOptional<string>
}

export interface KernelPrefixShape {
  prefixHash: string
  systemHash: string
  toolsHash: string
  toolSchemaTokens: number
  historyRewriteFingerprint?: string
}

export interface KernelPrefixShapeDiagnostic extends KernelPrefixShape {
  prefixChanged: boolean
  prefixChangeReasons: string[]
  cacheHitTokens?: number
  cacheMissTokens?: number
}

export type KernelPrefixShapePhase = 'stream' | 'query'

export interface KernelPrefixShapeTrackerRecordInput {
  sessionId?: LooseOptional<string>
  phase: KernelPrefixShapePhase
  model: string
  current: KernelPrefixShape
}

export interface KernelPrefixShapeTrackerRecord {
  current: KernelPrefixShape
  previous?: KernelPrefixShape
}

export interface RecordKernelPrefixShapeDiagnosticInput {
  previous?: LooseOptional<KernelPrefixShape>
  current: KernelPrefixShape
  cache?: {
    cacheHitTokens?: LooseOptional<number>
    cacheMissTokens?: LooseOptional<number>
  }
}

/**
 * 前缀形状哈希（P7-3）。
 *
 * 名字里的 stable 过去只是愿望：`JSON.stringify` 按**插入序**输出键，同一份 toolSchemaChars
 * 由不同代码路径构造出来键序就不同，哈希跟着变 —— 于是"前缀变了"的诊断会报出根本不存在的漂移。
 * 现在走 `stableStringify`（逐层键排序 + 丢 undefined），同内容必同字节必同哈希。
 * FNV-1a 32 位保持不变：这是**诊断指纹**不是安全摘要，量级足够且短。
 */
function stableHash(value: unknown): string {
  const text = isString(value) ? value : stableStringify(value)
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function sumPositive(values: Iterable<number>): number {
  let total = 0
  for (const value of values) {
    if (Number.isFinite(value) && value > 0) {
      total += value
    }
  }
  return total
}

function normalizeTrackerLabel(value: string, fallback: string): string {
  const trimmed = value.trim()
  return trimmed || fallback
}

function normalizeOptionalFingerprint(value: LooseOptional<string>): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function resolvePrefixShapeTrackerKey(
  input: Omit<KernelPrefixShapeTrackerRecordInput, 'current'>
): LooseOptional<string> {
  const sessionId = input.sessionId?.trim()
  if (!sessionId || sessionId === 'unknown-session') return undefined

  return JSON.stringify([
    sessionId,
    input.phase,
    normalizeTrackerLabel(input.model, 'unknown-model'),
  ])
}

class KernelPrefixShapeTracker {
  private readonly shapes = new Map<string, KernelPrefixShape>()

  public record(input: KernelPrefixShapeTrackerRecordInput): KernelPrefixShapeTrackerRecord {
    const key = resolvePrefixShapeTrackerKey(input)
    if (!key) return { current: input.current }

    const previous = this.shapes.get(key)
    this.shapes.set(key, input.current)
    return previous ? { current: input.current, previous } : { current: input.current }
  }

  public clear(input?: Omit<KernelPrefixShapeTrackerRecordInput, 'current'>): void {
    if (!input) {
      this.shapes.clear()
      return
    }

    const key = resolvePrefixShapeTrackerKey(input)
    if (key) this.shapes.delete(key)
  }
}

function buildKernelPrefixShape(input: KernelPrefixShapeInput): KernelPrefixShape {
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

function compareKernelPrefixShape(
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

function recordKernelPrefixShapeDiagnostic(
  reducer: ProviderTurnEventReducer,
  input: RecordKernelPrefixShapeDiagnosticInput
): void {
  const diagnostic = compareKernelPrefixShape(input.previous, input.current, input.cache)
  reducer.apply({
    type: 'diagnostic',
    code: 'cache-prefix-shape',
    message: diagnostic.prefixChanged
      ? `Provider prefix changed: ${diagnostic.prefixChangeReasons.join(', ')}`
      : 'Provider prefix shape recorded',
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

export {
  buildKernelPrefixShape,
  compareKernelPrefixShape,
  KernelPrefixShapeTracker,
  recordKernelPrefixShapeDiagnostic,
}
