import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { isAbsolute } from 'node:path'
import { getBuiltinModule } from 'node:process'
import type { DatabaseSync } from 'node:sqlite'

import { isEmpty, isFalse, isUndefined } from '@velaros-ai/core'
import { shortReferenceId } from '@velaros-ai/core/utils/shortReferenceId'

import { ContextLimits } from '../contract/constants.js'
import type { StoreStorage } from '../contract/requires.js'
import type { ContextStorage, LocalContextStorageOptions } from '../contract/requires.js'
import type {
  ContextMetadata,
  ContextObjectCollection,
  ContextObjectCollectionResult,
  ContextRecord,
  ContextRecordPage,
  ContextRecordQuery,
  ContextRecordSelection,
  ContextRecordSnapshot,
  ContextState,
} from '../types/context.js'
import { contextFailure, emptyContextState } from '../utils/state.js'

import { LocalStoreStorage } from './LocalStoreStorage.js'

/** SQLite 原子提交小状态及独立记录索引；正文保持内容寻址和原有会话边界。 */
export class LocalContextStorage implements ContextStorage {
  public readonly leaseOwner = JSON.stringify({
    host: hostname(),
    pid: process.pid,
    instance: randomUUID(),
  })

  /** SQLite 本地宿主的存活证明；PID 重用、权限不足和跨宿主都保守保留租约。 */
  public leaseOwnerActive(owner: string): Optional<boolean> {
    let identity: { host?: string; pid?: number }
    try {
      identity = JSON.parse(owner) as { host?: string; pid?: number }
      // @arch-guard:suspend code-style/require-error-logging 理由：旧格式或未知持有者返回未知状态，调用方保守保留租约，不把解析失败当作持有者已退出。
    } catch {
      return
    }
    if (
      !identity ||
      identity.host !== hostname() ||
      !Number.isSafeInteger(identity.pid) ||
      identity.pid! <= 0
    )
      return
    try {
      process.kill(identity.pid!, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : undefined
    }
  }
  /** 同连接的独立持久对象空间。 */
  public readonly stores: StoreStorage
  private readonly db: DatabaseSync
  private readonly lifetime = new AbortController()
  public constructor(options: LocalContextStorageOptions) {
    if (!isAbsolute(options.path) && options.path !== ':memory:')
      throw contextFailure('INVALID_PATH', '上下文数据库需要绝对路径。')
    // 只有选择本地适配器时加载 SQLite；注入其他存储的 Runtime 不依赖此内置模块。
    const sqlite = getBuiltinModule('node:sqlite')
    if (!sqlite)
      throw contextFailure(
        'STORAGE_UNAVAILABLE',
        '本地存储需要启用 node:sqlite；也可以通过 storage 注入其他 ContextStorage 实现。'
      )
    this.db = new sqlite.DatabaseSync(options.path)
    try {
      this.db.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS objects (session TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, touched INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session,id)); CREATE TABLE IF NOT EXISTS context_records(session TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL, title TEXT NOT NULL, object_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session,id)); CREATE INDEX IF NOT EXISTS context_records_sequence ON context_records(session,sequence); CREATE INDEX IF NOT EXISTS context_records_title ON context_records(session,title,sequence); CREATE INDEX IF NOT EXISTS context_records_object ON context_records(session,object_id);'
      )
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS context_records_kind ON context_records(session,json_extract(body,'$.kind'),sequence)"
      )
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS context_reference_ids(session TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(session,id))'
      )
      this.stores = new LocalStoreStorage(this.db, this.lifetime.signal)
    } catch (error) {
      try {
        this.db.close()
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], '本地存储初始化及清理失败')
      }
      throw error
    }
  }
  public async load(sessionId: string): Promise<Nullable<ContextState>> {
    // 一个读事务固定状态版本和记录目录，避免跨连接读到半个新快照。
    this.db.exec('BEGIN')
    try {
      const row = this.db.prepare('SELECT state FROM sessions WHERE id=?').get(sessionId)
      const state = row ? (JSON.parse(String(row.state)) as ContextState) : null
      const result = state
        ? {
            ...state,
            records: this.db
              .prepare('SELECT body FROM context_records WHERE session=? ORDER BY sequence')
              .all(sessionId)
              .map((record) => JSON.parse(String(record.body)) as ContextRecord),
          }
        : null
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  public async allocateReferenceId(sessionId: string): Promise<string> {
    const claim = this.db.prepare(
      'INSERT OR IGNORE INTO context_reference_ids(session,id) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM context_records WHERE session=? AND id=?)'
    )
    return shortReferenceId((id) => Number(claim.run(sessionId, id, sessionId, id).changes) === 0)
  }
  public async compareAndSwap(
    sessionId: string,
    expectedVersion: number,
    state: ContextState
  ): Promise<boolean> {
    if (state.version !== expectedVersion + 1)
      throw contextFailure('INVALID_VERSION', '上下文存储版本必须连续递增。')
    if (
      state.records.some(
        (record, index) =>
          !Number.isSafeInteger(record.sequence) ||
          record.sequence < 1 ||
          (index > 0 && record.sequence <= state.records[index - 1]!.sequence)
      ) ||
      new Set(state.records.map((record) => record.ref.id)).size !== state.records.length
    )
      throw contextFailure('INVALID_RECORDS', '记录目录身份或序号无效。')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT version FROM sessions WHERE id=?').get(sessionId)
      if (Number(row?.version ?? 0) !== expectedVersion) {
        this.db.exec('ROLLBACK')
        return false
      }
      const previous = new Map(
        this.db
          .prepare('SELECT id,body FROM context_records WHERE session=?')
          .all(sessionId)
          .map((row) => [String(row.id), String(row.body)])
      )
      const changed = state.records
        .map((record) => ({ record, body: JSON.stringify(record) }))
        .filter((item) => previous.get(item.record.ref.id) !== item.body)
      for (const objectId of new Set(changed.map((item) => item.record.objectId).filter(Boolean)))
        if (
          !this.db
            .prepare('SELECT 1 FROM objects WHERE session=? AND id=?')
            .get(sessionId, objectId)
        )
          throw contextFailure('OBJECT_MISSING', '提交所引用的正文不存在。')
      const ids = new Set(state.records.map((record) => record.ref.id))
      for (const id of previous.keys())
        if (!ids.has(id))
          this.db.prepare('DELETE FROM context_records WHERE session=? AND id=?').run(sessionId, id)
      const upsert = this.db.prepare(
        'INSERT INTO context_records(session,id,sequence,title,object_id,body) VALUES (?,?,?,?,?,?) ON CONFLICT(session,id) DO UPDATE SET sequence=excluded.sequence,title=excluded.title,object_id=excluded.object_id,body=excluded.body WHERE body<>excluded.body'
      )
      for (const { record, body } of changed)
        upsert.run(sessionId, record.ref.id, record.sequence, record.title, record.objectId, body)
      const { records: _records, ...metadata } = state
      this.db
        .prepare(
          'INSERT INTO sessions(id,version,state) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,state=excluded.state'
        )
        .run(sessionId, state.version, JSON.stringify(metadata))
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  public async loadMetadata(sessionId: string): Promise<Nullable<ContextMetadata>> {
    const row = this.db.prepare('SELECT state FROM sessions WHERE id=?').get(sessionId)
    return row ? (JSON.parse(String(row.state)) as ContextMetadata) : null
  }
  public async selectSnapshot(
    sessionId: string,
    selections: readonly ContextRecordSelection[]
  ): Promise<Nullable<ContextRecordSnapshot>> {
    for (const selection of selections) {
      if (
        [selection.after, selection.through].some(
          (value) => !isUndefined(value) && (!Number.isSafeInteger(value) || value < 0)
        ) ||
        (!isUndefined(selection.first) &&
          (!Number.isSafeInteger(selection.first) ||
            selection.first < 1 ||
            selection.first > ContextLimits.recordPage ||
            selection.latest ||
            !isUndefined(selection.last) ||
            selection.latestPerTitle)) ||
        (!isUndefined(selection.sequence) &&
          (!Number.isSafeInteger(selection.sequence) || selection.sequence < 1)) ||
        (!isUndefined(selection.last) &&
          (!Number.isSafeInteger(selection.last) ||
            selection.last < 1 ||
            selection.last > ContextLimits.recordPage)) ||
        (selection.latest && !isUndefined(selection.last)) ||
        (selection.latestPerTitle && (selection.latest || !isUndefined(selection.last)))
      )
        throw contextFailure('INVALID_RANGE', '选择快照的序号、末尾数量或分组组合无效。')
    }
    this.db.exec('BEGIN')
    try {
      const row = this.db.prepare('SELECT state FROM sessions WHERE id=?').get(sessionId)
      if (!row) {
        this.db.exec('COMMIT')
        return null
      }
      const metadata = JSON.parse(String(row.state)) as ContextMetadata
      const records = new Map<string, ContextRecord>()
      for (const selection of selections) {
        const where = ['session=?']
        const values: Array<string | number> = [sessionId]
        if (!isUndefined(selection.title)) {
          where.push('title=?')
          values.push(selection.title)
        }
        if (!isUndefined(selection.refId)) {
          where.push('id=?')
          values.push(selection.refId)
        }
        if (!isUndefined(selection.kind)) {
          where.push("json_extract(body,'$.kind')=?")
          values.push(selection.kind)
        }
        if (!isUndefined(selection.titlePrefix)) {
          // 固定下界缩小标题索引扫描；substr 按字面比较，不把 %/_ 当通配符。
          where.push(
            'title>=? AND substr(CAST(title AS BLOB),1,length(CAST(? AS BLOB)))=CAST(? AS BLOB)'
          )
          values.push(selection.titlePrefix, selection.titlePrefix, selection.titlePrefix)
        }
        if (!isUndefined(selection.titleSuffix) && !isEmpty(selection.titleSuffix)) {
          where.push('substr(CAST(title AS BLOB),-length(CAST(? AS BLOB)))=CAST(? AS BLOB)')
          values.push(selection.titleSuffix, selection.titleSuffix)
        }
        if (!isUndefined(selection.sequence)) {
          where.push('sequence=?')
          values.push(selection.sequence)
        }
        if (!isUndefined(selection.after)) {
          where.push('sequence>?')
          values.push(selection.after)
        }
        if (!isUndefined(selection.through)) {
          where.push('sequence<=?')
          values.push(selection.through)
        }
        const order = selection.latest
          ? 'DESC LIMIT 1'
          : selection.last
            ? `DESC LIMIT ${selection.last}`
            : selection.first
              ? `ASC LIMIT ${selection.first}`
              : 'ASC'
        const query = selection.latestPerTitle
          ? `SELECT body FROM context_records WHERE session=? AND sequence IN (SELECT MAX(sequence) FROM context_records WHERE ${where.join(' AND ')} GROUP BY title) ORDER BY sequence`
          : `SELECT body FROM context_records WHERE ${where.join(' AND ')} ORDER BY sequence ${order}`
        for (const found of this.db
          .prepare(query)
          .all(...(selection.latestPerTitle ? [sessionId, ...values] : values))) {
          const record = JSON.parse(String(found.body)) as ContextRecord
          records.set(record.ref.id, record)
        }
      }
      this.db.exec('COMMIT')
      return { metadata, records: [...records.values()].sort((a, b) => a.sequence - b.sequence) }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  public async compareAndSwapMetadata(
    sessionId: string,
    expectedVersion: number,
    state: ContextMetadata,
    append: ReadonlyArray<Omit<ContextRecord, 'sequence'>> = []
  ): Promise<boolean> {
    if (state.version !== expectedVersion + 1 || !Number.isSafeInteger(state.version))
      throw contextFailure('INVALID_VERSION', '上下文存储版本必须连续递增。')
    if ('records' in state) throw contextFailure('INVALID_RECORDS', '增量提交不接收完整记录目录。')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.db.prepare('SELECT version FROM sessions WHERE id=?').get(sessionId)
      if (Number(current?.version ?? 0) !== expectedVersion) {
        this.db.exec('ROLLBACK')
        return false
      }
      if (!isEmpty(append)) {
        const last = this.db
          .prepare(
            'SELECT sequence FROM context_records WHERE session=? ORDER BY sequence DESC LIMIT 1'
          )
          .get(sessionId)
        let sequence = Number(last?.sequence ?? 0)
        const insert = this.db.prepare(
          'INSERT INTO context_records(session,id,sequence,title,object_id,body) VALUES (?,?,?,?,?,?)'
        )
        for (const entry of append) {
          if (
            entry.objectId &&
            !this.db
              .prepare('SELECT 1 FROM objects WHERE session=? AND id=?')
              .get(sessionId, entry.objectId)
          )
            throw contextFailure('OBJECT_MISSING', '提交所引用的正文不存在。')
          if (
            this.db
              .prepare('SELECT 1 FROM context_records WHERE session=? AND id=?')
              .get(sessionId, entry.ref.id)
          )
            throw contextFailure('INVALID_RECORDS', '追加记录身份已存在。')
          const record = { ...entry, sequence: ++sequence }
          if (!Number.isSafeInteger(sequence))
            throw contextFailure('INVALID_RECORDS', '记录序号超出安全整数范围。')
          insert.run(
            sessionId,
            record.ref.id,
            sequence,
            record.title,
            record.objectId,
            JSON.stringify(record)
          )
        }
      }
      this.db
        .prepare(
          'INSERT INTO sessions(id,version,state) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,state=excluded.state'
        )
        .run(sessionId, state.version, JSON.stringify(state))
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  public async records(sessionId: string, query: ContextRecordQuery): Promise<ContextRecordPage> {
    const after = query.after ?? 0
    const limit = query.limit ?? ContextLimits.recordPage
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > ContextLimits.recordPage
    )
      throw contextFailure('INVALID_RANGE', '记录分页范围无效。')
    const where = ['session=?', 'sequence>?']
    const values: Array<string | number> = [sessionId, after]
    if (!isUndefined(query.title)) {
      where.push('title=?')
      values.push(query.title)
    }
    if (!isUndefined(query.refId)) {
      where.push('id=?')
      values.push(query.refId)
    }
    const found = this.db
      .prepare(
        `SELECT body FROM context_records WHERE ${where.join(' AND ')} ORDER BY sequence LIMIT ?`
      )
      .all(...values, limit + 1)
      .map((record) => JSON.parse(String(record.body)) as ContextRecord)
    const items = found.slice(0, limit)
    return { items, nextAfter: found.length > limit ? items.at(-1)!.sequence : null }
  }
  public async appendRecord(
    sessionId: string,
    entry: Omit<ContextRecord, 'sequence'>
  ): Promise<ContextRecord> {
    if (
      entry.ref.sessionId !== sessionId ||
      entry.sources.some((ref) => ref.sessionId !== sessionId)
    )
      throw contextFailure('SCOPE_MISMATCH', '引用不在本会话作用域内。')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (
        !this.db
          .prepare('SELECT 1 FROM objects WHERE session=? AND id=?')
          .get(sessionId, entry.objectId)
      )
        throw contextFailure('OBJECT_MISSING', '提交所引用的正文不存在。')
      const find = this.db.prepare('SELECT 1 FROM context_records WHERE session=? AND id=?')
      if (find.get(sessionId, entry.ref.id))
        throw contextFailure('INVALID_RECORDS', '追加记录身份已存在。')
      for (const ref of entry.sources)
        if (!find.get(sessionId, ref.id)) throw contextFailure('REF_NOT_FOUND', '原始记录不存在。')
      const row = this.db.prepare('SELECT state FROM sessions WHERE id=?').get(sessionId)
      const { records: _records, ...metadata } = row
        ? (JSON.parse(String(row.state)) as ContextState)
        : emptyContextState()
      const last = this.db
        .prepare(
          'SELECT sequence FROM context_records WHERE session=? ORDER BY sequence DESC LIMIT 1'
        )
        .get(sessionId)
      const record = { ...entry, sequence: Number(last?.sequence ?? 0) + 1 }
      if (!Number.isSafeInteger(record.sequence))
        throw contextFailure('INVALID_RECORDS', '记录序号超出安全整数范围。')
      this.db
        .prepare(
          'INSERT INTO context_records(session,id,sequence,title,object_id,body) VALUES (?,?,?,?,?,?)'
        )
        .run(
          sessionId,
          record.ref.id,
          record.sequence,
          record.title,
          record.objectId,
          JSON.stringify(record)
        )
      const next = { ...metadata, version: metadata.version + 1 }
      this.db
        .prepare(
          'INSERT INTO sessions(id,version,state) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,state=excluded.state'
        )
        .run(sessionId, next.version, JSON.stringify(next))
      this.db.exec('COMMIT')
      return structuredClone(record)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  public async put(sessionId: string, text: string): Promise<string> {
    const id = createHash('sha256').update(text).digest('hex')
    this.db
      .prepare(
        'INSERT INTO objects(session,id,body,touched) VALUES (?,?,?,?) ON CONFLICT(session,id) DO UPDATE SET touched=excluded.touched'
      )
      .run(sessionId, id, text, Date.now())
    return id
  }
  public async get(sessionId: string, objectId: string): Promise<Nullable<string>> {
    const row = this.db
      .prepare('SELECT body FROM objects WHERE session=? AND id=?')
      .get(sessionId, objectId)
    return row ? String(row.body) : null
  }
  public async collect(
    sessionId: string,
    options: ContextObjectCollection
  ): Promise<ContextObjectCollectionResult> {
    if (
      !Number.isSafeInteger(options.before) ||
      options.before > Date.now() - ContextLimits.orphanGraceMs
    )
      throw contextFailure('INVALID_RANGE', '回收必须保留对象写入宽限期。')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT version,state FROM sessions WHERE id=?').get(sessionId)
      if (Number(row?.version ?? 0) !== options.expectedVersion)
        throw contextFailure('CONTEXT_CONFLICT', '回收前会话版本已变化。')
      if (row && JSON.parse(String(row.state)).objectReferencesVersion !== 1)
        throw contextFailure(
          'CONTEXT_REFERENCES_UNVERIFIED',
          '持久正文引用格式未确认，禁止回收对象。'
        )
      const candidates = this.db
        .prepare(
          'SELECT id FROM objects o WHERE session=? AND touched<? AND NOT EXISTS(SELECT 1 FROM context_records r WHERE r.session=o.session AND r.object_id=o.id)'
        )
        .all(sessionId, options.before)
      if (isFalse(options.dryRun))
        for (const object of candidates)
          this.db
            .prepare('DELETE FROM objects WHERE session=? AND id=?')
            .run(sessionId, String(object.id))
      this.db.exec('COMMIT')
      return {
        candidates: candidates.length,
        deleted: isFalse(options.dryRun) ? candidates.length : 0,
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  public async close(): Promise<void> {
    if (this.lifetime.signal.aborted) return
    this.lifetime.abort(contextFailure('STORAGE_CLOSED', '存储已关闭。'))
    this.db.close()
  }
}
/** 创建 Node 本地持久化适配器。 */
export function localContextStorage(options: LocalContextStorageOptions): ContextStorage {
  return new LocalContextStorage(options)
}
