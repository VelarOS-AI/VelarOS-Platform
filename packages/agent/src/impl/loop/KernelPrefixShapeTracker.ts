import { isEmpty, isPresent,isString } from '@velaros-ai/core'

import type { KernelPrefixShape, KernelPrefixShapeDiagnostic, KernelPrefixShapeInput, KernelPrefixShapePhase, RecordKernelPrefixShapeDiagnosticInput } from '../../types/loop.js'
import type { ProviderTurnRecorder } from '../../types/records.js'
import { compareStableStrings, stableStringify } from '../../utils/residency/determinism'
import { UnknownGovernanceSessionId } from '../../utils/residency/session-key'

/** 记一次前缀形状要给的东西：账本按「哪条会话 + 哪条链路 + 哪个模型」分格，外加这次算出的形状。 */
export interface KernelPrefixShapeTrackerRecordInput {
  /**
   * 这次请求属于哪条会话。缺席或等于无身份兜底值时整条记录不入账——兜底键是所有无身份会话共用的
   * 那一格，按它索引会把不同会话的前缀混成一条，报出根本不存在的漂移。
   */
  sessionId?: LooseOptional<string>
  /** 哪条链路（`stream` 主面 / `query` 子 Agent 面）；两条链路各记各的，不互相污染。 */
  phase: KernelPrefixShapePhase
  /** 本次请求实际用的模型 id；换模型等于换一本账，因为前缀缓存本来就不跨模型。 */
  model: string
  /** 本次请求算出的前缀形状（system / tools / 历史改写指纹的哈希）。 */
  current: KernelPrefixShape
}

/** 记完一次的回执：拿它去和上一次比，就能判断本轮前缀是否变了、变在哪。 */
export interface KernelPrefixShapeTrackerRecord {
  /** 刚记进账本的这一份形状（就是入参里的 current）。 */
  current: KernelPrefixShape
  /** 同一把键上一次记的形状；首次记录或无身份会话时缺席，此时诊断一律判「没变」。 */
  previous?: KernelPrefixShape
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

/**
 * 前缀形状账本：只为回答一句话——「这一轮的稳定前缀跟上一轮还是同一份吗」。
 *
 * 谁持有：`StreamTurn` 与 `QueryTurn` 各一个实例（跟着 turn helper 活，进程内内存，不落盘）。
 * 什么时候调：请求编译完、发给 provider 之前调 `record()`，把回执交给
 * `recordKernelPrefixShapeDiagnostic` 写进本回合的 provider 账本；`cache-prefix-shape` 诊断里的
 * 「前缀变了 / 变在 system 还是 tools」全靠它给的 previous。
 * 只是诊断，不影响发送：无论变没变都照发，记账失败也不该阻断一轮请求（本类不抛错）。
 */
export interface KernelPrefixShapeTrackerApi {
  /**
   * 记一次并返回 {current, previous}。同一把键（会话 + 链路 + 模型）后记的覆盖先记的；
   * 会话无身份时不入账，只把 current 原样回传（于是诊断判「没有上一份」而不是误报漂移）。
   */
  record(input: KernelPrefixShapeTrackerRecordInput): KernelPrefixShapeTrackerRecord
  /** 丢账：给 key 三件套就只丢那一格，不给就整本清空。会话结束或要重头比对时用。 */
  clear(input?: Omit<KernelPrefixShapeTrackerRecordInput, 'current'>): void
}

class KernelPrefixShapeTracker implements KernelPrefixShapeTrackerApi {
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

export {
  buildKernelPrefixShape,
  compareKernelPrefixShape,
  KernelPrefixShapeTracker,
  recordKernelPrefixShapeDiagnostic,
}
