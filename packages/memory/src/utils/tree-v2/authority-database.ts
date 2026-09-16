import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  MemoryAuthorityMigrationRowV2,
  MemoryAuthorityNameRowV2,
  MemorySqliteDatabaseV2,
  OpenMemoryAuthorityOptionsV2,
} from '../../types/tree-v2/authority'

import {
  applyMemoryAuthorityEvidenceReplayMigrationV2,
  applyMemoryAuthorityMeaningEvidenceMigrationV2,
  applyMemoryAuthoritySchemaV2,
  MemoryAuthorityBlindIndexColumnsV2,
  MemoryAuthorityEvidenceReplayMigrationIdV2,
  MemoryAuthorityForbiddenPlaintextColumnsV2,
  MemoryAuthorityFormatIdentityV2,
  MemoryAuthorityMeaningEvidenceMigrationIdV2,
  MemoryAuthorityMigrationIdV2,
} from './authority-schema'
import { readIntegerPragmaV2 } from './checks'

/**
 * 权威库连接的打开、身份判定、迁移与 schema 自检。
 * 这些都是对一个连接做的判断，用不着实例状态，所以从 `MemoryAuthorityDatabaseV2` 提到这里。
 */

/** 本包拥有的用户表前缀：authority 里出现别的前缀就是有人往这个库里塞了东西。 */
export const MemoryAuthorityTablePrefixV2 = 'memory_'

/** SQLite 自己的内部表前缀，列用户表时要排掉。 */
export const MemoryAuthoritySqliteInternalPrefixV2 = 'sqlite_'

/** 按 v2 的取舍配置连接：WAL、全同步、安全删除、外键、临时表只在内存、关掉可信 schema。 */
export function configureAuthorityConnectionV2(database: MemorySqliteDatabaseV2): void {
  database.pragma('busy_timeout = 5000')
  database.pragma('foreign_keys = ON')
  database.pragma('journal_mode = WAL')
  database.pragma('synchronous = FULL')
  database.pragma('secure_delete = ON')
  database.pragma('temp_store = MEMORY')
  database.pragma('trusted_schema = OFF')
}

