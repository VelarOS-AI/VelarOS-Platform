import { isArray, isEmpty } from '@velaros-ai/core'

export interface PaginatedJsonPathSelection {
  offset: number
  returnedItems: number
  totalItems: number
  nextOffset: Nullable<number>
  serialized: string
  oversizedItemIndex?: number
}

/** 正文及非数组 JSON 子树的 UTF-16 字符窗口。 */
export interface PaginatedTextWindow {
  offset: number
  totalChars: number
  returnedChars: number
  nextOffset: Nullable<number>
  text: string
  /** offset 已越过正文末尾：模型多半在原地打转，必须显式告知而不是静默回第一页。 */
  beyondEnd: boolean
}

/**
 * 正文按 offset 开窗（**字符**语义）。
 *
 * jsonPath 命中数组时按条目分页（{@link paginateJsonPathSelection}），其余一切情况——包括
 * 一整段 30 万字的 serializedResult——过去完全忽略 offset，每次都回同一段开头（审计 U31）：
 * 模型照着 `nextOffset` 提示加 offset 重试，拿到逐字相同的内容直到熔断。这里给它真实的顺序读。
 */
export function paginateSerializedText(
  text: string,
  offsetInput: LooseOptional<number>,
  maxChars: number,
): PaginatedTextWindow {
  const totalChars = text.length
  const requested = Math.max(0, Math.round(offsetInput ?? 0))
  const budget = Math.max(1, maxChars)
  const beyondEnd = requested > 0 && requested >= totalChars
  // 越界不回退到 0：回第一页正是"原地打转"的成因，宁可给空窗口 + 明确告警。
  const offset = Math.min(requested, totalChars)
  let end = Math.min(totalChars, offset + budget)
  // Avoid splitting a UTF-16 surrogate pair or a CRLF across pages.
  if (end < totalChars && end > offset) {
    const previous = text.charCodeAt(end - 1)
    const next = text.charCodeAt(end)
    if (
      (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) ||
      (previous === 13 && next === 10)
    ) {
      end = end - 1 > offset ? end - 1 : end + 1
    }
  }
  const window = text.slice(offset, end)

  return {
    offset,
    totalChars,
    returnedChars: window.length,
    nextOffset: end < totalChars ? end : null,
    text: window,
    beyondEnd,
  }
}

/**
 * jsonPath 命中数组时按 maxChars 预算从 offset 开始装填条目，供模型分页续读
 * （配合工具结果里 `__truncatedItems` 标记的 `nextOffset`）。非数组返回 null 走原路径。
 * 单条目超预算时返回其下标，由调用者提供子树引用；不把截断文本伪装成完整条目。
 */
export function paginateJsonPathSelection(
  value: unknown,
  offsetInput: LooseOptional<number>,
  maxChars: number,
): Nullable<PaginatedJsonPathSelection> {
  if (!isArray(value)) return null

  const totalItems = value.length
  const offset = Math.min(Math.max(0, Math.round(offsetInput ?? 0)), totalItems)
  const budget = Math.max(1_000, maxChars)
  const parts: string[] = []
  let used = 4 // '[\n' + '\n]'
  let index = offset
  let oversizedItemIndex: number | undefined

  while (index < totalItems) {
    let serializedItem: string
    try {
      serializedItem = JSON.stringify(value[index], undefined, 1) ?? 'null'
    } catch {
      // arch-guard:silent-catch-ok 单条不可序列化不该中断整页装填；占位符本身就是给模型的说明。
      serializedItem = '"[unserializable item]"'
    }

    if (!isEmpty(parts) && used + serializedItem.length + 2 > budget) break

    if (isEmpty(parts) && serializedItem.length + 4 > budget) {
      oversizedItemIndex = index
      index += 1
      break
    }

    parts.push(serializedItem)
    used += serializedItem.length + 2
    index += 1
  }

  return {
    offset,
    returnedItems: parts.length,
    totalItems,
    nextOffset: index < totalItems ? index : null,
    serialized: `[\n${parts.join(',\n')}\n]`,
    ...(oversizedItemIndex === undefined ? {} : { oversizedItemIndex }),
  }
}

/** One presentation contract for array pages and lossless text/object windows. */
export function paginateJsonPathValue(
  value: unknown,
  jsonPath: string,
  offset: LooseOptional<number>,
  maxChars: number,
): { body: string; summary: string; metadata: Record<string, unknown> } {
  const array = paginateJsonPathSelection(value, offset, maxChars)
  if (array) {
    const oversizedItem =
      array.oversizedItemIndex === undefined
        ? null
        : {
            index: array.oversizedItemIndex,
            jsonPath: `${jsonPath}[${array.oversizedItemIndex}]`,
            offset: 0,
          }
    return {
      body: array.serialized,
      summary:
        `items: ${array.returnedItems}/${array.totalItems} (offset=${array.offset}, nextOffset=${array.nextOffset})${ 
        oversizedItem
          ? `\n条目 ${oversizedItem.index} 超过本页预算；完整读取传 jsonPath=${oversizedItem.jsonPath}, offset=0。`
          : ''}`,
      metadata: {
        offset: array.offset,
        offsetUnit: 'item',
        returnedItems: array.returnedItems,
        totalItems: array.totalItems,
        nextOffset: array.nextOffset,
        ...(oversizedItem ? { oversizedItem } : {}),
      },
    }
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1)
  const window = paginateSerializedText(text, offset, maxChars)
  return {
    body: window.text,
    summary: `chars: ${window.offset}-${window.offset + window.returnedChars}/${window.totalChars} (nextOffset=${window.nextOffset})`,
    metadata: {
      offset: window.offset,
      offsetUnit: 'utf16-code-unit',
      contentFormat: typeof value === 'string' ? 'text' : 'json',
      returnedChars: window.returnedChars,
      totalChars: window.totalChars,
      nextOffset: window.nextOffset,
    },
  }
}
