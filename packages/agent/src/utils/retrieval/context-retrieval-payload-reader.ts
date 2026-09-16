// ContextRetrievalPayloadReader 用到的纯函数（不碰实例状态）。
import { isString } from '@velaros-ai/core'
import { isArray, isNumber, isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { JsonPathSegment } from '../../types/retrieval.js'
import type { JsonPathSelection } from '../../types/retrieval.js'

/** 从 JSON 路径的某个位置读一个裸标识符，返回键名与下一个读取位置。 */
export function readJsonPathIdentifier(path: string, start: number): Nullable<{ key: string; next: number }> {
  let index = start
  while (index < path.length && /[A-Za-z0-9_$]/.test(path[index]!)) {
    index += 1
  }

  if (index === start) return null

  return { key: path.slice(start, index), next: index }
}

/** 把 JSON 路径里的带引号键解成真实键名（处理反斜杠转义）。 */
export function readJsonPathQuotedKey(raw: string): Nullable<string> {
  const inner = raw.slice(1, -1)
  let value = ''
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]!
    if (char !== '\\') {
      value += char
      continue
    }

    index += 1
    const escaped = inner[index]
    if (!escaped) return null
    switch (escaped) {
      case '"':
      case '\\':
      case '/': {
        value += escaped
        break
      }
      case 'b': {
        value += '\b'
        break
      }
      case 'f': {
        value += '\f'
        break
      }
      case 'n': {
        value += '\n'
        break
      }
      case 'r': {
        value += '\r'
        break
      }
      case 't': {
        value += '\t'
        break
      }
      case 'u': {
        const hex = inner.slice(index + 1, index + 5)
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null
        value += String.fromCharCode(Number.parseInt(hex, 16))
        index += 4
        break
      }
      default:
        return null
    }
  }
  return value
}

/** 读一段方括号下标（数字或带引号的键），返回这一段与下一个读取位置。 */
export function readJsonPathBracket(path: string, start: number): Nullable<{ segment: JsonPathSegment; next: number }> {
  let end = -1
  let quoted = false
  let escaped = false
  for (let index = start + 1; index < path.length; index++) {
    const char = path[index]
    if (escaped) { escaped = false; continue }
    if (quoted && char === '\\') { escaped = true; continue }
    if (char === '"') { quoted = !quoted; continue }
    if (!quoted && char === ']') { end = index; break }
  }
  if (end < 0) return null

  const raw = path.slice(start + 1, end).trim()
  if (/^\d+$/.test(raw)) return { segment: Number(raw), next: end + 1 }

  if (raw.startsWith('"') && raw.endsWith('"')) {
    const parsed = readJsonPathQuotedKey(raw)
    return isString(parsed) ? { segment: parsed, next: end + 1 } : null
  }

  return null
}

/** 把用户写的 JSON 路径解析成段序列；不合法返回 null。 */
export function parseJsonPath(path: string): Nullable<JsonPathSegment[]> {
  const trimmed = path.trim()
  const normalized = trimmed.startsWith('$')
    ? trimmed
    : trimmed.startsWith('.') || trimmed.startsWith('[')
      ? `$${trimmed}`
      : `$.${trimmed}`
  if (normalized === '$') return []
  if (!normalized.startsWith('$')) return null

  const segments: JsonPathSegment[] = []
  let index = 1

  while (index < normalized.length) {
    const char = normalized[index]
    if (char === '.') {
      const identifier = readJsonPathIdentifier(normalized, index + 1)
      if (!identifier) return null
      segments.push(identifier.key)
      index = identifier.next
      continue
    }

    if (char === '[') {
      const bracket = readJsonPathBracket(normalized, index)
      if (!bracket) return null
      segments.push(bracket.segment)
      index = bracket.next
      continue
    }

    return null
  }

  return segments
}

/** 按 JSON 路径从一段序列化载荷里取值；解析不了或路径不存在都按 found:false 回。 */
export function selectJsonPath(serialized: string, path: string): JsonPathSelection {
  let root: unknown
  try {
    root = JSON.parse(serialized)
  } catch (error) {
    return {
      found: false,
      value: null,
      reason: `serializedResult 不是合法 JSON，按 jsonPath 取值前解析就失败了：${AppError.getMessage(error)}`,
    }
  }

  const segments = parseJsonPath(path)
  if (!segments) return {
      found: false,
      value: null,
      reason: 'jsonPath 写法不对：请写成 $.a.b[0] 或 $["complex.key"] 这样的路径。',
    }

  let current = root
  for (const segment of segments) {
    if (isNumber(segment)) {
      if (!isArray(current) || segment >= current.length) return {
          found: false,
          value: null,
          reason: `jsonPath 的 [${segment}] 这一段取不到：这里不是数组，或者下标越界了。`,
        }
      current = current[segment]
      continue
    }

    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return {
        found: false,
        value: null,
        reason: `jsonPath 的 ${segment} 这一段取不到：这里不是对象，或者对象上没有这个键。`,
      }
    current = current[segment]
  }

  return { found: true, value: current }
}
