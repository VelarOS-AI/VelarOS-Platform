/**
 * glob 匹配的实现细节：缓存、`dir/**` 的目录前缀语义、路径写法的规整。
 */

import { describe, expect, test } from 'bun:test'

import { PathMatcher } from '../src/impl/PathMatcher'
import { PathRulesTuning } from '../src/utils/tuning'

describe('PathMatcher', () => {
  test('dir/** 连目录自己一起命中，dir 部分带通配时走 picomatch', () => {
    const matcher = new PathMatcher()
    expect(matcher.matchesAny('pkg', ['pkg/**'])).toBe(true)
    expect(matcher.matchesAny('pkg/a/b.ts', ['pkg/**'])).toBe(true)
    expect(matcher.matchesAny('pkgx', ['pkg/**'])).toBe(false)
    expect(matcher.matchesAny('pkg-a/b.ts', ['pkg*/**'])).toBe(true)
    expect(matcher.matchesAny('pkg-a', ['pkg*/**'])).toBe(false)
  })

  test('反斜杠与开头的 ./ 都规整掉，两边都算', () => {
    const matcher = new PathMatcher()
    expect(matcher.matches('./src/a.ts', 'src\\a.ts')).toBe(true)
    expect(matcher.matches('src\\deep\\a.ts', './src/**')).toBe(true)
  })

  test('缓存超容量时淘汰最久没用的，结论不受影响', () => {
    const matcher = new PathMatcher()
    const total = PathRulesTuning.glob.matcherCacheEntries + 8
    for (let index = 0; index < total; index += 1) expect(matcher.matches(`a${index}/x.ts`, `a${index}/*.ts`)).toBe(true)
    // 第一条早被淘汰了，再问一次照样对。
    expect(matcher.matches('a0/x.ts', 'a0/*.ts')).toBe(true)
    expect(matcher.matches('a0/deep/x.ts', 'a0/*.ts')).toBe(false)
  })

  test('同一条规则按大小写敏感与否各缓存一份，互不串味', () => {
    const matcher = new PathMatcher()
    expect(matcher.matches('SRC/A.ts', 'src/*.ts', { caseSensitive: false })).toBe(true)
    expect(matcher.matches('SRC/A.ts', 'src/*.ts')).toBe(false)
    expect(matcher.matches('src/a.ts', 'src/*.ts')).toBe(true)
  })
})
