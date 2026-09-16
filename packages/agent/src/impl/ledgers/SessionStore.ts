// 域：SessionStore 树形账本引擎（宪章 §2 Ring1「SessionStore：pi 式单文件追加 + parentId 树形账本」）。
//
// `SessionStore` 是多会话工厂（create/open/openOrCreate，持注入端口）；`SessionLedger` 是一个打开的
// 会话账本 handle（append/fork/branch/getTree/buildContextEntries/close）。持久化纪律：
//   - 追加写 + 串行写队列（{@link SerialWriteQueue}），每条 append 原子分配树形指针再落盘；
//   - 崩溃安全：每条 fsync；开档时容忍并回写修复半截尾行；append 前 schema 校验，绝不写坏行；
//   - 单写者假设：数据根锁由 host 保证，账本层不造锁。
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { SessionLedgerLocator, SessionStoreDeps } from '../../contract/requires.js'
import type { SessionEntry } from '../../types/agent.js'
import type { SessionLedgerContext, SessionLedgerWarn } from '../../types/ledgers.js'
import { readLedgerFile, serializeLedgerLine, truncateLedgerToEntryCount } from '../../utils/ledgers/ledger-file'

import { SessionLedger } from './SessionLedger'

/**
 * 多会话账本工厂。
 *
 * 只认注入端口，不直读 app 路径：账本文件位置一律经 {@link SessionLedgerLocator} 解析。
 */
export class SessionStore {
  private readonly locator: SessionLedgerLocator
  private readonly now: () => number
  private readonly nextEntryId: () => string
  private readonly warn: SessionLedgerWarn
  /** 当前持有 append handle 的账本文件路径集合（双开断言，P1-10）：同一文件不得同时开两个 append handle。 */
  private readonly openLedgerPaths = new Set<string>()

  constructor(deps: SessionStoreDeps) {
    this.locator = deps.locator
    this.now = deps.now ?? (() => Date.now())
    this.nextEntryId = deps.nextEntryId ?? (() => randomUUID())
    this.warn = deps.warn ?? (() => undefined)
  }

  /** 新建会话账本；同 id 已有非空账本时抛错（避免覆盖既有会话）。 */
  public async create(sessionId: string): Promise<SessionLedger> {
    const path = this.locator.resolveLedgerPath(sessionId)
    if (existsSync(path)) {
      const existing = await readLedgerFile(path)
      if (!isEmpty(existing.entries)) {
        throw new AppError('INVARIANT', `session ledger already exists and is non-empty: ${sessionId}`)
      }
    }
    return this.seedLedger(sessionId, path, [], [])
  }

  /** 打开既有会话账本；不存在时抛错。开档时容忍并回写修复半截尾行。 */
  public async open(sessionId: string): Promise<SessionLedger> {
    const path = this.locator.resolveLedgerPath(sessionId)
    if (!existsSync(path)) throw new AppError('NOT_FOUND', `session ledger not found: ${sessionId}`, undefined, {
        sessionId,
      })
    return this.hydrate(sessionId, path)
  }

  /** 存在则打开、不存在则新建。 */
  public async openOrCreate(sessionId: string): Promise<SessionLedger> {
    const path = this.locator.resolveLedgerPath(sessionId)
    if (!existsSync(path)) return this.create(sessionId)
    return this.hydrate(sessionId, path)
  }

  private async hydrate(sessionId: string, path: string): Promise<SessionLedger> {
    const read = await readLedgerFile(path)
    const warnings: string[] = []
    if (read.truncatedTail) {
      // 尾行修复（P1-3）：ftruncate 到最后一条完整行的字节偏移 + fsync——**只缩短文件、不触已提交字节**。
      // 旧实现是「读全量 → writeFile 整文件重写」，崩在重写中途会抹掉已 fsync 的完整后缀；ftruncate O(1) 无此风险。
      await truncateLedgerToEntryCount(path, read.entries.length)
      const message = 'session ledger tail truncated and repaired on open'
      warnings.push(message)
      this.warn(message, { sessionId, path, recoveredEntries: read.entries.length })
    }
    return this.seedLedger(sessionId, path, read.entries, warnings)
  }

  private async seedLedger(
    sessionId: string,
    path: string,
    entries: SessionEntry[],
    warnings: string[]
  ): Promise<SessionLedger> {
    await mkdir(dirname(path), { recursive: true })
    if (!existsSync(path)) await writeFile(path, '')
    // 双开断言（P1-10）：同一账本文件已持有 append handle 时拒绝再开——两个 'a' 模式 handle 并发写会交错撕裂行。
    if (this.openLedgerPaths.has(path)) {
      throw new AppError('INVARIANT', `session ledger already has an open append handle: ${sessionId} (${path})`)
    }
    this.openLedgerPaths.add(path)
    const context: SessionLedgerContext = {
      sessionId,
      path,
      entries,
      warnings,
      now: this.now,
      nextEntryId: this.nextEntryId,
      warn: this.warn,
      forkFactory: (newSessionId, lineage) => this.forkInto(newSessionId, lineage),
      releaseHandle: () => this.openLedgerPaths.delete(path),
    }
    try {
      return await SessionLedger.openHandle(context)
    } catch (error) {
      this.openLedgerPaths.delete(path) // 开档失败要回滚登记，否则该 path 被永久判为「已开」
      throw error
    }
  }

  private async forkInto(
    newSessionId: string,
    lineage: readonly SessionEntry[]
  ): Promise<SessionLedger> {
    const path = this.locator.resolveLedgerPath(newSessionId)
    if (existsSync(path)) {
      const existing = await readLedgerFile(path)
      if (!isEmpty(existing.entries)) {
        throw new AppError('INVARIANT', `cannot fork into existing non-empty session ledger: ${newSessionId}`)
      }
    }
    await mkdir(dirname(path), { recursive: true })
    // 谱系原样播种（保留 id/parentId/createdAt），fork 出的会话与源共享历史身份、上下文逐字节等价。
    await writeFile(path, lineage.map(serializeLedgerLine).join(''))
    return this.hydrate(newSessionId, path)
  }
}


