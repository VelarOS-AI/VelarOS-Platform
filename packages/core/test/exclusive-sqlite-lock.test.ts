import { describe, expect, test } from 'bun:test'

import { createExclusiveSqliteLock } from '../src/utils/ExclusiveSqliteLock'

describe('exclusive SQLite lock lifecycle', () => {
  test('holds one connection until release, then permits reacquisition', () => {
    let opens = 0
    let closes = 0
    const statements: string[] = []
    const lock = createExclusiveSqliteLock(() => {
      opens++
      return {
        exec: (sql) => {
          statements.push(sql)
        },
        close: () => {
          closes++
        },
      }
    })
    expect(lock.acquire()).toBe(true)
    expect(lock.acquire()).toBe(true)
    expect(opens).toBe(1)
    expect(statements).toEqual(['PRAGMA journal_mode = DELETE', 'BEGIN EXCLUSIVE'])
    lock.release()
    lock.release()
    expect(closes).toBe(1)
    expect(lock.acquire()).toBe(true)
    expect(opens).toBe(2)
    lock.release()
  })

  test('busy errors deny ownership and all failed acquisitions close their connection', () => {
    for (const code of ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_CORRUPT']) {
      let closes = 0
      const error = Object.assign(new Error(code), { code })
      const lock = createExclusiveSqliteLock(() => ({
        exec() {
          throw error
        },
        close() {
          closes++
        },
      }))
      if (code === 'SQLITE_CORRUPT') expect(() => lock.acquire()).toThrow(error)
      else expect(lock.acquire()).toBe(false)
      expect(closes).toBe(1)
    }
  })

  test('failed cleanup is retryable and never becomes acquired ownership', () => {
    let opens = 0
    let closes = 0
    const lock = createExclusiveSqliteLock(() => {
      opens++
      return {
        exec() {
          if (opens === 1) throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' })
        },
        close() {
          if (++closes === 1) throw new Error('close failed')
        },
      }
    })
    expect(() => lock.acquire()).toThrow(AggregateError)
    expect(lock.acquire()).toBe(true)
    expect(opens).toBe(2)
    expect(closes).toBe(2)
    lock.release()
  })

  test('Node builtin SQLite numeric primary and extended busy codes deny ownership', () => {
    for (const errcode of [5, 6, 261, 262]) {
      const lock = createExclusiveSqliteLock(() => ({
        exec() {
          throw Object.assign(new Error('busy'), { code: 'ERR_SQLITE_ERROR', errcode })
        },
        close() {},
      }))
      expect(lock.acquire()).toBe(false)
    }
  })

  test('a failed release retains owned connection until a successful retry', () => {
    let opens = 0
    let closes = 0
    const lock = createExclusiveSqliteLock(() => {
      opens++
      return {
        exec() {},
        close() {
          if (++closes === 1) throw new Error('close failed')
        },
      }
    })
    expect(lock.acquire()).toBe(true)
    expect(() => lock.release()).toThrow('close failed')
    expect(lock.acquire()).toBe(true)
    expect(opens).toBe(1)
    lock.release()
    expect(closes).toBe(2)
  })
})
