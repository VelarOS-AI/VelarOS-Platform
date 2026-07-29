// 域：SessionStore 树形账本引擎（宪章 §2 Ring1「SessionStore：pi 式单文件追加 + parentId 树形账本」）。
//
// `SessionStore` 是多会话工厂（create/open/openOrCreate，持注入端口）；`SessionLedger` 是一个打开的
// 会话账本 handle（append/fork/branch/getTree/buildContextEntries/close）。持久化纪律：
//   - 追加写 + 串行写队列（{@link SerialWriteQueue}），每条 append 原子分配树形指针再落盘；
//   - 崩溃安全：每条 fsync；开档时容忍并回写修复半截尾行；append 前 schema 校验，绝不写坏行；
//   - 单写者假设：数据根锁由 host 保证，账本层不造锁。
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { type FileHandle, mkdir, open, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { type SessionEntry, SessionEntrySchema } from '@velaros-ai/agent-protocol'
import { isEmpty } from '@velaros-ai/core'

import { readLedgerFile, serializeLedgerLine, truncateLedgerToEntryCount } from './ledger-file'
import type { SessionEntryDraft, SessionLedgerLocator, SessionLedgerWarn, SessionStoreDeps } from './ports'
import {
  buildContextEntries,
  buildSessionTree,
  pathRootToLeaf,
  resolveCurrentLeafId,
  type SessionTree,
} from './session-tree'
import { SerialWriteQueue } from './write-queue'

/** fork 出新会话账本的工厂：把当前叶谱系原样播种进新文件并打开 handle。 */
type ForkFactory = (newSessionId: string, lineage: readonly SessionEntry[]) => Promise<SessionLedger>

/** 打开一个账本 handle 所需的内部上下文（引擎装配，调用方不见）。 */
interface SessionLedgerContext {
  sessionId: string
  path: string
  entries: SessionEntry[]
  warnings: string[]
  now: () => number
  nextEntryId: () => string
  warn: SessionLedgerWarn
  forkFactory: ForkFactory
  /** 关闭 handle 时回落给工厂，撤销该 path 的「已开档」登记（双开断言用，P1-10）。 */
  releaseHandle: () => void
}

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
        throw new Error(`session ledger already exists and is non-empty: ${sessionId}`)
      }
    }
    return this.seedLedger(sessionId, path, [], [])
  }

  /** 打开既有会话账本；不存在时抛错。开档时容忍并回写修复半截尾行。 */
  public async open(sessionId: string): Promise<SessionLedger> {
    const path = this.locator.resolveLedgerPath(sessionId)
    if (!existsSync(path)) throw new Error(`session ledger not found: ${sessionId}`)
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
      throw new Error(`session ledger already has an open append handle: ${sessionId} (${path})`)
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
        throw new Error(`cannot fork into existing non-empty session ledger: ${newSessionId}`)
      }
    }
    await mkdir(dirname(path), { recursive: true })
    // 谱系原样播种（保留 id/parentId/createdAt），fork 出的会话与源共享历史身份、上下文逐字节等价。
    await writeFile(path, lineage.map(serializeLedgerLine).join(''))
    return this.hydrate(newSessionId, path)
  }
}

/**
 * 一个打开的会话账本 handle。
 *
 * 「当前位置 = 叶子」：内存态 `currentLeaf` 指向最近追加或 branch 选中的 entry；append 以它为父并原子推进，
 * branch 把它移到既有 entry 上（后续 append 就此分叉），fork 把当前谱系复制成新会话。
 */
export class SessionLedger {
  private readonly writeQueue = new SerialWriteQueue()
  private readonly entries: SessionEntry[]
  private readonly warningsList: string[]
  private appendHandle: Nullable<FileHandle> = null
  private currentLeaf: Nullable<string>
  private closed = false

  private constructor(private readonly ctx: SessionLedgerContext) {
    this.entries = ctx.entries
    this.warningsList = ctx.warnings
    this.currentLeaf = resolveCurrentLeafId(ctx.entries)
  }

