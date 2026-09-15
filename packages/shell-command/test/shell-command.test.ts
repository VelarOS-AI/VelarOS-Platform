/** 命令策略的实现细节测试：对外承诺在 spec/acceptance.test.ts，这里补前缀命令与并发判定的边角。 */

import { describe, expect, test } from 'bun:test'

import { shellCommandPolicy } from '../src/exports/index'

describe('前缀命令', () => {
  test('env、time 本身只读，后面跟的命令才决定整条是否只读', () => {
    expect(shellCommandPolicy.isReadOnly('env')).toBe(true)
    expect(shellCommandPolicy.isReadOnly('env -u FOO')).toBe(true)
    expect(shellCommandPolicy.isReadOnly('time ls')).toBe(true)
    expect(shellCommandPolicy.isReadOnly('env rm -rf x')).toBe(false)
  })
})

describe('并发判定', () => {
  test('optIn（缺省）要求显式 parallel: true；关掉 optIn 时只有显式 parallel: false 才拒绝', () => {
    expect(shellCommandPolicy.isParallelSafe({ command: 'ls', parallel: true })).toBe(true)
    expect(shellCommandPolicy.isParallelSafe({ command: 'ls' })).toBe(false)
    expect(shellCommandPolicy.isParallelSafe({ command: 'ls' }, { optIn: false })).toBe(true)
    expect(shellCommandPolicy.isParallelSafe({ command: 'ls', parallel: false }, { optIn: false })).toBe(false)
  })

  test('转后台、要确认、非只读、命令不是字符串的一律不并发', () => {
    expect(shellCommandPolicy.isParallelSafe({ command: 'ls', parallel: true, background: true })).toBe(false)
    expect(shellCommandPolicy.isParallelSafe({ command: 'npm run dev', parallel: true })).toBe(false)
    expect(shellCommandPolicy.isParallelSafe({ command: 'touch x', parallel: true })).toBe(false)
    expect(shellCommandPolicy.isParallelSafe({ command: 42, parallel: true })).toBe(false)
  })
})
