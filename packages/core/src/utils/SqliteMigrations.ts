import { AppError } from '../error'
import { isObject } from '../typeGuards'

import { isEmpty } from './array'

/** 迁移步骤能够使用的同步数据库接口。 */
export interface SqliteMigrationDatabase {
  exec(source: string): unknown
  prepare(source: string): {
    all(...parameters: readonly unknown[]): readonly unknown[]
    run(...parameters: readonly unknown[]): unknown
  }
}

/** 迁移运行器额外需要宿主事务边界。 */
export interface SqliteMigrationConnection extends SqliteMigrationDatabase {
  readonly inTransaction: boolean
  transaction<Result>(operation: () => Result): () => Result
}

/** 一个按版本登记的同步迁移。 */
export interface SqliteMigration {
  readonly version: number
  readonly name: string
  readonly upSql?: string
  readonly up?: (database: SqliteMigrationDatabase) => void
}

export interface SqliteMigrationStatus {
  readonly currentVersion: number
  readonly latestVersion: number
  readonly pendingVersions: readonly number[]
}

/** 迁移计划与所有版本记录在一次事务内提交；备份和数据目录由宿主负责。 */
export interface SqliteMigrationsApi {
  /** 只读评估，尚无迁移表时按空历史处理。 */
  getStatus(): SqliteMigrationStatus
  /** 原子应用所有待执行步骤，任何一步失败均回滚本次整批迁移。 */
  migrate(): void
}

class SqliteMigrations implements SqliteMigrationsApi {
  private readonly migrations: readonly SqliteMigration[]

  public constructor(
    private readonly database: SqliteMigrationConnection,
    migrations: readonly SqliteMigration[]
  ) {
    this.migrations = migrations.map((migration) => ({ ...migration }))
    this.migrations.forEach((migration, index) => {
      const previous = this.migrations[index - 1]?.version ?? 0
      if (!Number.isSafeInteger(migration.version) || migration.version <= previous || !migration.name.trim())
        throw new AppError('STORAGE', 'Invalid SQLite migration identity', undefined, { version: migration.version })
      if (Boolean(migration.upSql?.trim()) === Boolean(migration.up))
        throw new AppError('STORAGE', 'Migration must define exactly one of upSql or up', undefined, { version: migration.version })
    })
  }

  public getStatus(): SqliteMigrationStatus {
    const hasTable = this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").all().length > 0
    const rows = hasTable
      ? this.database.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>
      : []
    const currentVersion = rows.at(-1)?.version ?? 0
    const latestVersion = this.migrations.at(-1)?.version ?? 0
    if (currentVersion > latestVersion)
      throw new AppError('STORAGE_SCHEMA_AHEAD', 'SQLite schema is newer than the migration plan', undefined, { currentVersion, latestVersion })
    const known = new Set(this.migrations.map(({ version }) => version))
    if (rows.some(({ version }) => !known.has(version)))
      throw new AppError('STORAGE', 'SQLite migration history contains unknown versions')
    const applied = new Set(rows.map(({ version }) => version))
    return { currentVersion, latestVersion, pendingVersions: this.migrations.filter(({ version }) => !applied.has(version)).map(({ version }) => version) }
  }

  public migrate(): void {
    if (this.database.inTransaction) throw new AppError('STORAGE', 'SQLite migrations require their own transaction')
    this.database.transaction(() => {
      const status = this.getStatus()
      if (isEmpty(status.pendingVersions)) return
      this.database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
      ) STRICT`)
      const record = this.database.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      for (const migration of this.migrations) {
        if (!status.pendingVersions.includes(migration.version)) continue
        try {
          if (migration.up) {
            const result: unknown = migration.up(this.database)
            if (isObject(result) && 'then' in result)
              throw new AppError('STORAGE', 'SQLite migrations must be synchronous')
          } else this.database.exec(migration.upSql!)
          record.run(migration.version, migration.name, Date.now())
        } catch (cause) {
          throw new AppError('STORAGE', `SQLite migration v${migration.version} failed`, cause, { version: migration.version, name: migration.name })
        }
      }
    })()
  }
}

/** 创建与 SQLite 驱动无关的同步迁移运行器。 */
export function createSqliteMigrations(
  database: SqliteMigrationConnection,
  migrations: readonly SqliteMigration[]
): SqliteMigrationsApi {
  return new SqliteMigrations(database, migrations)
}
