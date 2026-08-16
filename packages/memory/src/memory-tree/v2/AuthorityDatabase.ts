import { existsSync } from 'node:fs'

import BetterSqlite3 from 'better-sqlite3'

import { AppError } from '@velaros-ai/core/error'

import {
  type MemoryPhysicalRootsOpenReportV2,
  type MemoryPhysicalRootsV2,
  openMemoryPhysicalRootsV2,
} from './storage/PhysicalRoots'
import {
  applyMemoryAuthorityEvidenceReplayMigrationV2,
  applyMemoryAuthorityMeaningEvidenceMigrationV2,
  applyMemoryAuthoritySchemaV2,
  MemoryAuthorityApplicationIdV2,
  MemoryAuthorityBlindIndexColumnsV2,
  MemoryAuthorityEvidenceReplayMigrationIdV2,
  MemoryAuthorityForbiddenPlaintextColumnsV2,
  MemoryAuthorityMeaningEvidenceMigrationIdV2,
  MemoryAuthorityMigrationIdV2,
  MemoryAuthoritySchemaVersionV2,
} from './AuthoritySchema'

type SQLiteDatabase = InstanceType<typeof BetterSqlite3>

const AuthorityTablePrefixV2 = 'memory_'
const SQLiteInternalPrefix = 'sqlite_'

export interface MemoryAuthorityMigrationHooksV2 {
  readonly beforeMigration?: (version: number) => void
  readonly afterApplyBeforeCommit?: (version: number) => void
  readonly afterMigration?: (version: number) => void
}

export interface OpenMemoryAuthorityOptionsV2 {
  readonly now?: () => number
  readonly migrationHooks?: MemoryAuthorityMigrationHooksV2
}

export interface MemoryAuthorityOpenReportV2 {
  readonly databaseCreated: boolean
  readonly previousSchemaVersion: number
  readonly schemaVersion: number
  readonly appliedMigrations: readonly string[]
  readonly physicalRoots: MemoryPhysicalRootsOpenReportV2
}

export interface OpenMemoryAuthorityResultV2 {
  readonly store: MemoryAuthorityDatabaseV2
  readonly report: MemoryAuthorityOpenReportV2
}

/**
 * Memory Tree v2 权威库唯一 open/migrate owner。
 *
 * 该连接只承载结构、盲索引与密文引用。用户语义正文必须先经 ContentKeyServiceV2；
 * 派生明文投影必须进入加密 index generation，不能借本连接建 FTS 或树展示表。
 */
export class MemoryAuthorityDatabaseV2 {
  private closed = false

  private constructor(
    public readonly roots: MemoryPhysicalRootsV2,
    private readonly connection: SQLiteDatabase
  ) {}

  public static open(
    dataRoot: string,
    options: OpenMemoryAuthorityOptionsV2 = {}
  ): OpenMemoryAuthorityResultV2 {
    const openedRoots = openMemoryPhysicalRootsV2(dataRoot)
    const databaseCreated = !existsSync(openedRoots.roots.authorityDatabasePath)
    const database = new BetterSqlite3(openedRoots.roots.authorityDatabasePath)

    try {
      configureAuthorityConnectionV2(database)
      const previousSchemaVersion = inspectAuthorityIdentityV2(database)
      const appliedMigrations = migrateMemoryAuthorityV2(database, previousSchemaVersion, options)
      assertMemoryAuthoritySchemaV2(database)
      return {
        store: new MemoryAuthorityDatabaseV2(openedRoots.roots, database),
        report: {
          databaseCreated,
          previousSchemaVersion,
          schemaVersion: MemoryAuthoritySchemaVersionV2,
          appliedMigrations,
          physicalRoots: openedRoots.report,
        },
      }
    } catch (error) {
      database.close()
      throw error
    }
  }