  /** 引擎内部工厂：构建 handle 并打开 append FileHandle（'a' 模式，写恒追加至末尾）。 */
  public static async openHandle(ctx: SessionLedgerContext): Promise<SessionLedger> {
    const ledger = new SessionLedger(ctx)
    ledger.appendHandle = await open(ctx.path, 'a')
    return ledger
  }

  get sessionId(): string {
    return this.ctx.sessionId
  }

  /** 当前叶子 id（当前位置）；空账本为 null。 */
  get currentLeafId(): Nullable<string> {
    return this.currentLeaf
  }

  /** 开档以来累积的非致命告警（尾行修复等）。 */
  get warnings(): readonly string[] {
    return this.warningsList
  }

  /**
   * 追加一条 entry：引擎在串行写内原子分配 id / parentId(=当前叶子) / createdAt，schema 校验后落盘并推进叶子。
   */
  public append(draft: SessionEntryDraft): Promise<SessionEntry> {
    this.assertOpen()
    return this.writeQueue.enqueue(async () => {
      const entry = this.materializeEntry(draft)
      await this.writeLine(entry)
      this.entries.push(entry)
      this.currentLeaf = entry.id
      return entry
    })
  }

  /**
   * 把当前位置移到既有 entry 上，后续 append 就此分叉出旁支；entry 不存在时抛错。
   *
   * **入写队列**（P1-10）：branch 改的 `currentLeaf` 正是 append 取父的字段。若 branch 同步执行、append 排队，
   * 二者时序反转会让排队中的 append 挂到 branch 后的叶子上（分叉错位）。入队保证「append/branch 按提交序生效」。
   */
  public branch(entryId: string): Promise<void> {
    this.assertOpen()
    return this.writeQueue.enqueue(async () => {
      if (!this.entries.some((entry) => entry.id === entryId)) {
        throw new Error(`cannot branch: entry ${entryId} not found in session ${this.ctx.sessionId}`)
      }
      this.currentLeaf = entryId
    })
  }

  /**
   * 把当前叶子的谱系（根→当前叶）复制成一个新会话账本并打开其 handle。
   *
   * 谱系快照在写队列内捕获（P1-10）：与在途 append/branch 不交错，fork 出的历史与提交序一致。
   */
  public fork(newSessionId: string): Promise<SessionLedger> {
    this.assertOpen()
    return this.writeQueue.enqueue(() => {
      const lineage = pathRootToLeaf(this.entries, this.currentLeaf)
      return this.ctx.forkFactory(newSessionId, lineage)
    })
  }

  /** 整棵会话树投影（根 / 按 id 节点 / 叶子集合）。 */
  public getTree(): SessionTree {
    return buildSessionTree(this.entries)
  }

  /** 全部 entry（追加序快照拷贝）。 */
  public getEntries(): readonly SessionEntry[] {
    return [...this.entries]
  }

  /** 从当前叶子回溯到根、尊重 CompactionEntry 边界拼出的上下文序列。 */
  public buildContextEntries(): SessionEntry[] {
    return buildContextEntries(this.entries, this.currentLeaf)
  }

  /** 排空写队列并关闭 FileHandle；幂等。关闭后撤销该 path 的开档登记（双开断言，P1-10）。 */
  public async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.writeQueue.drain()
    if (this.appendHandle) {
      await this.appendHandle.close()
      this.appendHandle = null
    }
    this.ctx.releaseHandle()
  }

  private materializeEntry(draft: SessionEntryDraft): SessionEntry {
    const candidate = {
      ...draft,
      id: this.ctx.nextEntryId(),
      parentId: this.currentLeaf,
      createdAt: this.ctx.now(),
    }
    // append 前校验：schema 不过即抛，绝不把坏行写进账本。
    return SessionEntrySchema.parse(candidate)
  }

  private async writeLine(entry: SessionEntry): Promise<void> {
    if (!this.appendHandle) throw new Error(`session ledger ${this.ctx.sessionId} append handle is closed`)
    await this.appendHandle.write(serializeLedgerLine(entry))
    await this.appendHandle.datasync() // 崩溃安全：每条落盘后 fsync 数据页
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`session ledger ${this.ctx.sessionId} is closed`)
  }
}
