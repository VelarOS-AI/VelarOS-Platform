import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { ContextState } from '../contract/context.js'
import type { ContextStorage, LocalContextStorageOptions } from '../interface/requires.js'
import { contextFailure } from '../utils/state.js'

/** SQLite 提供跨连接原子提交和崩溃恢复，正文与工作集使用同一可靠存储。 */
export class LocalContextStorage implements ContextStorage {
  private readonly db: DatabaseSync
  public constructor(options: LocalContextStorageOptions) {
    if (!isAbsolute(options.path) && options.path !== ':memory:') throw contextFailure('INVALID_PATH', '上下文数据库需要绝对路径。')
    this.db = new DatabaseSync(options.path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS objects (session TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session,id));')
  }
  public async load(sessionId: string): Promise<ContextState | null> {
    const row = this.db.prepare('SELECT state FROM sessions WHERE id=?').get(sessionId)
    return row ? JSON.parse(String(row.state)) as ContextState : null
  }
  public async compareAndSwap(sessionId: string, expectedVersion: number, state: ContextState): Promise<boolean> {
    if (state.version !== expectedVersion + 1) throw contextFailure('INVALID_VERSION', '上下文存储版本必须连续递增。')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT version FROM sessions WHERE id=?').get(sessionId)
      if (Number(row?.version ?? 0) !== expectedVersion) { this.db.exec('ROLLBACK'); return false }
      this.db.prepare('INSERT INTO sessions(id,version,state) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,state=excluded.state').run(sessionId, state.version, JSON.stringify(state))
      this.db.exec('COMMIT')
      return true
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  public async put(sessionId: string, text: string): Promise<string> {
    const id = createHash('sha256').update(text).digest('hex')
    this.db.prepare('INSERT OR IGNORE INTO objects(session,id,body) VALUES (?,?,?)').run(sessionId,id,text)
    return id
  }
  public async get(sessionId: string, objectId: string): Promise<string | null> {
    const row = this.db.prepare('SELECT body FROM objects WHERE session=? AND id=?').get(sessionId,objectId)
    return row ? String(row.body) : null
  }
  public async close(): Promise<void> { this.db.close() }
}
/** 创建 Node 本地持久化适配器。 */
export function localContextStorage(options: LocalContextStorageOptions): ContextStorage { return new LocalContextStorage(options) }
