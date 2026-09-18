/** utils 的单元测试：预算裁剪、体量判定、手滑判据、包装约定。不起隔离进程。 */

import { describe, expect, test } from 'bun:test'

import { CodeSurfaceErrorCodes, CodeSurfaceLimits } from '../src/contract/constants'
import { enforceResultBudget, fitJournalToBudget, fitLogsToBudget, fitValueToBudget } from '../src/utils/budget'
import { isTypeScriptOnlySyntax } from '../src/utils/compiler'
import { applyProgramEdits } from '../src/utils/edit'
import { readProgramImports, rewriteModuleForIsolate } from '../src/utils/module-form'
import { keepTail, readCapabilityNamespace } from '../src/utils/program'
import { describeProgramOversize } from '../src/utils/result'
import { describeChildExit } from '../src/utils/runner-bridge'
import { CodeSurfaceTuning } from '../src/utils/tuning'

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
    expect(notices[0]?.detail).toContain('先看大小、筛好了再导出')
  })

  test('undefined 不算返回值，不进结果也不留 notice', () => {
    const notices: unknown[] = []
    expect(fitValueToBudget(undefined, notices as never)).toBeUndefined()
    expect(notices).toHaveLength(0)
  })

  test('执行账只折连着的那几笔，隔开的同名调用仍然分成两条', () => {
    const notices: unknown[] = []
    const folded = fitJournalToBudget(
      [
        { call: 'demo.read', ok: true },
        { call: 'demo.read', ok: true },
        { call: 'demo.read', ok: false },
        { call: 'demo.read', ok: true },
      ],
      notices as never
    )
    expect(folded).toEqual([
      { call: 'demo.read', ok: true, times: 2 },
      { call: 'demo.read', ok: false },
      { call: 'demo.read', ok: true },
    ])
    expect(notices).toHaveLength(0)
  })

  test('账太长时保留结尾并说明——中断现场在尾部', () => {
    const notices: Array<{ detail: string }> = []
    const many = Array.from({ length: CodeSurfaceTuning.journalEntries + 5 }, (_, index) => ({
      call: `demo.op${index}`,
      ok: true,
    }))
    const folded = fitJournalToBudget(many, notices as never)
    expect(folded).toHaveLength(CodeSurfaceTuning.journalEntries)
    expect(folded.at(-1)?.call).toBe(`demo.op${many.length - 1}`)
    expect(notices[0]?.detail).toContain('前 5 条省略')
  })
})

void describe('总量硬闸', () => {
  test('哪条通道忘了设上限，整份结果照样被压回总上限以内；失败说明永远留着', () => {
    const oversized = {
      value: 'v'.repeat(CodeSurfaceLimits.resultChars),
      logs: ['l'.repeat(CodeSurfaceLimits.resultChars)],
      completed: Array.from({ length: 5000 }, (_, index) => ({ call: `demo.op${index}`, ok: true })),
      failed: { code: 'PROGRAM_ERROR' as const, message: '要紧的那句' },
    }
    const fitted = enforceResultBudget(oversized)
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(CodeSurfaceLimits.resultChars)
    expect(fitted.failed?.message).toBe('要紧的那句')
    expect(fitted.notices?.[0]?.detail).toContain('总上限')
  })

  test('没超就原样放行，一个字不动', () => {
    const small = { value: { ok: true }, logs: ['一行'] }
    expect(enforceResultBudget(small)).toBe(small)
  })
})

