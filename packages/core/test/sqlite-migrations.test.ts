import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'

import { createSqliteMigrations } from '../src/utils/SqliteMigrations'

test('status is read-only and successful migrations commit their schema and version ledger together', () => {
  const database = new Database(':memory:')
  try {
    const runner = createSqliteMigrations(database, [
      { version: 1, name: 'base', upSql: 'CREATE TABLE records (value TEXT)' },
      {
        version: 2,
        name: 'seed',
        up: (db) => {
          db.prepare('INSERT INTO records VALUES (?)').run('kept')
        },
      },
    ])
    expect(runner.getStatus()).toEqual({
      currentVersion: 0,
      latestVersion: 2,
      pendingVersions: [1, 2],
    })
    expect(database.prepare('SELECT name FROM sqlite_master').all()).toEqual([])
    runner.migrate()
    runner.migrate()
    expect(database.prepare('SELECT * FROM records').all()).toEqual([{ value: 'kept' }])
    expect(runner.getStatus()).toEqual({ currentVersion: 2, latestVersion: 2, pendingVersions: [] })
  } finally {
    database.close()
  }
})

test('a later failure rolls back every pending migration while retaining previously committed data', () => {
  const database = new Database(':memory:')
  try {
    const initial = {
      version: 1,
      name: 'base',
      upSql: "CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('original')",
    }
    createSqliteMigrations(database, [initial]).migrate()
    const runner = createSqliteMigrations(database, [
      initial,
      { version: 2, name: 'update', upSql: "UPDATE records SET value = 'changed'" },
      { version: 3, name: 'failure', upSql: 'INSERT INTO missing VALUES (1)' },
    ])
    expect(() => runner.migrate()).toThrow('SQLite migration v3 failed')
    expect(database.prepare('SELECT * FROM records').all()).toEqual([{ value: 'original' }])
    expect(database.prepare('SELECT version FROM schema_migrations').all()).toEqual([
      { version: 1 },
    ])
    expect(runner.getStatus().pendingVersions).toEqual([2, 3])
  } finally {
    database.close()
  }
})

test('invalid plans and future histories are rejected without writing', () => {
  const database = new Database(':memory:')
  try {
    for (const version of [0, -1, 1.5, NaN])
      expect(() =>
        createSqliteMigrations(database, [{ version, name: 'invalid', upSql: 'SELECT 1' }])
      ).toThrow()
    expect(() => createSqliteMigrations(database, [{ version: 1, name: 'empty' }])).toThrow()
    createSqliteMigrations(database, [{ version: 2, name: 'future', upSql: 'SELECT 1' }]).migrate()
    expect(() =>
      createSqliteMigrations(database, [{ version: 1, name: 'old', upSql: 'SELECT 1' }]).migrate()
    ).toThrow('newer')
    expect(database.prepare('SELECT version FROM schema_migrations').all()).toEqual([
      { version: 2 },
    ])
  } finally {
    database.close()
  }
})

test('initial failure rolls back the version table and transactions cannot be nested', () => {
  const database = new Database(':memory:')
  try {
    const runner = createSqliteMigrations(database, [
      { version: 1, name: 'fail', upSql: 'INVALID SQL' },
    ])
    expect(() => runner.migrate()).toThrow()
    expect(database.prepare('SELECT name FROM sqlite_master').all()).toEqual([])
    database.exec('BEGIN')
    expect(() => runner.migrate()).toThrow('own transaction')
    database.exec('ROLLBACK')
  } finally {
    database.close()
  }
})
