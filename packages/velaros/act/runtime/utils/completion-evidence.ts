import { isArray, isEmpty, isPlainObject, isString, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelToolDefinition } from '@velaros-ai/kernel'

import type {
  CompletionEvidenceBatch,
  CompletionEvidenceInput,
  CompletionEvidencePage,
  CompletionEvidenceQuery,
} from '../types/completion-evidence.js'

import { CompletionReviewLimits } from './tuning.js'

/** 原生只读取证入口只使用正式操作接口的生成 schema、说明和效果。 */
export function completionEvidenceTool(
  schema: Readonly<Record<string, unknown>>,
  description: string,
  name = 'retrieve_evidence'
): ModelToolDefinition {
  const input = schema as {
    readonly $ref: string
    readonly definitions: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  }
  return {
    name,
    description,
    schema: {
      ...input.definitions[input.$ref.slice('#/definitions/'.length)],
      definitions: input.definitions,
    },
  }
}

/** 同轮原生调用合并后仍只占一个批次；先核对全部参数与总查询数，再允许宿主读取。 */
export function completionEvidenceInputs(values: readonly unknown[]): CompletionEvidenceInput {
  if (isEmpty(values) || values.length > CompletionReviewLimits.evidenceBatch)
    throw new AppError('PROTOCOL', '同轮证据调用合计必须为 1..16 项只读查询')
  return completionEvidenceInput({
    queries: values.flatMap((value) => completionEvidenceInput(value).queries),
  })
}

/** 模型入参只选择已列出的证据，不能夹带路径授权、命令或任意源码。 */
export function completionEvidenceInput(value: unknown): CompletionEvidenceInput {
  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => key !== 'queries') ||
    !isArray(value.queries) ||
    isEmpty(value.queries) ||
    value.queries.length > CompletionReviewLimits.evidenceBatch
  )
    throw new AppError('PROTOCOL', '证据查询必须为 1..16 项的只读批次')
  const queries: CompletionEvidenceQuery[] = []
  for (const query of value.queries) {
    if (
      !isPlainObject(query) ||
      !isString(query.identity) ||
      !query.identity.trim() ||
      query.identity.length > 1024
    )
      throw new AppError('PROTOCOL', '证据查询身份无效')
    const keys =
      query.kind === 'read'
        ? ['kind', 'identity', 'offset', 'limit']
        : ['kind', 'identity', 'literal', 'offset', 'limit']
    if (Object.keys(query).some((key) => !keys.includes(key)))
      throw new AppError('PROTOCOL', '证据查询包含未授权字段')
    if (
      !isUndefined(query.offset) &&
      (!Number.isSafeInteger(query.offset) || (query.offset as number) < 0)
    )
      throw new AppError('PROTOCOL', '证据偏移必须为非负整数')
    if (query.kind === 'read') {
      if (
        isUndefined(query.offset) ||
        !Number.isSafeInteger(query.limit) ||
        (query.limit as number) < 1 ||
        (query.limit as number) > CompletionReviewLimits.evidenceReadChars
      )
        throw new AppError(
          'PROTOCOL',
          `连续证据读取范围无效：offset 为非负整数，limit 为 1..${CompletionReviewLimits.evidenceReadChars} 个 UTF-16 字符；批次字节额度独立计算`
        )
      queries.push({
        kind: 'read',
        identity: query.identity,
        offset: query.offset as number,
        limit: query.limit as number,
      })
    } else if (query.kind === 'find') {
      if (
        !isString(query.literal) ||
        isEmpty(query.literal) ||
        query.literal.length > CompletionReviewLimits.evidenceLiteralChars ||
        (!isUndefined(query.limit) &&
          (!Number.isSafeInteger(query.limit) ||
            (query.limit as number) < 1 ||
            (query.limit as number) > CompletionReviewLimits.evidenceMatches))
      )
        throw new AppError('PROTOCOL', '字面证据查找参数无效')
      queries.push({
        kind: 'find',
        identity: query.identity,
        literal: query.literal,
        offset: query.offset as Extract<CompletionEvidenceQuery, { kind: 'find' }>['offset'],
        limit: query.limit as Extract<CompletionEvidenceQuery, { kind: 'find' }>['limit'],
      })
    } else throw new AppError('PROTOCOL', '证据操作只支持 read 和 find')
  }
  return { queries }
}

