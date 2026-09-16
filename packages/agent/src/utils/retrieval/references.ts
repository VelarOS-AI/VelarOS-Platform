import { basename, extname, isAbsolute, normalize } from 'node:path'

import { isArray, isNotNull, isPresent,isString, Log } from '@velaros-ai/core'
import { asRecord } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { ReferencedArtifactPath,ReferencedLogPath } from '../../types/retrieval.js'

/**
 * 内部命令日志文件名前缀（basename 匹配）。
 * 对应 VelarOS 写入的 vela-command-*.log、vela-bg-*.log 等。
 */
const InternalCommandLogPrefixes = [
  'vela-command-',
  'vela-bg-',
  'vela-system-command-',
  'vela-system-bg-',
]

/** artifact 绝对路径必须包含的目录标记（POSIX 斜杠语义）。 */
const InternalArtifactPathMarker = '/.velaros/artifacts/'

/**
 * 允许读 preview 的 artifact 扩展名（小写比较）。
 * 不在列表内的二进制文件只返回 size/type，不读内容。
 */
const TextArtifactExtensions = [
  '.csv',
  '.html',
  '.json',
  '.log',
  '.md',
  '.svg',
  '.text',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]

/** 把路径统一成 POSIX 斜杠再规范化，好拿 artifact 目录标记去比对。 */
function normalizePathForMarker(path: string): string {
  return normalize(path.replaceAll('\\', '/')).replaceAll('\\', '/')
}

/**
 * 判断是否为允许跟进的内部命令日志路径。
 * 必须：绝对路径 + basename 以 InternalCommandLogPrefixes 之一开头 + 以 `.log` 结尾。
 */
export function isInternalCommandLogPath(path: string): boolean {
  if (!isAbsolute(path)) return false

  const fileName = basename(path)
  return InternalCommandLogPrefixes.some((prefix) => fileName.startsWith(prefix)) &&
    fileName.endsWith('.log')
}

/**
 * 判断是否为内部 artifact 存储路径（含 InternalArtifactPathMarker）。
 */
export function isInternalArtifactPath(path: string): boolean {
  if (!isAbsolute(path)) return false

  return normalizePathForMarker(path).includes(InternalArtifactPathMarker)
}

/**
 * 是否应对该 artifact 尝试读取文本 preview（扩展名在白名单内）。
 */
export function isTextArtifactPath(path: string): boolean {
  return TextArtifactExtensions.includes(extname(path).toLowerCase())
}

/**
 * 推断 artifact 类型字符串。
 * 内部路径：取 marker 后第一段目录名（如 `plans`、`screenshots`）；
 * 否则退回文件扩展名或 `unknown`。
 */
export function inferArtifactType(path: string): string {
  const normalized = normalizePathForMarker(path)
  const marker = InternalArtifactPathMarker
  const markerIndex = normalized.indexOf(marker)
  if (markerIndex < 0) return extname(path).replace(/^\./, '') || 'unknown'

  const tail = normalized.slice(markerIndex + marker.length)
  return tail.split('/')[0] || extname(path).replace(/^\./, '') || 'unknown'
}

/** 把一段 JSON 字符串字面量的内容解码回原文；不是合法 JSON string 时保留原始文本。 */
function decodeJsonStringContent(value: string): string {
  try {
    return JSON.parse(`"${value}"`)
  } catch {
    // arch-guard:silent-catch-ok 内容不是合法 JSON string 时保留原始文本，避免预览解码破坏引用。
    return value
  }
}

