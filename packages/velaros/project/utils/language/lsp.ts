import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { isArray, isNumber, isPlainObject, isString, Log, trimmedStringOrEmpty } from '@velaros-ai/core'

import type {
  ExternalLanguageDiagnostic,
  ExternalLanguageLocation,
} from '../../types/project.js'

const log = Log.tag('ExternalLanguageServer')

/** LSP 的位置参数：URI 加从 0 起的行列（本包对外一律从 1 起，所以这里减一）。 */
export function positionParams(path: string, line: number, column: number): PlainObject {
  return {
    textDocument: { uri: pathToFileURL(path).href },
    position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
  }
}

/** 一条 JSON-RPC 消息的帧：`Content-Length` 头加正文。 */
export function encodeLspFrame(value: unknown): string {
  const body = JSON.stringify(value)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

/** 给语言服务进程发一条通知（不等回执）。 */
export function notifyLanguageServer(
  child: ChildProcessWithoutNullStreams,
  method: string,
  params: unknown
): void {
  child.stdin.write(encodeLspFrame({ jsonrpc: '2.0', method, params }))
}

/** 把 LSP 的诊断归一成本包的形状；缺范围、缺正文的一律丢掉。 */
export function normalizeLspDiagnostic(
  path: string,
  source: string,
  value: unknown
): Nullable<ExternalLanguageDiagnostic> {
  if (!isPlainObject(value) || !isPlainObject(value.range) || !isPlainObject(value.range.start))
    return null
  const start = value.range.start
  const end = isPlainObject(value.range.end) ? value.range.end : null
  const message = trimmedStringOrEmpty(value.message)
  if (!isNumber(start.line) || !isNumber(start.character) || !message) return null
  const severity =
    value.severity === 2 ? 'warning' : value.severity === 3 || value.severity === 4 ? 'info' : 'error'
  return {
    severity,
    path,
    line: start.line + 1,
    column: start.character + 1,
    endLine: end && isNumber(end.line) ? end.line + 1 : null,
    endColumn: end && isNumber(end.character) ? end.character + 1 : null,
    code: isString(value.code) || isNumber(value.code) ? String(value.code) : null,
    source,
    message,
  }
}

/** 把 LSP 的 Location / LocationLink 归一成本包的形状；URI 非法就丢掉。 */
export function normalizeLspLocation(value: unknown): Nullable<ExternalLanguageLocation> {
  if (!isPlainObject(value)) return null
  const uri = isString(value.uri) ? value.uri : isString(value.targetUri) ? value.targetUri : null
  const range = isPlainObject(value.range)
    ? value.range
    : isPlainObject(value.targetSelectionRange)
      ? value.targetSelectionRange
      : null
  if (!uri || !range || !isPlainObject(range.start)) return null
  const start = range.start
  const end = isPlainObject(range.end) ? range.end : null
  if (!isNumber(start.line) || !isNumber(start.character)) return null
  try {
    return {
      path: fileURLToPath(uri),
      line: start.line + 1,
      column: start.character + 1,
      endLine: end && isNumber(end.line) ? end.line + 1 : null,
      endColumn: end && isNumber(end.character) ? end.character + 1 : null,
      preview: null,
    }
  } catch (error) {
    log.debug('语言服务忽略了非法的跳转 URI。', { error, uri })
    return null
  }
}

/** 把 LSP 的 markup（字符串、数组、`{language,value}`）压成一段纯文本。 */
export function markupText(value: unknown): string {
  if (isString(value)) return value.trim()
  if (isArray(value)) return value.map(markupText).filter(Boolean).join('\n')
  if (!isPlainObject(value)) return ''
  if (isString(value.language) && isString(value.value))
    return `\`\`\`${value.language}\n${value.value}\n\`\`\``
  if (isString(value.value)) return value.value.trim()
  return ''
}

/** 文件 URI 换算成本机路径；非法 URI 给 null。 */
export function filePathFromUri(uri: string, server: string): Nullable<string> {
  try {
    return fileURLToPath(uri)
  } catch (error) {
    log.debug('语言服务忽略了非法的诊断 URI。', { error, server, uri })
    return null
  }
}

/** 中止用的错误：`name` 必须是 `AbortError`，调用方按它识别取消。 */
export function abortError(): Error {
  return Object.assign(new Error('语言服务请求已中止。'), { name: 'AbortError' })
}

/** 任何异常取一句可读的说明。 */
export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
