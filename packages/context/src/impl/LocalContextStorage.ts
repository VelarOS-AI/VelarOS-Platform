import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {isFalse,isUndefined} from '@velaros-ai/core'

import type { ContextObjectCollection, ContextObjectCollectionResult, ContextRecord, ContextRecordPage, ContextRecordQuery, ContextState } from '../contract/context.js'
import { ContextLimits } from '../contract/context.js'
import type {StoreStorage} from '../interface/requires.js'
import type { ContextStorage, LocalContextStorageOptions } from '../interface/requires.js'
import { contextFailure } from '../utils/state.js'

import {LocalStoreStorage} from './LocalStoreStorage.js'

/** SQLite 原子提交小状态及独立记录索引；正文保持内容寻址和原有会话边界。 */
export class LocalContextStorage implements ContextStorage {
  /** 同连接的独立持久对象空间。 */
  public readonly stores:StoreStorage
  private readonly db: DatabaseSync
  public constructor(options: LocalContextStorageOptions) {
    if (!isAbsolute(options.path) && options.path !== ':memory:') throw contextFailure('INVALID_PATH', '上下文数据库需要绝对路径。')
    this.db = new DatabaseSync(options.path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS objects (session TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, touched INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session,id)); CREATE TABLE IF NOT EXISTS context_records(session TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL, title TEXT NOT NULL, object_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session,id)); CREATE INDEX IF NOT EXISTS context_records_sequence ON context_records(session,sequence); CREATE INDEX IF NOT EXISTS context_records_title ON context_records(session,title,sequence); CREATE INDEX IF NOT EXISTS context_records_object ON context_records(session,object_id);')
    this.stores=new LocalStoreStorage(this.db)
  }
  public async load(sessionId: string): Promise<Nullable<ContextState>> {
    // 一个读事务固定状态版本和记录目录，避免跨连接读到半个新快照。
    this.db.exec('BEGIN')
    try{
      const row=this.db.prepare('SELECT state FROM sessions WHERE id=?').get(sessionId)
      const state=row?JSON.parse(String(row.state)) as ContextState:null
      const result=state?{...state,records:this.db.prepare('SELECT body FROM context_records WHERE session=? ORDER BY sequence').all(sessionId).map(record=>JSON.parse(String(record.body)) as ContextRecord)}:null
      this.db.exec('COMMIT');return result
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
  public async compareAndSwap(sessionId: string, expectedVersion: number, state: ContextState): Promise<boolean> {
    if (state.version !== expectedVersion + 1) throw contextFailure('INVALID_VERSION', '上下文存储版本必须连续递增。')
    if(state.records.some((record,index)=>!Number.isSafeInteger(record.sequence)||record.sequence<1||index>0&&record.sequence<=state.records[index-1]!.sequence)||new Set(state.records.map(record=>record.ref.id)).size!==state.records.length)throw contextFailure('INVALID_RECORDS','记录目录身份或序号无效。')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT version FROM sessions WHERE id=?').get(sessionId)
      if (Number(row?.version ?? 0) !== expectedVersion) { this.db.exec('ROLLBACK'); return false }
      const previous=new Map(this.db.prepare('SELECT id,body FROM context_records WHERE session=?').all(sessionId).map(row=>[String(row.id),String(row.body)]))
      const changed=state.records.map(record=>({record,body:JSON.stringify(record)})).filter(item=>previous.get(item.record.ref.id)!==item.body)
      for(const objectId of new Set(changed.map(item=>item.record.objectId).filter(Boolean)))if(!this.db.prepare('SELECT 1 FROM objects WHERE session=? AND id=?').get(sessionId,objectId))throw contextFailure('OBJECT_MISSING','提交所引用的正文不存在。')
      const ids=new Set(state.records.map(record=>record.ref.id))
      for(const id of previous.keys())if(!ids.has(id))this.db.prepare('DELETE FROM context_records WHERE session=? AND id=?').run(sessionId,id)
      const upsert=this.db.prepare('INSERT INTO context_records(session,id,sequence,title,object_id,body) VALUES (?,?,?,?,?,?) ON CONFLICT(session,id) DO UPDATE SET sequence=excluded.sequence,title=excluded.title,object_id=excluded.object_id,body=excluded.body WHERE body<>excluded.body')
      for(const {record,body} of changed)upsert.run(sessionId,record.ref.id,record.sequence,record.title,record.objectId,body)
      const {records:_records,...metadata}=state
      this.db.prepare('INSERT INTO sessions(id,version,state) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,state=excluded.state').run(sessionId, state.version, JSON.stringify(metadata))
      this.db.exec('COMMIT')
      return true
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  public async records(sessionId:string,query:ContextRecordQuery):Promise<ContextRecordPage>{
    const after=query.after??0; const limit=query.limit??ContextLimits.recordPage
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>ContextLimits.recordPage)throw contextFailure('INVALID_RANGE','记录分页范围无效。')
    const where=['session=?','sequence>?']; const values:Array<string|number>=[sessionId,after]
    if(!isUndefined(query.title)){where.push('title=?');values.push(query.title)}
    if(!isUndefined(query.refId)){where.push('id=?');values.push(query.refId)}
    const found=this.db.prepare(`SELECT body FROM context_records WHERE ${where.join(' AND ')} ORDER BY sequence LIMIT ?`).all(...values,limit+1).map(record=>JSON.parse(String(record.body)) as ContextRecord)
    const items=found.slice(0,limit)
    return {items,nextAfter:found.length>limit?items.at(-1)!.sequence:null}
  }
  public async put(sessionId: string, text: string): Promise<string> {
    const id = createHash('sha256').update(text).digest('hex')
    this.db.prepare('INSERT INTO objects(session,id,body,touched) VALUES (?,?,?,?) ON CONFLICT(session,id) DO UPDATE SET touched=excluded.touched').run(sessionId,id,text,Date.now())
    return id
  }
  public async get(sessionId: string, objectId: string): Promise<Nullable<string>> {
    const row = this.db.prepare('SELECT body FROM objects WHERE session=? AND id=?').get(sessionId,objectId)
    return row ? String(row.body) : null
  }
  public async collect(sessionId:string,options:ContextObjectCollection):Promise<ContextObjectCollectionResult>{
    if(!Number.isSafeInteger(options.before)||options.before>Date.now()-ContextLimits.orphanGraceMs)throw contextFailure('INVALID_RANGE','回收必须保留对象写入宽限期。')
    this.db.exec('BEGIN IMMEDIATE')
    try{
      const row=this.db.prepare('SELECT version,state FROM sessions WHERE id=?').get(sessionId)
      if(Number(row?.version??0)!==options.expectedVersion)throw contextFailure('CONTEXT_CONFLICT','回收前会话版本已变化。')
      const candidates=this.db.prepare('SELECT id FROM objects o WHERE session=? AND touched<? AND NOT EXISTS(SELECT 1 FROM context_records r WHERE r.session=o.session AND r.object_id=o.id)').all(sessionId,options.before)
      if(isFalse(options.dryRun))for(const object of candidates)this.db.prepare('DELETE FROM objects WHERE session=? AND id=?').run(sessionId,String(object.id))
      this.db.exec('COMMIT');return {candidates:candidates.length,deleted:isFalse(options.dryRun)?candidates.length:0}
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
  public async close(): Promise<void> { this.db.close() }
}
/** 创建 Node 本地持久化适配器。 */
export function localContextStorage(options: LocalContextStorageOptions): ContextStorage { return new LocalContextStorage(options) }
