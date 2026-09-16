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

import type { ExecutionSpan } from '../../types/agent.js'
import type { SpanLedgerWarn } from '../../types/ledgers.js'
import { readSpanLedgerFile, serializeSpanLine } from '../../utils/ledgers/execution-ledger-file'
import { truncateJsonlToLineCount } from '../../utils/ledgers/jsonl-file'

import { SerialWriteQueue } from './SerialWriteQueue'

/**
 * 一个打开的执行账本 handle（每会话一文件 append-only）：span scope 工厂按会话惰性开一份并缓存复用。
 *
 * 建出来后必须先 `openHandle()` 才能写——建对象只记住路径与告警回落，开档（建目录、修尾行、拿 'a' 句柄）是异步的。
 * `append` 同步入队（sink 友好：产 span 侧零 await），实际写盘在串行队列内异步落定；调用方用 `drain` / `close`
 * 等待落盘。
 */
export interface ExecutionSpanLedgerApi {
  /** 开档以来累积的非致命告警（目前只有尾行修复一种）；探针与测试据此确认发生过恢复。 */
  readonly warnings: readonly string[]
  /**
   * 开档：建好父目录、文件不存在就建空文件、半截尾行 ftruncate 修掉，最后以 'a' 模式拿到写句柄。
   *
   * 每个实例只该调一次，调用方 await 成功后才可以 `append`；失败（权限、磁盘）原样抛出，此账本作废。
   */
  openHandle(): Promise<void>
  /**
   * 追加一条**已收敛**的 span：同步入队立即返回，真正落盘 + fsync 在串行队列里异步完成。
   *
   * span 的 schema 校验与身份分配已由录制器做完，账本只负责字节；关闭后再 append 抛 `INVARIANT`。
   */
  append(span: ExecutionSpan): void
  /** 等此刻已入队的写全部落定（不关句柄）；探针读回账本文件前先调它，否则可能读到还没落盘的内容。 */
  drain(): Promise<void>
  /** 排空写队列再关句柄；幂等，关后本账本不再可写。宿主 dispose 时调。 */
  close(): Promise<void>
}

export class ExecutionSpanLedger implements ExecutionSpanLedgerApi {
  private readonly writeQueue = new SerialWriteQueue()
  private readonly warningsList: string[] = []
  private appendHandle: Nullable<FileHandle> = null
  private closed = false

  constructor(
    private readonly path: string,
    private readonly warn: SpanLedgerWarn = () => undefined
  ) {}

  public async openHandle(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })

    if (existsSync(this.path)) {
      const read = await readSpanLedgerFile(this.path)
      if (read.truncatedTail) {
        // 尾行修复：ftruncate 到最后完整 span 的字节边界（只缩短、不重写已提交前缀），后续 append 才安全。
        await truncateJsonlToLineCount(this.path, read.spans.length)
        const message = 'execution span ledger tail truncated and repaired on open'
        this.warningsList.push(message)
        this.warn(message, { path: this.path, recoveredSpans: read.spans.length })
      }
    } else {
      await writeFile(this.path, '')
    }

    this.appendHandle = await open(this.path, 'a')
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
      if (!this.appendHandle) throw new AppError('INVARIANT', `执行 span 账本的追加句柄已经关闭，这条 span 落不了盘：${this.path}。`)
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
    if (this.closed) throw new AppError('INVARIANT', `执行 span 账本已关闭，不再接受追加：${this.path}。`)
  }
}