/** 列出库里本包以外看得见的用户表名（按名排序）。 */
export function listAuthorityUserTablesV2(database: MemorySqliteDatabaseV2): string[] {
  return (
    database
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table'
           AND name NOT LIKE ?
         ORDER BY name`
      )
      .all(`${MemoryAuthoritySqliteInternalPrefixV2}%`) as MemoryAuthorityNameRowV2[]
  ).map((row) => row.name)
}

/**
 * 判定这个库是不是 v2 权威库，返回它当前的 schema 版本；空库返回 0。
 * 身份不对或版本超出当前运行时支持范围一律抛 VALIDATION——不猜、不覆盖。
 */
export function inspectAuthorityIdentityV2(database: MemorySqliteDatabaseV2): number {
  const applicationId = readIntegerPragmaV2(database, 'application_id')
  const schemaVersion = readIntegerPragmaV2(database, 'user_version')
  const userTables = listAuthorityUserTablesV2(database)

  if (applicationId === 0 && schemaVersion === 0 && isEmpty(userTables)) return 0

  if (applicationId !== MemoryAuthorityFormatIdentityV2.applicationId) {
    throw new AppError(
      'VALIDATION',
      'authority.sqlite3 不是 Memory Tree v2 权威库，拒绝猜测或覆盖。',
      undefined,
      { applicationId, schemaVersion, userTables }
    )
  }
  if (schemaVersion < 1 || schemaVersion > MemoryAuthorityFormatIdentityV2.schemaVersion) {
    throw new AppError(
      'VALIDATION',
      'Memory Tree v2 authority schema 版本不受当前运行时支持。',
      undefined,
      {
        schemaVersion,
        supportedVersion: MemoryAuthorityFormatIdentityV2.schemaVersion,
      }
    )
  }
  return schemaVersion
}

/**
 * 把库从 previousVersion 迁到当前版本，返回本次实际执行的迁移 id。
 * 每一版各自一个事务；崩溃注入钩子在开始前、提交前、提交后各回调一次。
 */
export function migrateMemoryAuthorityV2(
  database: MemorySqliteDatabaseV2,
  previousVersion: number,
  options: OpenMemoryAuthorityOptionsV2
): readonly string[] {
  if (previousVersion === MemoryAuthorityFormatIdentityV2.schemaVersion) return []
  const applied: string[] = []
  const now = options.now ?? Date.now

  if (previousVersion < 1) {
    options.migrationHooks?.beforeMigration?.(1)
    const apply = database.transaction(() => {
      applyMemoryAuthoritySchemaV2(database, now())
      database.pragma(`application_id = ${MemoryAuthorityFormatIdentityV2.applicationId}`)
      database.pragma('user_version = 1')
      options.migrationHooks?.afterApplyBeforeCommit?.(1)
    })
    apply()
    options.migrationHooks?.afterMigration?.(1)
    applied.push(MemoryAuthorityMigrationIdV2)
  }
  if (previousVersion < 2) {
    options.migrationHooks?.beforeMigration?.(2)
    const apply = database.transaction(() => {
      applyMemoryAuthorityMeaningEvidenceMigrationV2(database, now())
      database.pragma('user_version = 2')
      options.migrationHooks?.afterApplyBeforeCommit?.(2)
    })
    apply()
    options.migrationHooks?.afterMigration?.(2)
    applied.push(MemoryAuthorityMeaningEvidenceMigrationIdV2)
  }
  if (previousVersion < 3) {
    options.migrationHooks?.beforeMigration?.(3)
    const apply = database.transaction(() => {
      applyMemoryAuthorityEvidenceReplayMigrationV2(database, now())
      database.pragma('user_version = 3')
      options.migrationHooks?.afterApplyBeforeCommit?.(3)
    })
    apply()
    options.migrationHooks?.afterMigration?.(3)
    applied.push(MemoryAuthorityEvidenceReplayMigrationIdV2)
  }

  return applied
}

/**
 * 迁移完成后的自检：身份与版本、迁移账本、表前缀、禁用的明文列、未登记的盲索引列、
 * SQLite quick_check。任何一条不过都抛 INVARIANT——这是密文边界的守门人。
 */
export function assertMemoryAuthoritySchemaV2(database: MemorySqliteDatabaseV2): void {
  const applicationId = readIntegerPragmaV2(database, 'application_id')
  const schemaVersion = readIntegerPragmaV2(database, 'user_version')
  if (
    applicationId !== MemoryAuthorityFormatIdentityV2.applicationId ||
    schemaVersion !== MemoryAuthorityFormatIdentityV2.schemaVersion
  ) {
    throw new AppError(
      'INVARIANT',
      'Memory Tree v2 authority 数据库身份或 schema 版本失配。',
      undefined,
      { applicationId, schemaVersion }
    )
  }

  const migrations = database
    .prepare(
      `SELECT version, migration_id
       FROM memory_schema_migrations
       ORDER BY version`
    )
    .all() as MemoryAuthorityMigrationRowV2[]
  if (
    migrations.length !== MemoryAuthorityFormatIdentityV2.schemaVersion ||
    migrations[0]?.version !== 1 ||
    migrations[0]?.migration_id !== MemoryAuthorityMigrationIdV2 ||
    migrations[1]?.version !== 2 ||
    migrations[1]?.migration_id !== MemoryAuthorityMeaningEvidenceMigrationIdV2 ||
    migrations[2]?.version !== 3 ||
    migrations[2]?.migration_id !== MemoryAuthorityEvidenceReplayMigrationIdV2
  ) {
    throw new AppError(
      'INVARIANT',
      'Memory Tree v2 authority migration 账本与 user_version 不一致。',
      undefined,
      { migrations, schemaVersion }
    )
  }

  const forbiddenColumns = new Set<string>(MemoryAuthorityForbiddenPlaintextColumnsV2)
  const blindColumns = new Set<string>(MemoryAuthorityBlindIndexColumnsV2)
  for (const table of listAuthorityUserTablesV2(database)) {
    if (!table.startsWith(MemoryAuthorityTablePrefixV2)) {
      throw new AppError(
        'INVARIANT',
        'Memory Tree v2 authority 出现非包所有的用户表。',
        undefined,
        { table }
      )
    }
    const columns = database.pragma(
      `table_info(${quoteSqliteIdentifierV2(table)})`
    ) as MemoryAuthorityNameRowV2[]
    for (const { name } of columns) {
      if (forbiddenColumns.has(name)) {
        throw new AppError(
          'INVARIANT',
          'Memory Tree v2 authority 出现禁止的明文语义列。',
          undefined,
          { table, column: name }
        )
      }
      if (name.endsWith('_match_key') && !blindColumns.has(name)) {
        throw new AppError(
          'INVARIANT',
          'authority schema 出现未登记 purpose 的盲索引列。',
          undefined,
          { table, column: name }
        )
      }
    }
  }

  const quickCheck = database.pragma('quick_check(1)', { simple: true })
  if (quickCheck !== 'ok') {
    throw new AppError('INVARIANT', 'Memory Tree v2 authority quick_check 失败。', undefined, {
      quickCheck,
    })
  }
}

/** 把标识符包成 SQLite 的双引号形式（内部双引号翻倍），拼 pragma 时用。 */
export function quoteSqliteIdentifierV2(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}
