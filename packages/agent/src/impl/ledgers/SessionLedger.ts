import type { FileHandle } from 'node:fs/promises'
import { open } from 'node:fs/promises'

import { AppError } from '@velaros-ai/core/error'

import type { SessionEntry } from '../../types/agent.js'
import type { SessionEntryDraft, SessionLedgerApi, SessionLedgerContext, SessionTree } from '../../types/ledgers.js'
import { serializeLedgerLine } from '../../utils/ledgers/ledger-file'
import { buildContextEntries, buildSessionTree, pathRootToLeaf, resolveCurrentLeafId } from '../../utils/ledgers/session-tree'
import { SessionEntrySchema } from '../../utils/wire/session'

import { SerialWriteQueue } from './SerialWriteQueue'

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
        throw new AppError(
          'NOT_FOUND',
          `cannot branch: entry ${entryId} not found in session ${this.ctx.sessionId}`,
          undefined,
          { sessionId: this.ctx.sessionId, entryId }
        )
      }
      this.currentLeaf = entryId
    })
  }

  /**
   * 把当前叶子的谱系（根→当前叶）复制成一个新会话账本并打开其 handle。
   *
   * 谱系快照在写队列内捕获（P1-10）：与在途 append/branch 不交错，fork 出的历史与提交序一致。
   */
  public fork(newSessionId: string): Promise<SessionLedgerApi> {
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
    if (!this.appendHandle) throw new AppError('INVARIANT', `session ledger ${this.ctx.sessionId} append handle is closed`)
    await this.appendHandle.write(serializeLedgerLine(entry))
    await this.appendHandle.datasync() // 崩溃安全：每条落盘后 fsync 数据页
  }

  private assertOpen(): void {
    if (this.closed) throw new AppError('INVARIANT', `session ledger ${this.ctx.sessionId} is closed`)
  }
}