  /**
   * 暂时暴露给 package 内 repository/service 组合层；renderer 与宿主不得持有此句柄。
   * Public consumers use the package-owned connection port instead of this internal handle.
   */
  public get database(): SQLiteDatabase {
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

export function openMemoryAuthorityV2(
  dataRoot: string,
  options: OpenMemoryAuthorityOptionsV2 = {}
): OpenMemoryAuthorityResultV2 {
  return MemoryAuthorityDatabaseV2.open(dataRoot, options)
}

function configureAuthorityConnectionV2(database: SQLiteDatabase): void {
  database.pragma('busy_timeout = 5000')
  database.pragma('foreign_keys = ON')
  database.pragma('journal_mode = WAL')
  database.pragma('synchronous = FULL')
  database.pragma('secure_delete = ON')
  database.pragma('temp_store = MEMORY')
  database.pragma('trusted_schema = OFF')
}

function inspectAuthorityIdentityV2(database: SQLiteDatabase): number {
  const applicationId = readIntegerPragmaV2(database, 'application_id')
  const schemaVersion = readIntegerPragmaV2(database, 'user_version')
  const userTables = listUserTablesV2(database)

  if (applicationId === 0 && schemaVersion === 0 && userTables.length === 0) return 0

  if (applicationId !== MemoryAuthorityApplicationIdV2) {
    throw new AppError(
      'VALIDATION',
      'authority.sqlite3 不是 Memory Tree v2 权威库，拒绝猜测或覆盖。',
      undefined,
      { applicationId, schemaVersion, userTables }
    )
  }
  if (schemaVersion < 1 || schemaVersion > MemoryAuthoritySchemaVersionV2) {
    throw new AppError(
      'VALIDATION',
      'Memory Tree v2 authority schema 版本不受当前运行时支持。',
      undefined,
      {
        schemaVersion,
        supportedVersion: MemoryAuthoritySchemaVersionV2,
      }
    )
  }
  return schemaVersion
}

function migrateMemoryAuthorityV2(
  database: SQLiteDatabase,
  previousVersion: number,
  options: OpenMemoryAuthorityOptionsV2
): readonly string[] {
  if (previousVersion === MemoryAuthoritySchemaVersionV2) return []
  const applied: string[] = []
  const now = options.now ?? Date.now

  if (previousVersion < 1) {
    options.migrationHooks?.beforeMigration?.(1)
    const apply = database.transaction(() => {
      applyMemoryAuthoritySchemaV2(database, now())
      database.pragma(`application_id = ${MemoryAuthorityApplicationIdV2}`)
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

export function assertMemoryAuthoritySchemaV2(database: SQLiteDatabase): void {
  const applicationId = readIntegerPragmaV2(database, 'application_id')
  const schemaVersion = readIntegerPragmaV2(database, 'user_version')
  if (
    applicationId !== MemoryAuthorityApplicationIdV2 ||
    schemaVersion !== MemoryAuthoritySchemaVersionV2
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
    .all() as Array<{ version: number; migration_id: string }>
  if (
    migrations.length !== 3 ||
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

  const tables = listUserTablesV2(database)
  const forbiddenColumns = new Set<string>(MemoryAuthorityForbiddenPlaintextColumnsV2)
  const blindColumns = new Set<string>(MemoryAuthorityBlindIndexColumnsV2)
  for (const table of tables) {
    if (!table.startsWith(AuthorityTablePrefixV2)) {
      throw new AppError(
        'INVARIANT',
        'Memory Tree v2 authority 出现非包所有的用户表。',
        undefined,
        { table }
      )
    }
    const columns = database.pragma(`table_info(${quoteIdentifierV2(table)})`) as Array<{
      name: string
    }>
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

function listUserTablesV2(database: SQLiteDatabase): string[] {
  return (
    database
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table'
           AND name NOT LIKE ?
         ORDER BY name`
      )
      .all(`${SQLiteInternalPrefix}%`) as Array<{ name: string }>
  ).map((row) => row.name)
}

function readIntegerPragmaV2(database: SQLiteDatabase, pragma: string): number {
  const value = database.pragma(pragma, { simple: true })
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new AppError('INVARIANT', 'SQLite pragma 未返回安全整数。', undefined, { pragma, value })
  }
  return value
}

function quoteIdentifierV2(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}
