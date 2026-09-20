import type { ContextAppend, ContextContent, ContextProjection, ContextQuery, ContextReadRange, ContextRecord, ContextRef, ContextSearchPage, ContextSnapshot, ContextState, NoteWrite, WorkingSetChange, WorkingSetCommit } from '../contract/context.js'
import { ContextLimits } from '../contract/context.js'
import type { ContextRuntime } from '../interface/provides.js'
import type { ContextRuntimeOptions } from '../interface/requires.js'
import { boundedInteger, contextFailure, emptyContextState, sameContextRef } from '../utils/state.js'

/** 上下文的单一会话视图；并发提交由存储端口的 CAS 保证。 */
export class SessionContext implements ContextRuntime {
  public constructor(private readonly options: ContextRuntimeOptions) {
    if (/^\["kernel-invocation(?:-index)?",/.test(options.sessionId)) throw contextFailure('INVALID_SESSION', '会话身份使用了内部保留范围。')
    if (!options.sessionId.trim()) throw contextFailure('INVALID_SESSION', '会话标识不能为空。')
  }
  private async state(): Promise<ContextState> {
    return await this.options.storage.load(this.options.sessionId) ?? emptyContextState()
  }
  private record(state: ContextState, ref: ContextRef): ContextRecord {
    if (ref.sessionId !== this.options.sessionId) throw contextFailure('SCOPE_MISMATCH', '引用不在本会话作用域内。')
    const record = state.records.find(item => sameContextRef(item.ref, ref))
    if (!record) throw contextFailure('REF_NOT_FOUND', '原始记录不存在。')
    return record
  }
  public async inspect(): Promise<ContextSnapshot> {
    const state = await this.state()
    const latest = [...state.records].reverse().find(record => record.kind === 'user')
    return { revision: state.workingSet.revision, cursor: state.records.length, items: state.workingSet.items, protected: latest ? [latest.ref] : [] }
  }
  public async append(input: ContextAppend, signal?: AbortSignal): Promise<ContextRecord> {
    signal?.throwIfAborted()
    if (typeof input.body !== 'string' || input.body.length > ContextLimits.objectChars) throw contextFailure('OBJECT_TOO_LARGE', '正文必须在单对象上限以内。')
    const ref = { sessionId: this.options.sessionId, id: crypto.randomUUID() }
    const objectId = await this.options.storage.put(this.options.sessionId, input.body)
    for (;;) {
      const state = await this.state()
      for (const source of input.sources ?? []) this.record(state, source)
      const record: ContextRecord = { ref, sequence: state.records.length + 1, kind: input.kind, title: input.title ?? '', objectId, chars: input.body.length, sources: input.sources ?? [], createdAt: new Date().toISOString() }
      signal?.throwIfAborted()
      if (await this.options.storage.compareAndSwap(this.options.sessionId, state.version, { ...state, version: state.version + 1, records: [...state.records, record] })) return record
    }
  }
  public write(note: NoteWrite, signal?: AbortSignal): Promise<ContextRecord> {
    if (note.kind !== 'note' && note.kind !== 'checkpoint') throw contextFailure('INVALID_NOTE_KIND', '模型材料只能是笔记或工作检查点。')
    return this.append(note, signal)
  }
  public async read(ref: ContextRef, range: ContextReadRange = {}): Promise<ContextContent> {
    const record = this.record(await this.state(), ref)
    const text = await this.options.storage.get(this.options.sessionId, record.objectId)
    if (text === null) throw contextFailure('OBJECT_MISSING', '记录的原始正文不可用。')
    const offset = boundedInteger(range.offset ?? 0, text.length)
    const limit = boundedInteger(range.limit ?? ContextLimits.readChars, ContextLimits.readChars)
    return { record, text: text.slice(offset, offset + limit), offset, totalChars: text.length }
  }
  public async search(query: ContextQuery): Promise<ContextSearchPage> {
    const state = await this.state()
    const offset = boundedInteger(query.offset ?? 0, Number.MAX_SAFE_INTEGER)
    const limit = boundedInteger(query.limit ?? ContextLimits.searchItems, ContextLimits.searchItems)
    if (!limit) throw contextFailure('INVALID_RANGE', '检索页大小必须大于零。')
    const needle = query.query.toLocaleLowerCase()
    const hits = []
    for (const record of state.records) {
      const body = await this.options.storage.get(this.options.sessionId, record.objectId)
      if (body === null) throw contextFailure('OBJECT_MISSING', '检索材料的原文不可用。')
      const match = body.toLocaleLowerCase().indexOf(needle)
      if (match < 0 && !record.title.toLocaleLowerCase().includes(needle)) continue
      hits.push({ ref: record.ref, kind: record.kind, title: record.title, preview: body.slice(Math.max(0, match), Math.max(0, match) + ContextLimits.previewChars) })
      if (hits.length > offset + limit) break
    }
    return { items: hits.slice(offset, offset + limit), nextOffset: hits.length > offset + limit ? offset + limit : null }
  }
  public async replace(change: WorkingSetChange, signal?: AbortSignal): Promise<WorkingSetCommit> {
    boundedInteger(change.baseRevision, Number.MAX_SAFE_INTEGER)
    boundedInteger(change.items.length, ContextLimits.workingSetItems)
    const state = await this.state()
    if (state.workingSet.revision !== change.baseRevision) throw contextFailure('CONTEXT_CONFLICT', '工作集版本已变化，请重新 inspect 后提交。')
    boundedInteger(change.baseCursor, state.records.length)
    if (change.baseCursor < state.workingSet.cursor) throw contextFailure('CURSOR_CONFLICT', '不能使用早于已提交工作集的事件游标。')
    for (const ref of change.items) this.record(state, ref)
    const items = change.items.filter((ref, index) => change.items.findIndex(other => sameContextRef(ref, other)) === index)
    const workingSet = { revision: change.baseRevision + 1, cursor: change.baseCursor, items }
    signal?.throwIfAborted()
    if (!await this.options.storage.compareAndSwap(this.options.sessionId, state.version, { ...state, version: state.version + 1, workingSet })) throw contextFailure('CONTEXT_CONFLICT', '提交期间有新记录到达，请 inspect 后重新提交。')
    return { revision: workingSet.revision, cursor: workingSet.cursor, effective: 'next-model-request' }
  }
  public async project(maxChars: number): Promise<ContextProjection> {
    boundedInteger(maxChars, Number.MAX_SAFE_INTEGER)
    const state = await this.state()
    const latestUser = [...state.records].reverse().find(record => record.kind === 'user')
    const selected = state.records.filter(record => state.workingSet.items.some(ref => sameContextRef(ref, record.ref)) || record === latestUser || (record.sequence > state.workingSet.cursor && record.kind !== 'note' && record.kind !== 'checkpoint' && record.kind !== 'audit'))
    const projectedSize = (record: ContextRecord): number => record === latestUser && record.sequence <= state.workingSet.cursor && !state.workingSet.items.some(ref => sameContextRef(ref, record.ref)) ? Math.min(record.chars, ContextLimits.inputAnchorChars) : record.chars
    const chars = selected.reduce((sum, record) => sum + projectedSize(record), 0)
    if (chars > maxChars) throw contextFailure('CONTEXT_BUDGET', '活动材料超过预算，需要先整理工作集。')
    const records: ContextContent[] = []
    for (const record of selected) {
      const text = await this.options.storage.get(this.options.sessionId, record.objectId)
      if (text === null) throw contextFailure('OBJECT_MISSING', '工作集引用的原文不可用。')
      records.push({ record, text: text.slice(0, projectedSize(record)), offset: 0, totalChars: record.chars })
    }
    return { revision: state.workingSet.revision, cursor: state.records.length, records, chars }
  }

  public async recover(maxChars: number): Promise<ContextProjection> {
    boundedInteger(maxChars, ContextLimits.readChars)
    const state = await this.state()
    const reverse = [...state.records].reverse()
    const selected = [reverse.find(record => record.kind === 'user'), reverse.find(record => record.kind === 'checkpoint')].filter((record): record is ContextRecord => Boolean(record))
    const records: ContextContent[] = []
    let remaining = maxChars
    for (const record of selected) {
      const body = await this.options.storage.get(this.options.sessionId, record.objectId)
      if (body === null) throw contextFailure('OBJECT_MISSING', '恢复材料的原文不可用。')
      const text = body.slice(0, remaining)
      remaining -= text.length
      records.push({ record, text, offset: 0, totalChars: body.length })
    }
    return { revision: state.workingSet.revision, cursor: state.records.length, records, chars: maxChars - remaining }
  }
}
/** 创建绑定会话的上下文运行时。 */
export function createContextRuntime(options: ContextRuntimeOptions): ContextRuntime { return new SessionContext(options) }