void describe('子进程崩溃判读', () => {
  test('堆爆认成 TOO_LARGE，并把上限和下一步一起说了', () => {
    const fatal = [
      '<--- Last few GCs --->',
      '[1:0x0] 766 ms: Mark-Compact (reduce) 507.5 (513.4) -> 507.2 (510.4) MB',
      'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory',
      '----- Native stack trace -----',
    ].join('\n')
    const described = describeChildExit(null, fatal)
    expect(described.code).toBe(CodeSurfaceErrorCodes.tooLarge)
    expect(described.message).toContain(String(CodeSurfaceTuning.heapMb))
    expect(described.message).toContain('边拿边筛')
  })

  test('别的崩溃把 stderr 的开头引给模型；什么都没有时也得说清是码还是信号', () => {
    const withStderr = describeChildExit(1, 'ReferenceError: velar is not defined\n    at file:///x.mjs:3:1')
    expect(withStderr.code).toBe(CodeSurfaceErrorCodes.runnerCrashed)
    expect(withStderr.message).toContain('ReferenceError')
    expect(describeChildExit(null, '').message).toContain('被信号杀掉')
    expect(describeChildExit(7, '').message).toContain('码 7')
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

void describe('模块形态', () => {
  test('能力模块名剥出命名空间；别的模块名不认', () => {
    expect(readCapabilityNamespace('velar:files')).toBe('files')
    expect(readCapabilityNamespace('node:fs')).toBeNull()
  })

  test('import 与租约挖得出来；没写租约就没有那一格', () => {
    const program = (attribute: string) =>
      [`import { read } from 'velar:demo'${attribute}`, 'export default 1'].join('\n')
    expect(readProgramImports(program(" with { lease: 'task' }"))).toEqual([
      { namespace: 'demo', specifier: 'velar:demo', lease: 'task' },
    ])
    expect(readProgramImports(program(''))).toEqual([{ namespace: 'demo', specifier: 'velar:demo' }])
    // 认不出的租约值当没写：宿主按缺省策略处理，不为一个拼错的字废掉一轮
    expect(readProgramImports(program(" with { lease: '3turns' }"))).toEqual([
      { namespace: 'demo', specifier: 'velar:demo' },
    ])
  })

  test('改写成隔离能跑的形状时，模型写的那些行一行都不挪——否则抛错的行号就对不上', () => {
    const source = ["import { read } from 'velar:demo'", 'const r = await read({})', 'export default r'].join('\n')
    const lines = rewriteModuleForIsolate(source).split('\n')
    // 原来三行各在原位，交出的那句接在后面
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('const { read } = __velar("velar:demo")')
    expect(lines[1]).toBe('const r = await read({})')
    expect(lines[2]).toBe('__exports.default = r;')
    expect(lines[3]).toContain('return')
  })

  test('具名导出去掉 export 时换成等长空白，列号也不挪；解构出来的名字一个不漏', () => {
    const source = ['export const { a, b: [c] } = { a: 1, b: [2] }', 'export function f() {}', 'const x = 1', 'export { x as y }'].join('\n')
    const lines = rewriteModuleForIsolate(source).split('\n')
    expect(lines[0]).toContain('       const { a, b: [c] }')
    expect(lines[1]).toBe('       function f() {}')
    expect(lines[3]).toBe('')
    expect(lines[4]).toContain('__exports["a"] = a;')
    expect(lines[4]).toContain('__exports["c"] = c;')
    expect(lines[4]).toContain('__exports["f"] = f;')
    expect(lines[4]).toContain('__exports["y"] = x;')
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
      { oldText: 'abcd', newText: 'X' },
      { oldText: 'cdef', newText: 'Y' },
    ])
    expect('failed' in applied && applied.failed).toContain('重叠')
  })

  test('oldText 不唯一、找不到或是空的，整组不落并说清是第几处', () => {
    const repeated = applyProgramEdits('a = 1\na = 1', [{ oldText: 'a = 1', newText: 'a = 2' }])
    expect('failed' in repeated && repeated.failed).toContain('第 1 处')
    expect('failed' in repeated && repeated.failed).toContain('不止一次')
    const missing = applyProgramEdits('const a = 1', [{ oldText: 'a = 1', newText: 'a = 2' }, { oldText: 'b', newText: 'c' }])
    expect('failed' in missing && missing.failed).toContain('第 2 处')
    const empty = applyProgramEdits('const a = 1', [{ oldText: '', newText: 'x' }])
    expect('failed' in empty && empty.failed).toContain('oldText 是空的')
  })
})
