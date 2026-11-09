import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, extname } from 'node:path'

import { AppError } from '../error'

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
  const snapshot = snapshotErrors(record)
  return JSON.stringify(snapshot, (_key, value: unknown) => {
    if (typeof value === 'bigint' || typeof value === 'symbol') return String(value)
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
      if (value instanceof Error) return snapshotErrors(value)
    }
    return value
  })
}

/** 在 toJSON 之前固定嵌套错误诊断；未知类和带访问器的普通容器保持原序列化行为。 */
function snapshotErrors(value: unknown, copies = new WeakMap<object, unknown>()): unknown {
  if (!value || typeof value !== 'object') return value
  if (copies.has(value)) return copies.get(value)
  const error = value instanceof Error
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (!error && !array && prototype !== Object.prototype && prototype !== null) return value
  const descriptors = Object.getOwnPropertyDescriptors(value)
  // 不为遍历数据容器调用 getter；JSON.stringify 仍按原先规则处理这些容器。
  if (!error && Object.values(descriptors).some((descriptor) => !('value' in descriptor)))
    return value
  const snapshot: unknown[] | Record<string, unknown> = array
    ? []
    : Object.create(error ? null : prototype)
  if (array) snapshot.length = value.length
  copies.set(value, snapshot)
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor) || (error && key === 'toJSON')) continue
    Object.defineProperty(snapshot, key, {
      value: snapshotErrors(descriptor.value, copies),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  if (error) {
    // Error 的固定诊断字段沿用原读取合同，其余属性只读取数据描述符。
    Object.assign(snapshot, {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: snapshotErrors(value.cause, copies),
    })
    const errors = descriptors.errors
    if (errors && 'value' in errors)
      Object.defineProperty(snapshot, 'errors', {
        value: snapshotErrors(errors.value, copies),
        enumerable: true,
        configurable: true,
        writable: true,
      })
  }
  return snapshot
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
      if (closed) return Promise.reject(new AppError('CLOSED', 'File log transport is closed.'))
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