/** 不拆开 UTF-16 代理对；引文始终为实际原文中的连续片段。 */
function startBoundary(text: string, offset: number): number {
  const current = text.charCodeAt(offset)
  const previous = text.charCodeAt(offset - 1)
  return current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff
    ? offset - 1
    : offset
}

/** 按 UTF-8 字节缩短连续片段，不把不完整字符替换成伪造正文。 */
function boundedEnd(text: string, start: number, end: number, maxBytes: number): number {
  let low = start
  let high = end
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(start, middle)) <= maxBytes) low = middle
    else high = middle - 1
  }
  return startBoundary(text, low)
}

/** 从已核对完整哈希的原文做有界字面选择；每个片段保留身份、范围、总长度与完整来源哈希。 */
export function completionEvidencePage(
  text: string,
  sha256: string,
  query: CompletionEvidenceQuery,
  maxBytes: number
): CompletionEvidencePage {
  const fragments: Array<CompletionEvidencePage['fragments'][number]> = []
  let remaining = Math.max(0, maxBytes)
  const take = (from: number, to: number) => {
    const offset = startBoundary(text, from)
    const requested = Math.min(text.length, to)
    const safeEnd = startBoundary(text, requested) < requested ? requested + 1 : requested
    const end = boundedEnd(text, offset, safeEnd, remaining)
    const content = text.slice(offset, end)
    if (!content) return offset
    fragments.push({
      identity: query.identity,
      sha256,
      offset,
      text: content,
      totalChars: text.length,
      omitted: offset > 0 || end < text.length,
    })
    remaining -= Buffer.byteLength(content)
    return end
  }
  let nextOffset: CompletionEvidencePage['nextOffset'] = null
  let issue: string | undefined
  if (query.kind === 'read') {
    const start = Math.min(query.offset, text.length)
    const end = take(start, start + query.limit)
    nextOffset = end < text.length ? end : null
    if (end === start && start < text.length) issue = '本批正文额度不足以读取下一个完整字符'
  } else {
    let next = text.indexOf(query.literal, query.offset ?? 0)
    for (
      let count = 0;
      next !== -1 && count < (query.limit ?? CompletionReviewLimits.evidenceMatches);
      count++
    ) {
      const from = Math.max(0, next - CompletionReviewLimits.evidenceContextChars)
      const to = Math.min(
        text.length,
        next + query.literal.length + CompletionReviewLimits.evidenceContextChars
      )
      // 查找片段必须实际含匹配文本；额度不足时留下续查位置，不返回截断的假匹配。
      if (Buffer.byteLength(text.slice(from, to)) > remaining) {
        issue = '本批正文额度不足，按 nextOffset 续查或缩小批次'
        break
      }
      take(from, to)
      next = text.indexOf(query.literal, next + 1)
    }
    nextOffset = next === -1 ? null : next
  }
  return {
    query,
    fragments,
    sha256,
    totalChars: text.length,
    nextOffset,
    issue,
  }
}

/** 模型编译窗口进一步收紧正文时，保留每段的真实范围并明确记录续读位置。 */
export function completionEvidenceTrim(
  batch: CompletionEvidenceBatch,
  maxBytes: number
): CompletionEvidenceBatch {
  let remaining = Math.max(0, maxBytes)
  const pages = batch.pages.map((page) => {
    let omitted = false
    let nextOffset = page.nextOffset
    const fragments = page.fragments.flatMap((fragment) => {
      const end = boundedEnd(fragment.text, 0, fragment.text.length, remaining)
      const text = fragment.text.slice(0, end)
      remaining -= Buffer.byteLength(text)
      if (end < fragment.text.length && !omitted) {
        omitted = true
        nextOffset = page.query.kind === 'find' ? (page.query.offset ?? 0) : fragment.offset + end
      }
      return text
        ? [{ ...fragment, text, omitted: fragment.omitted || end < fragment.text.length }]
        : []
    })
    return {
      ...page,
      fragments,
      nextOffset,
      issue: omitted ? '实际模型窗口限制本页正文，须按 nextOffset 续读或减少同批查询' : page.issue,
    }
  })
  return { ...batch, pages, bytes: Math.max(0, maxBytes) - remaining }
}
