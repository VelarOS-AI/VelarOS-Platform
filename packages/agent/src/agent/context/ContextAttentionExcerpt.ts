/**
 * 结构感知折叠预览。
 *
 * 折叠工具结果时,旧实现是 `value.slice(0, N)`——盲砍前 N 字。对任何"结果前段是
 * 封套/元信息、真数据在后段"的工具（性能指标、资源读取正文、
 * 网络 inspect 的 envelope…),预览只剩没用的前缀,逼模型召回或空转。复发事故根因。
 *
 * 这里改为:JSON 结果解析后**保留全部顶层字段**,只把大的字符串/数组/对象值截断成
 * 带标记的摘要。模型一眼看到所有顶层键与小字段,只有真需要大嵌套值时才召回。
 * 非 JSON 回退到头部截断。工具应把关键派生值放在顶层字段（如性能工具的
 * keyMetrics),这样结构感知预览能可靠呈现它们。
 */

import { isArray, isPlainObject } from '@velaros-ai/core'
export interface StructuredExcerptOptions {
  /** 单个字符串值保留的字符数,超出截断并标注省略量。 */
  fieldValueChars: number
  /** 预览整体软上限;超出后丢弃靠后的字段并标注。 */
  totalChars: number
  /** 顶层字段数上限;超出丢弃并标注。 */
  maxFields: number
  /** 非 JSON 文本回退时保留的头部字符数。 */
  fallbackHeadChars: number
}

export const DefaultStructuredExcerptOptions: StructuredExcerptOptions = {
  fieldValueChars: 220,
  totalChars: 1_400,
  maxFields: 40,
  fallbackHeadChars: 600,
}

export interface StructuredExcerptResult {
  excerpt: string
  /** 'json' = 结构化保留顶层字段;'text' = 非 JSON 头部截断。 */
  kind: 'json' | 'text'
  /** 是否有任何内容被截断(供上层标注 recall 提示)。 */
  truncated: boolean
}

function truncateString(
  value: string,
  limit: number
): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false }
  // 单行化前缀更省字、更可读;保留原始换行意义不大(预览用)。
  const head = value.slice(0, limit)
  return {
    text: `${head}…[截断 ${value.length - limit}/${value.length} 字,recall 取全文]`,
    truncated: true,
  }
}

/** 把单个值压成预览态(标量原样,大字符串截断,数组/对象摘要)。 */
function summarizeValue(
  value: unknown,
  options: StructuredExcerptOptions
): { value: unknown; truncated: boolean } {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return { value, truncated: false }

  if (typeof value === 'string') {
    const { text, truncated } = truncateString(value, options.fieldValueChars)
    return { value: text, truncated }
  }

  if (isArray(value)) {
    // 短数组(全标量、条目少)原样;否则摘成 "[N 项]" + 首项预览。
    const isSmallScalarArray =
      value.length <= 12 &&
      value.every(
        (item) =>
          item === null ||
          typeof item === 'number' ||
          typeof item === 'boolean' ||
          (typeof item === 'string' && item.length <= 60)
      )
    if (isSmallScalarArray) return { value, truncated: false }

    const firstPreview =
      value.length > 0 ? summarizeValue(value[0], options).value : undefined
    return {
      value: firstPreview === undefined
        ? `[${value.length} 项,recall 取全部]`
        : { __arrayLength: value.length, first: firstPreview, note: 'recall 取全部项' },
      truncated: true,
    }
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    // 小对象(键少)递归一层浅摘要;大对象只列键名。
    if (keys.length <= 8) {
      const nested: Record<string, unknown> = {}
      let nestedTruncated = false
      for (const key of keys) {
        const summarized = summarizeValue(value[key], options)
        nested[key] = summarized.value
        nestedTruncated ||= summarized.truncated
      }
      return { value: nested, truncated: nestedTruncated }
    }
    return {
      value: `{${keys.length} 个字段: ${keys.slice(0, 12).join(', ')}…, recall 取全部}`,
      truncated: true,
    }
  }

  return { value: String(value), truncated: false }
}

/** 构建结构感知预览;失败/非 JSON 回退头部截断。 */
export function buildStructuredExcerpt(
  serializedResult: string,
  options: StructuredExcerptOptions = DefaultStructuredExcerptOptions
): StructuredExcerptResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(serializedResult)
  } catch {
    const { text, truncated } = truncateString(serializedResult, options.fallbackHeadChars)
    return { excerpt: text, kind: 'text', truncated }
  }

  // 顶层是对象:保留全部键,值逐个压成预览态。
  if (isPlainObject(parsed)) {
    const entries = Object.entries(parsed)
    const preview: Record<string, unknown> = {}
    let truncated = false
    let shownFields = 0

    for (const [key, value] of entries) {
      if (shownFields >= options.maxFields) {
        preview.__omittedFields = `+${entries.length - shownFields} 个字段(recall 取全部)`
        truncated = true
        break
      }
      const summarized = summarizeValue(value, options)
      preview[key] = summarized.value
      truncated ||= summarized.truncated
      shownFields += 1

      // 整体软上限:超了就停在当前字段并标注。
      if (JSON.stringify(preview).length > options.totalChars) {
        const remaining = entries.length - shownFields
        if (remaining > 0) {
          preview.__omittedFields = `+${remaining} 个字段(recall 取全部)`
        }
        truncated = true
        break
      }
    }

    return { excerpt: JSON.stringify(preview), kind: 'json', truncated }
  }

  // 顶层是数组或标量:数组摘长度+首项,标量直接截断。
  if (isArray(parsed)) {
    const summarized = summarizeValue(parsed, options)
    return { excerpt: JSON.stringify(summarized.value), kind: 'json', truncated: summarized.truncated }
  }

  const { text, truncated } = truncateString(serializedResult, options.fallbackHeadChars)
  return { excerpt: text, kind: 'text', truncated }
}
