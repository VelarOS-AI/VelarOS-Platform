import { describe, expect, test } from 'bun:test'

import { matchesAny } from '../src/utils/glob'
import {
  createMatcherCache,
  MatcherCacheCapacity,
} from '../src/utils/matcher-cache'

describe('glob matcher cache', () => {
  test('reuses compiled matchers and evicts the least recently used entry at capacity', () => {
    const compilations: string[] = []
    const getMatcher = createMatcherCache(2, (pattern) => {
      compilations.push(pattern)
      return (input) => input === pattern
    })

    const firstA = getMatcher('a')
    const firstB = getMatcher('b')
    expect(getMatcher('a')).toBe(firstA)
    expect(compilations).toEqual(['a', 'b'])

    getMatcher('c')
    expect(getMatcher('a')).toBe(firstA)
    expect(getMatcher('b')).not.toBe(firstB)
    expect(compilations).toEqual(['a', 'b', 'c', 'b'])
  })

  test('enforces a positive integer capacity', () => {
    const compile = () => () => true

    expect(() => createMatcherCache(0, compile)).toThrow(RangeError)
    expect(() => createMatcherCache(1.5, compile)).toThrow(RangeError)
  })

  test('failed compilation keeps the last good matcher cached', () => {
    let calls = 0
    const getMatcher = createMatcherCache(1, (pattern) => {
      calls++
      if (pattern === 'invalid') throw new SyntaxError('invalid pattern')
      return (input) => input === pattern
    })
    const good = getMatcher('good')
    expect(() => getMatcher('invalid')).toThrow(SyntaxError)
    expect(getMatcher('good')).toBe(good)
    expect(calls).toBe(2)
  })

  test('production capacity retains hot entries across repeated overflow', () => {
    const getMatcher = createMatcherCache(MatcherCacheCapacity, (pattern) => (input) => input === pattern)
    const hot = getMatcher('hot')
    const cold = getMatcher('cold')
    for (let index = 0; index < MatcherCacheCapacity * 4; index++) {
      getMatcher(`pattern-${index}`)
      expect(getMatcher('hot')).toBe(hot)
    }
    expect(getMatcher('cold')).not.toBe(cold)
  })
})

describe('glob matching semantics', () => {
  test('preserves exact, directory-prefix, glob, dotfile, and normalized-path matching', () => {
    expect(matchesAny('src/index.ts', ['src/index.ts'])).toBe(true)
    expect(matchesAny('src/nested/index.ts', ['src'])).toBe(true)
    expect(matchesAny('dist/nested/app.js', ['dist/'])).toBe(true)
    expect(matchesAny('src/index.ts', ['src/*.ts'])).toBe(true)
    expect(matchesAny('src/nested/index.ts', ['src/*.ts'])).toBe(false)
    expect(matchesAny('.github/workflows/check.yml', ['**/*.yml'])).toBe(true)
    expect(matchesAny('src\\nested\\index.ts', ['src/**'])).toBe(true)
    expect(matchesAny('src/index.js', ['src/*.{ts,tsx}'])).toBe(false)
  })
})
