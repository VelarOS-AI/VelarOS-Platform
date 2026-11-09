import type {
  ContextMetadata,
  ContextRecord,
  ContextRecordPage,
  ContextRecordQuery,
  ContextRecordSelection,
  ContextRecordSnapshot,
  ContextState,
  ContextStorage,
} from '@velaros-ai/context'
import { ContextLimits } from '@velaros-ai/context'
import { AppError } from '@velaros-ai/core/error'

/** 当前会话元数据的短暂提交缓冲，原文沿用原对象存储。 */
export interface ContextPatchStoreApi extends ContextStorage {
  /** 读取当前暂存状态。 */
  load(sessionId: string): Promise<Nullable<ContextState>>
  /** 在暂存状态上执行既有操作的版本校验。 */
  compareAndSwap(sessionId: string, expectedVersion: number, state: ContextState): Promise<boolean>
  /** 不可变正文继续写入原存储，未发布对象不获得可见引用。 */
  put(sessionId: string, text: string): Promise<string>
  /** 仅读取目标会话正文。 */
  get(sessionId: string, objectId: string): Promise<Nullable<string>>
  /** 关闭提交缓冲，不关闭共享存储。 */
  close(): Promise<void>
  /** 将整组通过校验的元数据一次发布，冲突时整组不生效。 */
  commit(signal: AbortSignal): Promise<boolean>
}

/** 仅上下文元数据具备原子发布；不包含脚本执行或外部效果。 */
export class ContextPatchStore implements ContextPatchStoreApi {
  private state: ContextState
  private closed = false
  public constructor(
    private readonly id: string,
    private readonly storage: ContextStorage,
    private readonly base: ContextState
  ) {
    this.state = structuredClone(base)
  }
  private check(sessionId: string): void {
    if (this.closed || sessionId !== this.id)
      throw new AppError('CLOSED', '上下文提交缓冲已关闭或引用越界')
  }
  public async allocateReferenceId(sessionId: string): Promise<string> {
    this.check(sessionId)
    return this.storage.allocateReferenceId(sessionId)
  }
  public async load(sessionId: string) {
    this.check(sessionId)
    return structuredClone(this.state)
  }
  public async loadMetadata(sessionId: string): Promise<ContextMetadata> {
    this.check(sessionId)
    const { records: _records, ...metadata } = this.state
    return structuredClone(metadata)
  }
  public async selectSnapshot(
    sessionId: string,
    selections: readonly ContextRecordSelection[]
  ): Promise<ContextRecordSnapshot> {
    this.check(sessionId)
    const selected = new Map<number, ContextRecord>()
    for (const selection of selections) {
      let records = this.state.records.filter(
        (record) =>
          (selection.after === undefined || record.sequence > selection.after) &&
          (selection.through === undefined || record.sequence <= selection.through) &&
          (selection.sequence === undefined || record.sequence === selection.sequence) &&
          (selection.title === undefined || record.title === selection.title) &&
          (selection.titlePrefix === undefined || record.title.startsWith(selection.titlePrefix)) &&
          (selection.titleSuffix === undefined || record.title.endsWith(selection.titleSuffix)) &&
          (selection.refId === undefined || record.ref.id === selection.refId) &&
          (selection.kind === undefined || record.kind === selection.kind)
      )
      if (selection.latestPerTitle)
        records = [...new Map(records.map((record) => [record.title, record])).values()]
      if (selection.latest) records = records.slice(-1)
      if (selection.last !== undefined) records = records.slice(-selection.last)
      if (selection.first !== undefined) records = records.slice(0, selection.first)
      for (const record of records) selected.set(record.sequence, record)
    }
    return {
      metadata: await this.loadMetadata(sessionId),
      records: structuredClone([...selected.values()].sort((a, b) => a.sequence - b.sequence)),
    }
  }
  public async records(sessionId: string, query: ContextRecordQuery): Promise<ContextRecordPage> {
    const selected = await this.selectSnapshot(sessionId, [query])
    const limit = query.limit ?? ContextLimits.recordPage
    const items = selected.records.slice(0, limit)
    return { items, nextAfter: selected.records.length > limit ? items.at(-1)!.sequence : null }
  }
  public async compareAndSwapMetadata(
    sessionId: string,
    expectedVersion: number,
    metadata: ContextMetadata,
    additions: ReadonlyArray<Omit<ContextRecord, 'sequence'>> = []
  ): Promise<boolean> {
    this.check(sessionId)
    if (metadata.version !== expectedVersion + 1)
      throw new AppError('VALIDATION', '上下文提交版本无效')
    for (const record of additions) {
      if (record.objectId && !(await this.storage.has(sessionId, record.objectId)))
        throw new AppError('NOT_FOUND', '上下文正文不存在')
    }
    this.check(sessionId)
    if (this.state.version !== expectedVersion) return false
    const records = [...this.state.records]
    for (const entry of additions) {
      if (
        entry.ref.sessionId !== sessionId ||
        records.some((record) => record.ref.id === entry.ref.id) ||
        entry.sources.some(
          (source) =>
            source.sessionId !== sessionId || !records.some((record) => record.ref.id === source.id)
        )
      )
        throw new AppError('CONFLICT', '上下文目录引用无效')
      records.push({ ...entry, sequence: (records.at(-1)?.sequence ?? 0) + 1 })
    }
    this.state = structuredClone({ ...metadata, records })
    return true
  }
  public async appendRecord(
    sessionId: string,
    record: Omit<ContextRecord, 'sequence'>
  ): Promise<ContextRecord> {
    for (;;) {
      const metadata = await this.loadMetadata(sessionId)
      if (
        await this.compareAndSwapMetadata(
          sessionId,
          metadata.version,
          { ...metadata, version: metadata.version + 1 },
          [record]
        )
      )
        return structuredClone(this.state.records.at(-1)!)
    }
  }
  public async has(sessionId: string, objectId: string): Promise<boolean> {
    this.check(sessionId)
    return this.storage.has(sessionId, objectId)
  }
  public async compareAndSwap(sessionId: string, expectedVersion: number, state: ContextState) {
    this.check(sessionId)
    if (this.state.version !== expectedVersion) return false
    this.state = structuredClone(state)
    return true
  }
  public async put(sessionId: string, text: string) {
    this.check(sessionId)
    return this.storage.put(sessionId, text)
  }
  public async get(sessionId: string, objectId: string): Promise<Nullable<string>> {
    this.check(sessionId)
    return this.storage.get(sessionId, objectId)
  }
  public async close(): Promise<void> {
    this.closed = true
  }
  public async commit(signal: AbortSignal): Promise<boolean> {
    this.check(this.id)
    signal.throwIfAborted()
    const committed = await this.storage.compareAndSwap(this.id, this.base.version, {
      ...this.state,
      version: this.base.version + 1,
    })
    this.closed = true
    return committed
  }
}
