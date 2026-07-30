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

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { truncateJsonlToLineCount } from '../jsonl-file'
import { canonicalJsonStringify, SerialWriteQueue } from '../session-store'

import type { SpanLedgerWarn } from './ExecutionSpanLedger'

const PROMPT_AUDIT_LINE_SEPARATOR = '\n'

/**
 * 一条 prompt 审计记录：一次 provider 请求的重内容快照，靠 `requestFingerprint` 关联回同回合的 model span。
 * 全字段落盘保形（缺席用 null / 空数组），读侧无需分支。
 */
export interface PromptAuditRecord {
  capturedAt: number
  sessionId: string
  runId: string
  /** 关联键：与 model span 的 `requestFingerprint` 同值（缺席用 null）。 */
  requestFingerprint: Nullable<string>
  /** 子 Agent 无界面轮次轴时为 null（对齐 span 侧的确定 turn 语义，此处按调用方传入）。 */
  turn: Nullable<number>
  roleId: Nullable<string>
  model: Nullable<string>
  /** 系统提示词全文（重内容之家；span 侧只留 chars 指标）。 */
  systemPrompt: string
  /** 逐段提示词轨迹（含文本）；内容态由调用方原样传入，审计侧不解释。 */
  promptSegments: readonly unknown[]
  skippedPromptSegments: readonly unknown[]
  capabilityContextAudit: readonly unknown[]
}

/** 序列化一条审计记录成 JSONL 行（规范键序 + 行尾分隔符）。 */
export function serializePromptAuditLine(record: PromptAuditRecord): string {
  return `${canonicalJsonStringify(record)}${PROMPT_AUDIT_LINE_SEPARATOR}`
}

/** 读取审计侧信道文件的结果：记录序列 + 是否发生过尾行截断修复。 */
export interface PromptAuditReadResult {
  records: PromptAuditRecord[]
  truncatedTail: boolean
}

/**
 * 崩溃安全读取审计侧信道文件。不存在 → 空。逐行解析：首个失败行若是最后一行判为半截尾行（截断标记），
 * 中段失败判不可容忍损坏抛错（与账本同纪律，只承诺尾行容忍）。
 */
export async function readPromptAuditFile(path: string): Promise<PromptAuditReadResult> {
  if (!existsSync(path)) return { records: [], truncatedTail: false }
  const raw = await readFile(path, 'utf-8')
  return parsePromptAuditText(raw, path)
}

/** {@link readPromptAuditFile} 的纯文本内核，供 harness 断言单点复用。 */
export function parsePromptAuditText(raw: string, path: string): PromptAuditReadResult {
  const lines = raw.split(PROMPT_AUDIT_LINE_SEPARATOR)
  while (!isEmpty(lines) && isEmpty(lines[lines.length - 1])) lines.pop()

  const records: PromptAuditRecord[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = tryParsePromptAuditLine(lines[index])
    if (parsed) {
      records.push(parsed)
      continue
    }
    if (index === lines.length - 1) return { records, truncatedTail: true }
    throw new AppError('INVARIANT', 
      `prompt audit ledger corrupted at interior line ${index + 1} of ${lines.length} (${path})`
    )
  }
  return { records, truncatedTail: false }
}

function tryParsePromptAuditLine(line: string): Nullable<PromptAuditRecord> {
  try {
    const json = JSON.parse(line) as unknown
    return isValidPromptAuditRecord(json) ? json : null
  } catch {
    return null // arch-guard:silent-catch-ok 半截/非法行由调用方按位置判尾行容忍或中段抛错
  }
}

function isValidPromptAuditRecord(value: unknown): value is PromptAuditRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.capturedAt === 'number' &&
    typeof record.sessionId === 'string' &&
    typeof record.runId === 'string' &&
    typeof record.systemPrompt === 'string' &&
    Array.isArray(record.promptSegments)
  )
}

/**
 * 一个打开的 prompt 审计侧信道 handle（每会话一文件 append-only）。
 *
 * 纪律对齐 {@link ExecutionSpanLedger}：串行写队列 + 每条 fsync + 开档尾行修复；但更轻——记录是本地形状、
 * 无 schema 校验（审计内容态不进 wire）。`append` 同步入队（产 span 侧零 await），`drain`/`close` 供排空。
 */
export class PromptAuditLedger {
  private readonly writeQueue = new SerialWriteQueue()
  private appendHandle: Nullable<FileHandle> = null
  private closed = false

  private constructor(
    private readonly path: string,
    private readonly warn: SpanLedgerWarn
  ) {}

  public static async open(
    path: string,
    warn: SpanLedgerWarn = () => undefined
  ): Promise<PromptAuditLedger> {
    const ledger = new PromptAuditLedger(path, warn)
    await mkdir(dirname(path), { recursive: true })

    if (existsSync(path)) {
      const read = await readPromptAuditFile(path)
      if (read.truncatedTail) {
        // 尾行修复：ftruncate 到最后完整记录的字节边界（只缩短、不重写已提交前缀），后续 append 才安全。
        await truncateJsonlToLineCount(path, read.records.length)
        ledger.warn('prompt audit ledger tail truncated and repaired on open', {
          path,
          recoveredRecords: read.records.length,
        })
      }
    } else {
      await writeFile(path, '')
    }

    ledger.appendHandle = await open(path, 'a')
    return ledger
  }

  public append(record: PromptAuditRecord): void {
    this.assertOpen()
    void this.writeQueue.enqueue(async () => {
      if (!this.appendHandle) {
        throw new AppError('INVARIANT', `prompt audit ledger append handle is closed: ${this.path}`)
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
    if (this.closed) throw new AppError('INVARIANT', `prompt audit ledger is closed: ${this.path}`)
  }
}
