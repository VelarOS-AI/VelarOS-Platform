import type BetterSqlite3 from 'better-sqlite3'

import type { MemoryPhysicalRootsOpenReportV2 } from './storage.js'

/**
 * 记忆树 v2 权威库的数据形状：连接别名、打开与迁移读数、schema 自检用到的行形状。
 * 树 v2 是包内子系统，这些类型不出包。
 */

/** 权威库连接（better-sqlite3 的实例）。全 v2 只有这一处别名，别再各文件抄一份。 */
export type MemorySqliteDatabaseV2 = InstanceType<typeof BetterSqlite3>

/** 迁移过程的崩溃注入钩子：探针在指定时点抛错，检验半途崩溃后能不能收敛。 */
export interface MemoryAuthorityMigrationHooksV2 {
  /** 这一版迁移开始前回调。 */
  readonly beforeMigration?: (version: number) => void
  /** 这一版的语句都执行完、事务还没提交时回调。 */
  readonly afterApplyBeforeCommit?: (version: number) => void
  /** 这一版迁移提交后回调。 */
  readonly afterMigration?: (version: number) => void
}

/** 打开权威库时的可选项。 */
export interface OpenMemoryAuthorityOptionsV2 {
  /** 取当前时刻的函数；不给用 Date.now。迁移账本的时间戳用它。 */
  readonly now?: () => number
  /** 迁移过程的崩溃注入钩子。 */
  readonly migrationHooks?: MemoryAuthorityMigrationHooksV2
}

/** 打开权威库的一次读数。 */
export interface MemoryAuthorityOpenReportV2 {
  /** 这次打开是不是新建了库文件。 */
  readonly databaseCreated: boolean
  /** 打开前库里记的 schema 版本；全新库是 0。 */
  readonly previousSchemaVersion: number
  /** 打开后的 schema 版本（当前运行时支持的版本）。 */
  readonly schemaVersion: number
  /** 本次实际执行的迁移 id，按版本升序。 */
  readonly appliedMigrations: readonly string[]
  /** 五物理根这一次的打开读数。 */
  readonly physicalRoots: MemoryPhysicalRootsOpenReportV2
}

/** 迁移账本里的一行。 */
export interface MemoryAuthorityMigrationRowV2 {
  /** schema 版本号。 */
  readonly version: number
  /** 迁移 id。 */
  readonly migration_id: string
}

/** `PRAGMA table_info(...)` 与 `sqlite_schema` 查询里用得到的那一列名字。 */
export interface MemoryAuthorityNameRowV2 {
  /** 表名或列名。 */
  readonly name: string
}
