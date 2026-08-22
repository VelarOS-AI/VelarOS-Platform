/**
 * 折叠桩统一信封，是阶段二 B1 的基础设施。
 *
 * 模型可见的旧折叠标记存在多种形态，各层曾用各自的字符串探测并提供不一致的召回入口。本模块
 * 提供统一信封构造器、覆盖全部旧键的唯一探测谓词 `isFoldStubText`，以及只读归一旧桩的
 * `normalizeLegacyFoldStub`。历史归一绝不回写归档。
 *
 * 机器生成的桩必须在 `retrieval.args.refKind` 中显式标明引用类型，不得依赖前缀推断；例如内存内核
 * 生成的 `outputId` 可能形如 `session:tool-output:1`，按冒号数量推断会误判为证据引用。
 */

import { isNumber, isPlainObject, isString,isTrue } from '@velaros-ai/core'

export type ContextRefKind =
  | 'tool-output'
  | 'micro-compacted-tool-result'
  | 'attention-context-handle'
  | 'attention-code-pruned-context-handle'
  | 'attention-grounded-summary'
  | 'tool-payload-ref'
  | 'duplicate-tool-result'
  | 'history-budget-truncated'

export interface ContextRefRetrieval {
  tool: 'context:recall'
  args: {
    ref: string
    refKind: 'tool-payload' | 'payload-ref' | 'context-handle' | 'evidence'
    reason?: string
    maxChars?: number
    jsonPath?: string
  }
}

export interface ContextRefEnvelope {
  /** 唯一判别键;嗅探恒用 '"__contextRef"' 字符串。 */
  __contextRef: ContextRefKind
  /** 信封版本。 */
  v: 1
  /** 规范召回引用,恒等于 retrieval.args.ref。 */
  ref: string
  toolCallId?: string
  toolName?: string
  /** ctx-payload:* 内容寻址引用。 */
  payloadRef?: string
  payloadHash?: string
  excerpt?: string
  excerptKind?: 'structured' | 'head' | 'facts' | 'code' | 'text' | 'json'
  /** false=摘录未截断(内容已完整可见,不必召回);true/缺省=可能需要召回。 */
  excerptTruncated?: boolean
  originalLength?: number
  /** 折叠原因。 */
  reason?: string
  /** 恒存在恒同形;excerptTruncated:false 时仍带(供一致解析),但模型不应对未截断内容空转召回。 */
  retrieval: ContextRefRetrieval
  /** kind 扩展字段(如 attention-code-pruned 的 meta.codePruning)。 */
  meta?: Record<string, unknown>
}

export function buildContextRefEnvelope(
  input: Omit<ContextRefEnvelope, 'v'>
): ContextRefEnvelope {
  return { v: 1, ...input }
}

/**
 * 旧键清单用于读取兼容，不能删除对 `__truncated` 与 `__kernelRef` 的识别：
 * - `__kernelRef: 'tool-output'` 曾持久化进模型历史，旧归档会长期包含该键；
 * - `__truncated` 由核心工具结果序列化逻辑独立生产，在生产者迁移前持续存在；
 * - `__contextSummary` 是注意力有据摘要在 B3 改名前使用的判别键。
 */
const FoldStubSniffTokens = [
  '"__contextRef"',
  '"__kernelRef"',
  '"__truncated"',
  '"__contextSummary"',
] as const

/**
 * 统一廉价嗅探:该文本是否已是(任意代际的)折叠桩。
 *
 * 用途:各折叠层的"别把桩再折一层"互认判定——此前四层各写各的谓词,
 * 注意力路由只认 __contextRef,会把 __kernelRef/__truncated 桩再包一层
 * attention-handle(真实存在的双重折叠缺陷,B1 即修)。
 */
export function isFoldStubText(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  return FoldStubSniffTokens.some((token) => trimmed.includes(token))
}

/** 结构化判定:解析后的对象是否为(任意代际的)折叠桩对象。 */
export function isFoldStubRecord(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const record = value as Record<string, unknown>
  return (
    isString(record.__contextRef) ||
    isString(record.__kernelRef) ||
    isTrue(record.__truncated) ||
    isString(record.__contextSummary)
  )
}

/**
 * 新信封边界守卫(§12.5,与 ContextRefEnvelope 同居单源)。
 * 接受面与历史行为一致:只看判别键 __contextRef 与 ref 两个字符串字段——历史装载是
 * 宽容边界,其余字段缺失/异形由消费方按可选字段兜住,不在此收紧。
 */
export function isContextRefEnvelope(value: unknown): value is ContextRefEnvelope {
  if (!isPlainObject(value)) return false
  const record = value as Record<string, unknown>
  return isString(record.__contextRef) && isString(record.ref)
}

/**
 * 旧键桩 → 统一信封的只读归一(B3 历史装载路径使用;绝不回写归档文件)。
 * 认不出的形状原样返回 null,调用方保留原文。
 */
export function normalizeLegacyFoldStub(value: unknown): Nullable<ContextRefEnvelope> {
  if (!isPlainObject(value)) return null
  const record = value as Record<string, unknown>

  // 新信封:原样透传。
  if (isContextRefEnvelope(value)) return value

  const readString = (key: string): string | undefined =>
    isString(record[key]) ? (record[key] as string) : undefined

  // __kernelRef:'tool-output'(唯一持久化桩)。
  if (record.__kernelRef === 'tool-output') {
    const payloadRef = readString('payloadRef')
    const toolCallId = readString('toolCallId')
    const ref = payloadRef ?? toolCallId
    if (!ref) return null
    return buildContextRefEnvelope({
      __contextRef: 'tool-output',
      ref,
      toolCallId,
      toolName: readString('toolName'),
      payloadRef,
      excerpt: readString('preview'),
      originalLength: isNumber(record.chars) ? (record.chars as number) : undefined,
      retrieval: {
        tool: 'context:recall',
        args: { ref, refKind: payloadRef ? 'payload-ref' : 'tool-payload' },
      },
    })
  }

  // __truncated 整体桩(sanitize/core 顶层)。
  if (isTrue(record.__truncated)) {
    const toolCallId = readString('toolCallId')
    if (!toolCallId) return null
    return buildContextRefEnvelope({
      __contextRef: 'history-budget-truncated',
      ref: toolCallId,
      toolCallId,
      originalLength:
        isNumber(record.originalLength) ? (record.originalLength as number) : undefined,
      retrieval: {
        tool: 'context:recall',
        args: { ref: toolCallId, refKind: 'tool-payload' },
      },
    })
  }

  // __contextSummary:'attention-grounded-summary'。
  if (record.__contextSummary === 'attention-grounded-summary') {
    const blockId = readString('blockId') ?? readString('ref')
    if (!blockId) return null
    return buildContextRefEnvelope({
      __contextRef: 'attention-grounded-summary',
      ref: blockId,
      excerpt: readString('summary'),
      retrieval: {
        tool: 'context:recall',
        args: { ref: blockId, refKind: 'context-handle' },
      },
    })
  }

  return null
}