/** 这次 JSON 解析失败是不是「截断 preview 把两段 JSON 拼在一起」的已知情形（是就不打 debug 噪音）。 */
function isExpectedPreviewJsonParseFailure(trimmed: string, error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false

  const looksConcatenated = /[\]}]\s*[[{]/.test(trimmed)
  if (!looksConcatenated) return false

  return (
    error.message.includes('Unexpected non-whitespace character after JSON') ||
    error.message.includes('Unable to parse JSON string')
  )
}

/** 保守判断一段文本看着像不像完整的 JSON 对象/数组（首尾括号配对且第一个内容字符合法）。 */
function looksLikeJsonContainer(trimmed: string): boolean {
  if (!trimmed) return false

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const firstPayloadChar = trimmed.slice(1).trimStart()[0]
    return firstPayloadChar === '"' || firstPayloadChar === '}'
  }

  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return false

  const firstPayloadChar = trimmed.slice(1).trimStart()[0]
  return (
    firstPayloadChar === '[' ||
    firstPayloadChar === ']' ||
    firstPayloadChar === '"' ||
    firstPayloadChar === '-' ||
    firstPayloadChar === '{' ||
    firstPayloadChar === 'f' ||
    firstPayloadChar === 'n' ||
    firstPayloadChar === 't' ||
    (isPresent(firstPayloadChar) && firstPayloadChar >= '0' && firstPayloadChar <= '9')
  )
}

/**
 * 保守 JSON 解析：仅当 trim 后以 `{}`/`[]` 包裹时才 parse。
 * 失败返回 null（截断 preview 走正则分支，不打 warn 刷屏）。
 */
function maybeParseJson(value: string): any {
  const trimmed = value.trim()
  if (!looksLikeJsonContainer(trimmed)) return null

  try {
    return JSON.parse(trimmed)
  } catch (error) {
    if (!isExpectedPreviewJsonParseFailure(trimmed, error)) {
      Log.tag('ContextRetrievalReferences').debug('解析上下文检索引用 JSON 失败', { error })
    }
    return null
  }
}

/**
 * 递归遍历任意 `JSON` 值，收集 `logPath`。
 *
 * ### 字符串分支
 * 1. 若整段像 `{...}` / `[...]`，尝试 `JSON.parse` 后递归
 * 2. `parse` 失败或不是 `JSON`：对**截断 `preview`** 用 `"logPath":"..."` 正则扫描（不抛 `debug` 噪音）
 *
 * ### 对象分支
 * `key===logPath` 且值为内部日志路径时直接收录；否则递归 `nested`。
 *
 * @param value 当前节点
 * @param source 逻辑路径前缀，用于 `ReferencedLogPath.source`
 * @param maxLogs 本次最多收多少条，够了就停
 * @param paths 累积数组（可变，达 `maxLogs` 即停）
 */
