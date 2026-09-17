/** utils 的单元测试：预算裁剪、体量判定、手滑判据、包装约定。不起隔离进程。 */

import { describe, expect, test } from 'bun:test'

import { CodeSurfaceLimits } from '../src/contract/constants'
import { fitLogsToBudget, fitValueToBudget } from '../src/utils/budget'
import { isTypeScriptOnlySyntax } from '../src/utils/compiler'
import { keepTail, wrapProgramSource } from '../src/utils/program'
import { applyProgramEdits } from '../src/utils/edit'
import { describeProgramOversize } from '../src/utils/result'

void describe('预算裁剪', () => {
  test('没超预算时一个字不动，也不留 notice', () => {
    const notices: Array<{ action: string }> = []
    expect(fitLogsToBudget(['第一行', '第二行'], notices as never)).toEqual(['第一行', '第二行'])
    expect(notices).toHaveLength(0)
  })

  test('保留的是结尾不是开头——失败现场在尾部', () => {
    const { text, dropped } = keepTail('abcdefghij', 4)
    expect(text.endsWith('ghij')).toBe(true)
    expect(dropped).toBe(6)
    expect(text).toContain('省略')
  })

  test('返回值超上限时截断并说清省了多少', () => {
    const notices: Array<{ action: string; detail: string }> = []
    const fitted = fitValueToBudget('x'.repeat(CodeSurfaceLimits.valueChars + 100), notices as never)
    expect(String(fitted)).toContain('字符省略')
    expect(notices[0]?.action).toBe('truncated')
    expect(notices[0]?.detail).toContain('先筛一遍再 return')
  })

  test('undefined 不算返回值，不进结果也不留 notice', () => {
    const notices: unknown[] = []
    expect(fitValueToBudget(undefined, notices as never)).toBeUndefined()
    expect(notices).toHaveLength(0)
  })
})

void describe('体量判定', () => {
  test('源码与 blobs 各自看自己的上限，没超返回 null', () => {
    expect(describeProgramOversize('return 1', undefined)).toBeNull()
    expect(describeProgramOversize('x'.repeat(CodeSurfaceLimits.sourceChars + 1), undefined)).toContain('程序正文')
    expect(
      describeProgramOversize('return 1', { a: 'x'.repeat(CodeSurfaceLimits.blobChars + 1) })
    ).toContain('blobs 合计')
  })

  test('超限的说明要给出下一步，不是只说「太大了」', () => {
    const message = describeProgramOversize('x'.repeat(CodeSurfaceLimits.sourceChars + 1), undefined)
    expect(message).toContain('拆成几次')
  })
})

void describe('手滑判据', () => {
  test('只认 TS8xxx 那一族；真类型错（2xxx）与语法错（1xxx）都不算手滑', () => {
    expect(isTypeScriptOnlySyntax(8016)).toBe(true)
    expect(isTypeScriptOnlySyntax(8010)).toBe(true)
    expect(isTypeScriptOnlySyntax(2551)).toBe(false)
    expect(isTypeScriptOnlySyntax(1005)).toBe(false)
    expect(isTypeScriptOnlySyntax(8100)).toBe(false)
  })
})

void describe('包装约定', () => {
  test('`{` 后面紧跟换行，模型写的第 1 行就落在文件第 1 行', () => {
    const wrapped = wrapProgramSource('return 1')
    expect(wrapped.split('\n')[1]).toBe('return 1')
  })
})

void describe('在上一份程序上改', () => {
  test('oldText 唯一时落得下去；多处改动从后往前落，偏移不会互相挪动', () => {
    const previous = 'const a = 1\nconst b = 2\nreturn a + b'
    const applied = applyProgramEdits(previous, [
      { oldText: 'a = 1', newText: 'a = 10' },
      { oldText: 'b = 2', newText: 'b = 20' },
    ])
    expect('source' in applied && applied.source).toBe('const a = 10\nconst b = 20\nreturn a + b')
  })

  test('重叠的两处一律不落：模型对原文的判断已经错了，硬落更危险', () => {
    const applied = applyProgramEdits('abcdef', [
      { range: { offset: 0, end: 4 }, newText: 'X' },
      { range: { offset: 2, end: 6 }, newText: 'Y' },
    ])
    expect('failed' in applied && applied.failed).toContain('重叠')
  })

  test('空区间就是在那个位置插入', () => {
    const applied = applyProgramEdits('ab', [{ range: { offset: 1, end: 1 }, newText: 'X' }])
    expect('source' in applied && applied.source).toBe('aXb')
  })
})
