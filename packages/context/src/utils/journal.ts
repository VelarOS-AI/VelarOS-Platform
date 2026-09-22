import type { ContextState } from '../types/context.js'

/** 调用日志采用独立、无歧义的内部键，正文仍由同一对象存储持有。 */
export function journalKey(sessionId: string, id: string): string {
  return JSON.stringify(['kernel-invocation', sessionId, id])
}

/** 原子指向一份先持久化的调用记录正文。 */
export function journalState(key: string, objectId: string, version: number): ContextState {
  return { version, records: [{ ref: { sessionId: key, id: 'invocation' }, sequence: 1, kind: 'event', title: '调用记录', objectId, chars: 0, sources: [], createdAt: new Date().toISOString() }], workingSet: { revision: 0, cursor: 0, items: [] } }
}
