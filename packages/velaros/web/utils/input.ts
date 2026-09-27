/**
 * search 与 read 的入参核对：入参来自模型的程序，程序只查过语法、不查类型；形状、取值、上限不对都在这里拦（`VALIDATION`，
 * message 点名字段），端口一次都不调、一个页面都不开。
 */

import { isEmpty, isNonBlankString, isPlainObject, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { WebLimits } from '../contract/constants.js'
import type { WebReadRequest, WebSearchRequest } from '../types/page.js'

import { httpUrl } from './urls.js'

/** 一个操作收哪些字段：多给的字段当场拒，免得模型以为它起了作用。 */
const AcceptedFields = Object.freeze({
  search: Object.freeze(['query', 'limit']),
  read: Object.freeze(['url', 'offset', 'maxChars']),
})

/** 入参要是对象、只带这个操作认的字段；否则当场拒。 */
function fieldsOf(input: unknown, operation: keyof typeof AcceptedFields): Record<string, unknown> {
  const accepted: readonly string[] = AcceptedFields[operation]
  if (!isPlainObject(input))
    throw new AppError('VALIDATION', `${operation} 要一个对象入参，字段是 ${accepted.join('、')}`)
  const extra = Object.keys(input).filter((key) => !accepted.includes(key))
  if (!isEmpty(extra))
    throw new AppError(
      'VALIDATION',
      `${operation} 不认 ${extra.join('、')}：只收 ${accepted.join('、')}${operation === 'search' ? '（搜索引擎按用户的设置选）' : ''}`
    )
  return input
}

/** 取一个可选的条数、字数：不给（或给 null）用缺省值，给了要是 1 到上限的整数。 */
function countField(value: unknown, field: string, fallback: number, max: number): number {
  if (!isPresent(value)) return fallback
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max)
    throw new AppError(
      'VALIDATION',
      `${field} 要是 1 到 ${max} 之间的整数，这里是 ${JSON.stringify(value)}`
    )
  return value as number
}

/** 取出起点：不给（或给 null）是 0，给了要是不小于 0 的整数。 */
function offsetField(value: unknown): number {
  if (!isPresent(value)) return 0
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new AppError(
      'VALIDATION',
      `offset 要是不小于 0 的整数（接着读就用上一次 read 交回的 nextOffset），这里是 ${JSON.stringify(value)}`
    )
  return value as number
}

/** 取出一次搜索：query 是非空的搜索词、去掉首尾空白后不超过字数上限；limit 不给用缺省条数，给了要是 1 到上限的整数。 */
export function searchRequest(input: unknown): WebSearchRequest {
  const fields = fieldsOf(input, 'search')
  if (!isNonBlankString(fields.query))
    throw new AppError(
      'VALIDATION',
      "query 要是非空的搜索词，比如 search({ query: 'Node.js 事件循环' })"
    )
  const query = fields.query.trim()
  if (query.length > WebLimits.queryChars)
    throw new AppError(
      'VALIDATION',
      `query 最多 ${WebLimits.queryChars} 个字符，这里有 ${query.length} 个；挑关键词搜`
    )
  return {
    query,
    limit: countField(fields.limit, 'limit', WebLimits.defaultResults, WebLimits.maxResults),
  }
}

/**
 * 取出一次读网页：url 去掉首尾空白、没写协议补 https://，只收 http 与 https；
 * offset 是不小于 0 的整数（不给是 0），maxChars 是 1 到上限的整数（不给用缺省字数）。
 */
export function readRequest(input: unknown): WebReadRequest {
  const fields = fieldsOf(input, 'read')
  if (!isNonBlankString(fields.url))
    throw new AppError('VALIDATION', "url 要是网址，比如 read({ url: 'https://example.com/page' })")
  const written = fields.url.trim()
  if (written.length > WebLimits.urlChars)
    throw new AppError(
      'VALIDATION',
      `url 最多 ${WebLimits.urlChars} 个字符，这里有 ${written.length} 个`
    )
  const url = httpUrl(/^[a-z][\d+.a-z-]*:\/\//iu.test(written) ? written : `https://${written}`)
  if (!url)
    throw new AppError(
      'VALIDATION',
      `read 只读 http、https 的网页，${written} 不是这样的网址；本机文件用读文件的能力读`
    )
  return {
    url: url.href,
    offset: offsetField(fields.offset),
    maxChars: countField(
      fields.maxChars,
      'maxChars',
      WebLimits.defaultReadChars,
      WebLimits.maxReadChars
    ),
  }
}
