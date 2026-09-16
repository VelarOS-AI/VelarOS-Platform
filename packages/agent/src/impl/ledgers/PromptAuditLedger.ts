// 域：D3 prompt 审计侧信道（宪章 §11 可观测性 / 观测蓝图裁决 D3）。
//
// turn/model span **只放指标 + 请求指纹**（轻、高频、可轮转）；系统提示词全文 / promptSegments /
// capabilityContextAudit 这类**重内容**若要落盘，**只许进旁账本侧信道**（本文件）——一条独立的 append-only
// JSONL 文件，与 span 账本物理平行（数据根 `execution-spans/<sessionId>.prompts.jsonl`），span 用
// `requestFingerprint` 横向关联回本审计记录。
//
// **铁律**：绝不进会话账本（`SessionLedger`）——它是上下文权威、不裁剪长寿命资产；prompt 审计是可裁剪、
// 非上下文权威的调试内容，混进会话账本会撑大 `buildContextEntries`、抢串行写队列、污染「会话 entry 不改」
// 不变量（与 span 账本同理，§2.3）。
//
// **脱敏裁决点（先保守）**：提示词全文可能含密钥态内容（工具注入的凭据、用户粘贴的密文）。当前策略
// = **全文原样落盘**，因访问面只有**本机 debug**（get_debug / agent-lab，均本地文件、不出机）。若将来
// 审计文件要出机（云同步 / 远程诊断）前，须由宿主注入密钥态裁剪层。
//
// 记录是**本地运行时形状，不进 wire**（不注册 kernel-protocol 快照）：跨仓契约锁只管协议面，调试侧信道
// 是宿主内部产物。序列化复用会话账本的规范键序（跨账本字节稳定）+ 尾行容忍读取（崩溃安全）。
import { existsSync } from 'node:fs'
import { type FileHandle, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import type { PromptAuditReadResult, PromptAuditRecord, SpanLedgerWarn } from '../../types/ledgers.js'
import { truncateJsonlToLineCount } from '../../utils/ledgers/jsonl-file'
import { parsePromptAuditText, serializePromptAuditLine } from '../../utils/ledgers/prompt-audit-ledger'

import { SerialWriteQueue } from './SerialWriteQueue'

/**
 * 崩溃安全读取审计侧信道文件。不存在 → 空。逐行解析：首个失败行若是最后一行判为半截尾行（截断标记），
 * 中段失败判不可容忍损坏抛错（与账本同纪律，只承诺尾行容忍）。
 */
export async function readPromptAuditFile(path: string): Promise<PromptAuditReadResult> {
  if (!existsSync(path)) return { records: [], truncatedTail: false }
  const raw = await readFile(path, 'utf-8')
  return parsePromptAuditText(raw, path)
}

/**
 * 一个打开的 prompt 审计侧信道 handle（每会话一文件 append-only）：span scope 工厂在装配了
 * `resolvePromptAuditPath` 时才按会话开一份并缓存复用，没装配就整条审计链降级 no-op。
 *
 * 建出来后必须先 `openHandle()` 才能写。纪律对齐 `ExecutionSpanLedger`：串行写队列 + 每条 fsync + 开档尾行
 * 修复；但更轻——记录是本地形状、无 schema 校验（审计内容态不进 wire）。
 */
export interface PromptAuditLedgerApi {
  /**
   * 开档：建好父目录、文件不存在就建空文件、半截尾行 ftruncate 修掉，最后以 'a' 模式拿到写句柄。
   *
   * 每个实例只该调一次，await 成功后才可以 `append`；失败原样抛出，此账本作废。
   */
  openHandle(): Promise<void>
  /**
   * 追加一条审计记录（系统提示词全文等重内容）：同步入队立即返回，落盘 + fsync 在串行队列里异步完成。
   *
   * 记录原样落盘、不做脱敏（访问面只有本机 debug，见文件头裁决点）；关闭后再 append 抛 `INVARIANT`。
   */
  append(record: PromptAuditRecord): void
  /** 等此刻已入队的写全部落定（不关句柄）；读回审计文件前先调它。 */
  drain(): Promise<void>
  /** 排空写队列再关句柄；幂等，关后本账本不再可写。宿主 dispose 时调。 */
  close(): Promise<void>
}

export class PromptAuditLedger implements PromptAuditLedgerApi {
  private readonly writeQueue = new SerialWriteQueue()
  private appendHandle: Nullable<FileHandle> = null
  private closed = false

  constructor(
    private readonly path: string,
    private readonly warn: SpanLedgerWarn = () => undefined
  ) {}

  public async openHandle(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })

    if (existsSync(this.path)) {
      const read = await readPromptAuditFile(this.path)
      if (read.truncatedTail) {
        // 尾行修复：ftruncate 到最后完整记录的字节边界（只缩短、不重写已提交前缀），后续 append 才安全。
        await truncateJsonlToLineCount(this.path, read.records.length)
        this.warn('prompt audit ledger tail truncated and repaired on open', {
          path: this.path,
          recoveredRecords: read.records.length,
        })
      }
    } else {
      await writeFile(this.path, '')
    }

    this.appendHandle = await open(this.path, 'a')
  }

  public append(record: PromptAuditRecord): void {
    this.assertOpen()
    void this.writeQueue.enqueue(async () => {
      if (!this.appendHandle) {
        throw new AppError('INVARIANT', `prompt 审计账本的追加句柄已经关闭，这条审计记录落不了盘：${this.path}。`)
      }
      await this.appendHandle.write(serializePromptAuditLine(record))
      await this.appendHandle.datasync()
    })
  }

  public drain(): Promise<void> {
    return this.writeQueue.drain()
  }

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
    if (this.closed) throw new AppError('INVARIANT', `prompt 审计账本已关闭，不再接受追加：${this.path}。`)
  }
}
