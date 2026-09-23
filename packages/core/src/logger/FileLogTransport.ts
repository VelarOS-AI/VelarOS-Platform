import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, extname } from 'node:path'

import type { LogLevel, LogRecord, LogTransport } from './types'

/** Node 文件日志：宿主决定路径、级别与记录范围。 */
export interface FileLogTransportOptions {
  /** 运行时中的唯一 transport 标识。 */
  id?: string
  /** 文件基名；写入时按记录的本地日期加后缀。 */
  filePath: string
  /** 最低日志级别，由日志运行时过滤。 */
  minLevel?: LogLevel
  /** 宿主对记录的额外筛选。 */
  accepts?: LogTransport['accepts']
}

/** 在扩展名前加记录的本地日期，跨日记录自动分文件。 */
export function resolveDatedLogFilePath(filePath: string, timestamp = new Date()): string {
  const date = [
    timestamp.getFullYear(),
    String(timestamp.getMonth() + 1).padStart(2, '0'),
    String(timestamp.getDate()).padStart(2, '0'),
  ].join('-')
  const extension = extname(filePath)
  return extension
    ? `${filePath.slice(0, -extension.length)}-${date}${extension}`
    : `${filePath}-${date}`
}

/** 将记录固化为一行 JSON，错误、BigInt 和循环引用均可写入。 */
function serializeRecord(record: LogRecord): string {
  const seen = new WeakSet<object>()
  const snapshot =
    record.kind === 'message' && record.error instanceof Error
      ? { ...record, error: errorRecord(record.error) }
      : record
  return JSON.stringify(snapshot, (_key, value: unknown) => {
    if (typeof value === 'bigint' || typeof value === 'symbol') return String(value)
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
      if (value instanceof Error) return errorRecord(value)
    }
    return value
  })
}

/** 固定错误的诊断字段，避免自定义 toJSON 丢掉堆栈与原因。 */
function errorRecord(error: Error): Record<string, unknown> {
  return {
    ...error,
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause,
  }
}

/**
 * 串行追加 JSONL；一次失败不会阻断后续写入，flush 报告此前尚未报告的写入失败。
 * dispose 同步停止接收新记录，并等待已接受记录写完；重复关闭共用同一回执。
 */
export function createFileLogTransport(options: FileLogTransportOptions): LogTransport {
  let directoryReady = false
  let closed = false
  let queue = Promise.resolve()
  let failure: { error: unknown } | undefined
  let disposal: Promise<void> | undefined

  const flush = (): Promise<void> =>
    queue.then(() => {
      const pending = failure
      failure = undefined
      if (pending) throw pending.error
    })

  return {
    id: options.id ?? 'file',
    minLevel: options.minLevel,
    accepts: options.accepts,
    write(record): Promise<void> {
      if (closed) return Promise.reject(new Error('File log transport is closed.'))
      // 调用时固定内容，排队期间调用方修改上下文不会改变已经提交的日志。
      let write: () => Promise<void>
      try {
        const filePath = resolveDatedLogFilePath(options.filePath, record.timestamp)
        const line = `${serializeRecord(record)}\n`
        write = async () => {
          if (!directoryReady) {
            await mkdir(dirname(filePath), { recursive: true })
            directoryReady = true
          }
          await appendFile(filePath, line, 'utf8')
        }
      } catch (error) {
        write = async () => {
          throw error
        }
      }
      const operation = queue.then(write)
      queue = operation.catch((error: unknown) => {
        directoryReady = false
        failure ??= { error }
      })
      return operation
    },
    flush,
    dispose(): Promise<void> {
      closed = true
      disposal ??= flush()
      return disposal
    },
  }
}