function collectLogPathsFromValue(
  value: any,
  source: string,
  maxLogs: number,
  paths: ReferencedLogPath[] = []
): ReferencedLogPath[] {
  if (paths.length >= maxLogs) return paths

  if (isString(value)) {
    const parsed = maybeParseJson(value)
    if (isNotNull(parsed)) {
      collectLogPathsFromValue(parsed, source, maxLogs, paths)
      return paths
    }

    for (const match of value.matchAll(/"logPath"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
      const path = decodeJsonStringContent(match[1] ?? '')
      if (path && isInternalCommandLogPath(path)) {
        paths.push({ path, source })
      }
      if (paths.length >= maxLogs) {
        break
      }
    }
    return paths
  }

  if (isArray(value)) {
    for (const item of value) {
      collectLogPathsFromValue(item, source, maxLogs, paths)
      if (paths.length >= maxLogs) {
        break
      }
    }
    return paths
  }

  const record = asRecord(value)
  if (!record) return paths

  for (const [key, nestedValue] of Object.entries(record)) {
    if (key === 'logPath' && isString(nestedValue) && isInternalCommandLogPath(nestedValue)) {
      paths.push({ path: nestedValue, source: `${source}.${key}` })
      if (paths.length >= maxLogs) {
        break
      }
      continue
    }

    collectLogPathsFromValue(nestedValue, `${source}.${key}`, maxLogs, paths)
    if (paths.length >= maxLogs) {
      break
    }
  }

  return paths
}

/**
 * 递归收集 artifact 路径。
 *
 * - 字符串：parse JSON 或整串若 isInternalArtifactPath 则收录
 * - 对象：key 为 path / artifactPath 且值为内部 artifact 路径时收录
 *
 * @param value 当前节点
 * @param source 逻辑路径前缀，用于 `ReferencedArtifactPath.source`
 * @param maxArtifacts 本次最多收多少条，够了就停
 * @param paths 累积数组（可变，达 `maxArtifacts` 即停）
 */
function collectArtifactPathsFromValue(
  value: any,
  source: string,
  maxArtifacts: number,
  paths: ReferencedArtifactPath[] = []
): ReferencedArtifactPath[] {
  if (paths.length >= maxArtifacts) return paths

  if (isString(value)) {
    const parsed = maybeParseJson(value)
    if (isNotNull(parsed)) {
      collectArtifactPathsFromValue(parsed, source, maxArtifacts, paths)
      return paths
    }

    for (const match of value.matchAll(/"(?:path|artifactPath)"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
      const path = decodeJsonStringContent(match[1] ?? '')
      if (path && isInternalArtifactPath(path)) {
        paths.push({ path, source })
      }
      if (paths.length >= maxArtifacts) {
        break
      }
    }
    if (paths.length >= maxArtifacts) return paths

    if (isInternalArtifactPath(value)) {
      paths.push({ path: value, source })
    }
    return paths
  }

  if (isArray(value)) {
    for (const item of value) {
      collectArtifactPathsFromValue(item, source, maxArtifacts, paths)
      if (paths.length >= maxArtifacts) {
        break
      }
    }
    return paths
  }

  const record = asRecord(value)
  if (!record) return paths

  for (const [key, nestedValue] of Object.entries(record)) {
    if (
      (key === 'path' || key === 'artifactPath') && isString(nestedValue) &&
      isInternalArtifactPath(nestedValue)
    ) {
      paths.push({ path: nestedValue, source: `${source}.${key}` })
      if (paths.length >= maxArtifacts) {
        break
      }
      continue
    }

    collectArtifactPathsFromValue(nestedValue, `${source}.${key}`, maxArtifacts, paths)
    if (paths.length >= maxArtifacts) {
      break
    }
  }

  return paths
}

/**
 * 从工具结果两路字段合并扫描 logPath，按 path 去重。
 *
 * @param serializedResult 工具原始序列化字符串（常为 JSON 字符串）
 * @param displayResult 工具 UI 展示结构（对象/数组/字符串）
 * @param maxLogs 单路最多跟进的日志条数
 */
export function collectReferencedLogPaths(
  serializedResult: string,
  displayResult: any,
  maxLogs: number
): ReferencedLogPath[] {
  const seen = new Set<string>()
  return [
    ...collectLogPathsFromValue(serializedResult, 'serializedResult', maxLogs),
    ...collectLogPathsFromValue(displayResult, 'displayResult', maxLogs),
  ].filter((entry) => {
    if (seen.has(entry.path)) return false
    seen.add(entry.path)
    return true
  })
}

/**
 * 从工具结果两路字段合并扫描 artifact 路径，按 path 去重。
 *
 * @param serializedResult 工具原始序列化字符串（常为 JSON 字符串）
 * @param displayResult 工具 UI 展示结构（对象/数组/字符串）
 * @param maxArtifacts 单路最多跟进的 artifact 条数
 */
export function collectReferencedArtifactPaths(
  serializedResult: string,
  displayResult: any,
  maxArtifacts: number
): ReferencedArtifactPath[] {
  const seen = new Set<string>()
  return [
    ...collectArtifactPathsFromValue(serializedResult, 'serializedResult', maxArtifacts),
    ...collectArtifactPathsFromValue(displayResult, 'displayResult', maxArtifacts),
  ].filter((entry) => {
    if (seen.has(entry.path)) return false
    seen.add(entry.path)
    return true
  })
}
