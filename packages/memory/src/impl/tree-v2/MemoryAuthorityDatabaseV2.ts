import { existsSync } from 'node:fs'

import BetterSqlite3 from 'better-sqlite3'

import { AppError } from '@velaros-ai/core/error'

import type {
  MemoryAuthorityOpenReportV2,
  MemorySqliteDatabaseV2,
  OpenMemoryAuthorityOptionsV2,
} from '../../types/tree-v2/authority'
import type { MemoryPhysicalRootsV2 } from '../../types/tree-v2/storage'
import {
  assertMemoryAuthoritySchemaV2,
  configureAuthorityConnectionV2,
  inspectAuthorityIdentityV2,
  migrateMemoryAuthorityV2,
} from '../../utils/tree-v2/authority-database'
import { MemoryAuthorityFormatIdentityV2 } from '../../utils/tree-v2/authority-schema'
import { openMemoryPhysicalRootsV2 } from '../../utils/tree-v2/storage/physical-roots'

/**
 * 记忆树 v2 权威库的唯一 open/migrate owner：一个数据根对应一个实例，构造即打开并迁移到位。
 *
 * 这条连接只承载结构、盲索引与密文引用。用户语义正文必须先经 `ContentKeyServiceV2` 封存；
 * 派生明文投影必须进加密的 index generation，不能借这条连接建 FTS 或树展示表。
 * 实例归创建它的运行时（`MemorySystemRuntimeV2` 或探针）所有，用完必须 `close()`。
 */
export interface MemoryAuthorityDatabaseV2Api {
  /** 这个库所在的五物理根。 */
  readonly roots: MemoryPhysicalRootsV2
  /** 构造时那一次打开与迁移的读数：建没建库、迁了哪几版、物理根的软异常。 */
  readonly openReport: MemoryAuthorityOpenReportV2
  /**
   * 包内 repository / service 组合层用的连接句柄；渲染进程与宿主不得持有。
   * 已经 `close()` 过再取会抛 INVARIANT。
   */
  readonly database: MemorySqliteDatabaseV2
  /** 做一次被动 WAL 检查点，把 WAL 里的内容合并回主库。连接已关抛 INVARIANT。 */
  checkpoint(): void
  /** 截断 WAL 后关闭连接；重复调用是空操作。 */
  close(): void
}

export class MemoryAuthorityDatabaseV2 implements MemoryAuthorityDatabaseV2Api {
  public readonly roots: MemoryPhysicalRootsV2
  public readonly openReport: MemoryAuthorityOpenReportV2

  private readonly connection: MemorySqliteDatabaseV2
  private closed = false

  constructor(dataRoot: string, options: OpenMemoryAuthorityOptionsV2 = {}) {
    const openedRoots = openMemoryPhysicalRootsV2(dataRoot)
    const databaseCreated = !existsSync(openedRoots.roots.authorityDatabasePath)
    const database = new BetterSqlite3(openedRoots.roots.authorityDatabasePath)

    try {
      configureAuthorityConnectionV2(database)
      const previousSchemaVersion = inspectAuthorityIdentityV2(database)
      const appliedMigrations = migrateMemoryAuthorityV2(database, previousSchemaVersion, options)
      assertMemoryAuthoritySchemaV2(database)
      this.roots = openedRoots.roots
      this.connection = database
      this.openReport = {
        databaseCreated,
        previousSchemaVersion,
        schemaVersion: MemoryAuthorityFormatIdentityV2.schemaVersion,
        appliedMigrations,
        physicalRoots: openedRoots.report,
      }
    } catch (error) {
      database.close()
      throw error
    }
  }

  public get database(): MemorySqliteDatabaseV2 {
    this.assertOpen()
    return this.connection
  }

  public checkpoint(): void {
    this.assertOpen()
    this.connection.pragma('wal_checkpoint(PASSIVE)')
  }

  public close(): void {
    if (this.closed) return
    this.connection.pragma('wal_checkpoint(TRUNCATE)')
    this.connection.close()
    this.closed = true
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AppError('INVARIANT', 'Memory authority 连接已关闭。')
    }
  }
}
