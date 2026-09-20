import type { InvocationReceipt, InvocationReconciliation, InvocationRecord, PreparedInvocation } from '@velaros-ai/kernel/contracts'

import type { ContextState } from '../contract/context.js'
import type { ContextInvocationJournalApi } from '../interface/provides.js'
import type { ContextStorage } from '../interface/requires.js'
import { journalKey, journalState } from '../utils/journal.js'

class ContextInvocationJournal implements ContextInvocationJournalApi {
  public constructor(private readonly storage: ContextStorage) {}

  public async claim(prepared: PreparedInvocation): Promise<InvocationRecord | null> {
    await this.index(prepared.sessionId, prepared.id)
    const key = journalKey(prepared.sessionId, prepared.id)
    const record: InvocationRecord = { phase: 'reserved', prepared }
    const objectId = await this.storage.put(key, JSON.stringify(record))
    if (await this.storage.compareAndSwap(key, 0, journalState(key, objectId, 1))) return null
    const existing = await this.read(prepared.sessionId, prepared.id)
    if (!existing) throw new Error('调用意图提交后无法读取')
    return existing
  }

  public async prepare(prepared: PreparedInvocation): Promise<void> {
    const key=journalKey(prepared.sessionId,prepared.id)
    const state=await this.storage.load(key)
    if(!state)throw new Error('调用没有占用记录')
    const existing=await this.decode(key,state)
    if(existing.phase!=='reserved'||existing.prepared.requestFingerprint!==prepared.requestFingerprint)throw new Error('调用的准备阶段冲突')
    const objectId=await this.storage.put(key,JSON.stringify({phase:'prepared',prepared}))
    if(!await this.storage.compareAndSwap(key,state.version,journalState(key,objectId,state.version+1)))throw new Error('调用准备提交冲突')
  }

  public async settle(receipt: InvocationReceipt): Promise<void> {
    const key = journalKey(receipt.invocation.sessionId, receipt.invocation.id)
    const state = await this.storage.load(key)
    if (!state) throw new Error('调用没有持久化意图')
    const existing = await this.decode(key, state)
    if (JSON.stringify(existing.prepared) !== JSON.stringify(receipt.invocation)) throw new Error('回执与原始意图不一致')
    if (existing.receipt) {
      if (JSON.stringify(existing.receipt) !== JSON.stringify(receipt)) throw new Error('调用已有不同终态')
      return
    }
    const objectId = await this.storage.put(key, JSON.stringify({ phase: 'settled', prepared: existing.prepared, receipt }))
    if (!await this.storage.compareAndSwap(key, state.version, journalState(key, objectId, state.version + 1))) throw new Error('调用终态提交冲突')
  }

  public async read(sessionId: string, id: string): Promise<InvocationRecord | null> {
    const key = journalKey(sessionId, id)
    const state = await this.storage.load(key)
    return state ? this.decode(key, state) : null
  }

  public async recordReconciliation(sessionId: string, id: string, result: InvocationReconciliation): Promise<void> {
    const key = journalKey(sessionId,id)
    const state = await this.storage.load(key)
    if (!state) throw new Error('核对目标不存在')
    const record = await this.decode(key,state)
    if (record.reconciliation || (record.receipt && record.receipt.effect !== 'unknown')) throw new Error('已有确定结果，不可覆盖')
    const objectId = await this.storage.put(key,JSON.stringify({...record,reconciliation:result}))
    if (!await this.storage.compareAndSwap(key,state.version,journalState(key,objectId,state.version+1))) throw new Error('核对提交发生冲突，请重新读取')
  }

  public async list(sessionId: string, executionId?: string): Promise<readonly InvocationRecord[]> {
    const key = JSON.stringify(['kernel-invocation-index', sessionId])
    const state = await this.storage.load(key)
    const records: InvocationRecord[] = []
    for (const entry of state?.records ?? []) {
      const record = await this.read(sessionId, entry.ref.id)
      if (record && (!executionId || record.prepared.executionId === executionId)) records.push(record)
    }
    return records
  }

  private async index(sessionId: string, id: string): Promise<void> {
    const key = JSON.stringify(['kernel-invocation-index', sessionId])
    for (let retry = 0; retry < 32; retry++) {
      const state = await this.storage.load(key) ?? { version: 0, records: [], workingSet: { revision: 0, cursor: 0, items: [] } }
      if (state.records.some(record => record.ref.id === id)) return
      const entry = { ref: { sessionId, id }, sequence: state.records.length + 1, kind: 'event' as const, title: '', objectId: '', chars: 0, sources: [], createdAt: new Date().toISOString() }
      if (await this.storage.compareAndSwap(key, state.version, { ...state, version: state.version + 1, records: [...state.records, entry] })) return
    }
    throw new Error('调用索引提交竞争超过上限')
  }

  private async decode(key: string, state: ContextState): Promise<InvocationRecord> {
    const ref = state.records[0]
    if (!ref) throw new Error('调用记录缺少正文引用')
    const text = await this.storage.get(key, ref.objectId)
    if (text === null) throw new Error('调用记录的原文丢失')
    return JSON.parse(text) as InvocationRecord
  }
}

/** 将同一份可靠对象存储接入 Kernel，不建立额外的调用时间线。 */
export function createContextInvocationJournal(storage: ContextStorage): ContextInvocationJournalApi {
  return new ContextInvocationJournal(storage)
}
