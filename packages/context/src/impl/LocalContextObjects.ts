import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

import { contextBodyChunks } from '../utils/body-chunks.js'
import { contextFailure } from '../utils/state.js'
import { ContextTuning } from '../utils/tuning.js'

/** SQLite 正文端口；每份原文与块映射一起提交，块只在所属会话内复用。 */
export interface LocalContextObjectsApi {
  /** 原子写入原文及全部分块，返回内容身份。 */
  put(sessionId: string, text: string): string
  /** 在一致快照上还原并核对原文，不存在时返回 null。 */
  get(sessionId: string, objectId: string): Nullable<string>
  /** 在已有回收事务内删除不再被对象持有的块。 */
  collect(sessionId: string): void
}

/** 大请求与累计状态按内容分块去重，不重复保存未变化的历史和输出。 */
export class LocalContextObjects implements LocalContextObjectsApi {
  public constructor(private readonly db: DatabaseSync) {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS objects(session TEXT NOT NULL,id TEXT NOT NULL,bytes INTEGER NOT NULL,touched INTEGER NOT NULL,PRIMARY KEY(session,id)); CREATE TABLE IF NOT EXISTS object_chunks(session TEXT NOT NULL,id TEXT NOT NULL,body BLOB NOT NULL,PRIMARY KEY(session,id)); CREATE TABLE IF NOT EXISTS object_parts(session TEXT NOT NULL,object_id TEXT NOT NULL,position INTEGER NOT NULL,chunk_id TEXT NOT NULL,PRIMARY KEY(session,object_id,position)); CREATE INDEX IF NOT EXISTS object_parts_chunk ON object_parts(session,chunk_id);'
    )
    // 存储格式直接切换；旧库不提供双读或隐式迁移。
    this.db.prepare('SELECT bytes FROM objects LIMIT 0').all()
  }

  public put(sessionId: string, text: string): string {
    // UTF-16 保留 JS 原文中的孤立代理项；读取不会用替换字符改变原始证据。
    const body = Buffer.from(text, 'utf16le')
    const id = createHash('sha256').update(body).digest('hex')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db
        .prepare('UPDATE objects SET touched=? WHERE session=? AND id=?')
        .run(Date.now(), sessionId, id)
      if (!Number(existing.changes)) {
        this.db
          .prepare('INSERT INTO objects(session,id,bytes,touched) VALUES(?,?,?,?)')
          .run(sessionId, id, body.byteLength, Date.now())
        const find = this.db.prepare('SELECT 1 FROM object_chunks WHERE session=? AND id=?')
        const insert = this.db.prepare('INSERT INTO object_chunks(session,id,body) VALUES(?,?,?)')
        const part = this.db.prepare(
          'INSERT INTO object_parts(session,object_id,position,chunk_id) VALUES(?,?,?,?)'
        )
        for (const [position, chunk] of contextBodyChunks(body).entries()) {
          const chunkId = createHash('sha256').update(chunk).digest('hex')
          if (!find.get(sessionId, chunkId))
            insert.run(
              sessionId,
              chunkId,
              deflateRawSync(chunk, { level: ContextTuning.bodyCompressionLevel })
            )
          part.run(sessionId, id, position, chunkId)
        }
      }
      this.db.exec('COMMIT')
      return id
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  public get(sessionId: string, objectId: string): Nullable<string> {
    // 固定正文与全部块，避免另一连接的显式回收造成跨版本读取。
    this.db.exec('BEGIN')
    try {
      const object = this.db
        .prepare('SELECT bytes FROM objects WHERE session=? AND id=?')
        .get(sessionId, objectId)
      if (!object) {
        this.db.exec('COMMIT')
        return null
      }
      const bytes = Number(object.bytes)
      if (!Number.isSafeInteger(bytes) || bytes < 0)
        throw contextFailure('OBJECT_CORRUPT', '上下文正文长度无效。')
      const chunks = this.db
        .prepare(
          'SELECT p.position,c.body FROM object_parts p LEFT JOIN object_chunks c ON c.session=p.session AND c.id=p.chunk_id WHERE p.session=? AND p.object_id=? ORDER BY p.position'
        )
        .all(sessionId, objectId)
      const parts: Buffer[] = []
      let length = 0
      for (const [position, chunk] of chunks.entries()) {
        if (Number(chunk.position) !== position || !chunk.body)
          throw contextFailure('OBJECT_CORRUPT', '上下文正文分块缺失。')
        const part = inflateRawSync(chunk.body as Uint8Array, {
          maxOutputLength: ContextTuning.bodyChunkMaxBytes,
        })
        length += part.byteLength
        if (length > bytes) throw contextFailure('OBJECT_CORRUPT', '上下文正文分块越界。')
        parts.push(part)
      }
      const body = Buffer.concat(parts)
      if (length !== bytes || createHash('sha256').update(body).digest('hex') !== objectId)
        throw contextFailure('OBJECT_CORRUPT', '上下文正文完整性核对失败。')
      this.db.exec('COMMIT')
      return body.toString('utf16le')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** 在调用方的回收事务内移除失去正文所有者的映射及块。 */
  public collect(sessionId: string): void {
    this.db
      .prepare(
        'DELETE FROM object_parts WHERE session=? AND NOT EXISTS(SELECT 1 FROM objects o WHERE o.session=object_parts.session AND o.id=object_parts.object_id)'
      )
      .run(sessionId)
    this.db
      .prepare(
        'DELETE FROM object_chunks WHERE session=? AND NOT EXISTS(SELECT 1 FROM object_parts p WHERE p.session=object_chunks.session AND p.chunk_id=object_chunks.id)'
      )
      .run(sessionId)
  }
}
