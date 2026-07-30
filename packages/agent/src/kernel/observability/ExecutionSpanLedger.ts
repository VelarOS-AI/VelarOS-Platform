// 域：执行观测账本写入器（宪章 §14「执行账本」侧；旁账本，独立于会话账本脊柱）。
//
// 一个打开的执行账本 handle：`append` 把一条已完成 span 入串行写队列（{@link SerialWriteQueue}），落盘 +
// fsync；`close` 排空并关句柄。纪律对齐会话账本 `SessionLedger`（追加写 / 每条 fsync / 开档尾行修复 / 单写者
// 假设由 host 数据根锁保证），但**刻意更轻**：span 已在 recorder 侧完成 schema 校验与身份分配，账本只负责
// 字节持久化，不再分配树形指针、不做 fork/branch——观测数据可裁剪、非上下文权威。
import { existsSync } from 'node:fs'
import { type FileHandle, mkdir, open, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import type { ExecutionSpan } from '../../protocol'
import { truncateJsonlToLineCount } from '../jsonl-file'
import { SerialWriteQueue } from '../session-store'

import { readSpanLedgerFile, serializeSpanLine } from './execution-ledger-file'

/** 非致命恢复事件回落（尾行截断 / 开档修复等）。缺省时事件仅进账本 handle 的内存 warnings。 */
export type SpanLedgerWarn = (message: string, detail: Record<string, unknown>) => void

/**
 * 一个打开的执行账本 handle。
 *
 * `append` 同步入队（sink 友好：产 span 侧零 await），实际写盘在串行队列内异步落定；调用方用 `drain` / `close`
 * 等待落盘。开档时容忍并回写修复半截尾行。
 */
export class ExecutionSpanLedger {
  private readonly writeQueue = new SerialWriteQueue()
  private readonly warningsList: string[] = []
  private appendHandle: Nullable<FileHandle> = null
  private closed = false

  private constructor(
    private readonly path: string,
    private readonly warn: SpanLedgerWarn
  ) {}

  /** 打开（或新建）指定路径的执行账本；开档修复半截尾行，句柄以 'a' 模式打开（写恒追加至末尾）。 */
  public static async open(path: string, warn: SpanLedgerWarn = () => undefined): Promise<ExecutionSpanLedger> {
    const ledger = new ExecutionSpanLedger(path, warn)
    await mkdir(dirname(path), { recursive: true })

    if (existsSync(path)) {
      const read = await readSpanLedgerFile(path)
      if (read.truncatedTail) {
        // 尾行修复：ftruncate 到最后完整 span 的字节边界（只缩短、不重写已提交前缀），后续 append 才安全。
        await truncateJsonlToLineCount(path, read.spans.length)
        const message = 'execution span ledger tail truncated and repaired on open'
        ledger.warningsList.push(message)
        ledger.warn(message, { path, recoveredSpans: read.spans.length })
      }
    } else {
      await writeFile(path, '')
    }

    ledger.appendHandle = await open(path, 'a')
    return ledger
  }

  /** 开档以来累积的非致命告警（尾行修复等）。 */
  get warnings(): readonly string[] {
    return this.warningsList
  }

  /**
   * 追加一条已完成 span（同步入队，异步落定）。
   *
   * span 由 recorder 保证已 schema 校验、身份/时序完整，账本只做字节持久化。关闭后再 append 抛错。
   */
  public append(span: ExecutionSpan): void {
    this.assertOpen()
    void this.writeQueue.enqueue(async () => {
      if (!this.appendHandle) throw new AppError('INVARIANT', `execution span ledger append handle is closed: ${this.path}`)
      await this.appendHandle.write(serializeSpanLine(span))
      await this.appendHandle.datasync() // 崩溃安全：每条落盘后 fsync 数据页
    })
  }

  /** 等待当前所有已入队写落定（不关句柄）。 */
  public drain(): Promise<void> {
    return this.writeQueue.drain()
  }

  /** 排空写队列并关闭 FileHandle；幂等。 */
  public async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.writeQueue.drain()
    if (this.appendHandle) {
      await this.appendHandle.close()
      this.appendHandle = null
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new AppError('INVARIANT', `execution span ledger is closed: ${this.path}`)
  }
}
