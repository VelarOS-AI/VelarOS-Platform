/** utils 的单元测试：预算裁剪、体量判定、手滑判据、模块形态、底稿编辑、时间线的引用、逐行差量与附属模块路径。不起隔离进程。 */

import { describe, expect, test } from 'bun:test'

import { unifiedLineDiff } from '@velaros-ai/core/utils/textDiff'

import { CodeSurfaceErrorCodes, CodeSurfaceLimits } from '../src/contract/constants'
import { scriptPackageCompiler } from '../src/impl/ScriptPackageCompiler'
import {
  enforceResultBudget,
  fitJournalToBudget,
  fitLogsToBudget,
  fitValueToBudget,
} from '../src/utils/budget'
import { declaredModules, isTypeScriptOnlySyntax, sliceModuleExports } from '../src/utils/compiler'
import { applyProgramEdits } from '../src/utils/edit'
import { readModuleSpecifiers } from '../src/utils/module-form'
import { describeChildExit } from '../src/utils/process-error'
import { keepTail, readCapabilityNamespace } from '../src/utils/program'
import { checkScriptPath, resolveLibraryImport } from '../src/utils/refs'
import { describeProgramOversize } from '../src/utils/result'
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
    const fitted = fitValueToBudget(
      'x'.repeat(CodeSurfaceLimits.valueChars + 100),
      notices as never
    )
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
      completed: Array.from({ length: 5000 }, (_, index) => ({
        call: `demo.op${index}`,
        ok: true,
      })),
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
    const withStderr = describeChildExit(
      1,
      'ReferenceError: velaros is not defined\n    at file:///x.mjs:3:1'
    )
    expect(withStderr.code).toBe(CodeSurfaceErrorCodes.runnerCrashed)
    expect(withStderr.message).toContain('ReferenceError')
    expect(describeChildExit(null, '').message).toContain('被信号杀掉')
    expect(describeChildExit(7, '').message).toContain('码 7')
  })
})

void describe('体量判定', () => {
  test('源码看自己的上限，blobs 与 input 合在一起看；没超返回 null', () => {
    expect(describeProgramOversize('return 1', undefined)).toBeNull()
    expect(
      describeProgramOversize('x'.repeat(CodeSurfaceLimits.sourceChars + 1), undefined)
    ).toContain('脚本正文')
    expect(
      describeProgramOversize('return 1', { a: 'x'.repeat(CodeSurfaceLimits.blobChars + 1) })
    ).toContain('blobs 加 input 合计')
    const half = 'x'.repeat(CodeSurfaceLimits.blobChars / 2)
    expect(describeProgramOversize('return 1', { a: half }, { b: half })).toContain(
      'blobs 加 input 合计'
    )
  })

  test('超限的说明要给出下一步，不是只说「太大了」', () => {
    const message = describeProgramOversize(
      'x'.repeat(CodeSurfaceLimits.sourceChars + 1),
      undefined
    )
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
    expect(readCapabilityNamespace('velaros:files')).toBe('files')
    expect(readCapabilityNamespace('node:fs')).toBeNull()
  })
})

void describe('在底稿上改', () => {
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
    const missing = applyProgramEdits('const a = 1', [
      { oldText: 'a = 1', newText: 'a = 2' },
      { oldText: 'b', newText: 'c' },
    ])
    expect('failed' in missing && missing.failed).toContain('第 2 处')
    const empty = applyProgramEdits('const a = 1', [{ oldText: '', newText: 'x' }])
    expect('failed' in empty && empty.failed).toContain('oldText 是空的')
  })
})

test('静态依赖读取包含 import 与 re-export 并保持首次出现顺序', () => {
  expect(
    readModuleSpecifiers("import './a.js'; export * from './b.js'; export {x} from './a.js'")
  ).toEqual(['./a.js', './b.js'])
})

void describe('程序附属模块的路径', () => {
  test('脚本路径：相对、/ 分段、以 .js 结尾，每段不以点开头；相对 import 走不出库根', () => {
    expect(checkScriptPath('lib/changelog.js')).toBeNull()
    expect(checkScriptPath('lib/changelog.ts')).toContain('.js 结尾')
    expect(checkScriptPath('../x.js')).toContain('不合规矩')
    expect(checkScriptPath('.hidden.js')).toContain('不合规矩')
    expect(checkScriptPath(`${'a'.repeat(CodeSurfaceLimits.scriptPathChars)}.js`)).toContain('太长')
    expect(resolveLibraryImport(undefined, './lib/x.js')).toBe('lib/x.js')
    expect(resolveLibraryImport('lib/a/b.js', '../c.js')).toBe('lib/c.js')
    expect(resolveLibraryImport('lib/a.js', '../../x.js')).toBeNull()
  })
})

void describe('逐行差量', () => {
  test('和 git diff 一个样子：改动处前后带上下文，离得远的分成两块；一样时是空串', () => {
    const before = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`)
    const after = [...before]
    after[1] = 'line 2 changed'
    after[10] = 'line 11 changed'
    const diff = unifiedLineDiff(before.join('\n'), after.join('\n'), { from: 'a@1', to: 'a@2' })
    expect(diff.split('\n').slice(0, 2)).toEqual(['--- a@1', '+++ a@2'])
    expect(diff).toContain('@@ -1,5 +1,5 @@')
    expect(diff).toContain('-line 2\n+line 2 changed')
    expect(diff.match(/^@@/gmu)).toHaveLength(2)
    expect(unifiedLineDiff('same', 'same', { from: 'a', to: 'b' })).toBe('')
  })
})

describe('声明切片', () => {
  const declarations = `/** 读写一个东西。 */
declare module 'velaros:demo' {
  /** 读一个东西。 */
  export function read(input: ReadInput): Promise<ReadResult>
  /** 写一个东西。 */
  export function write(input: WriteInput): Promise<void>
  /** 读的入参。 */
  export interface ReadInput { path: string; options?: ReadOptions }
  export interface ReadOptions { encoding?: Encoding }
  export type Encoding = 'utf8' | 'base64'
  export interface ReadResult extends Base { text: string; parts: Array<Part> }
  export interface Base { size: number }
  export type Part = { kind: Encoding }
  export interface WriteInput { path: string; data: string }
}`

  test('切出一个导出：它自己加上签名传递用到的类型，保持原来的先后与注释', () => {
    const slice = sliceModuleExports(declarations, 'velaros:demo', ['read'])
    const text = slice.declarations ?? ''
    for (const name of [
      'function read',
      'interface ReadInput',
      'interface ReadOptions',
      'type Encoding',
      'interface ReadResult',
      'interface Base',
      'type Part',
    ])
      expect(text).toContain(name)
    expect(text).not.toContain('WriteInput')
    expect(text).not.toContain('function write')
    expect(text).toContain('/** 读的入参。 */')
    expect(text.indexOf('function read')).toBeLessThan(text.indexOf('interface ReadInput'))
    // 切出来的仍是一份能解析的模块声明
    expect([...(declaredModules(text).get('velaros:demo')?.names ?? [])]).toContain('read')
  })

  test('要的是类型名时切出这个类型与它用到的类型', () => {
    const text = sliceModuleExports(declarations, 'velaros:demo', ['ReadInput']).declarations ?? ''
    expect(text).toContain('interface ReadInput')
    expect(text).toContain('type Encoding')
    expect(text).not.toContain('function read')
  })

  test('INV-43 末尾操作切片保留模块共同规则，首操作不重复规则', () => {
    for (const name of ['read', 'write', 'ReadInput']) {
      const text = sliceModuleExports(declarations, 'velaros:demo', [name]).declarations ?? ''
      expect(text.split('/** 读写一个东西。 */')).toHaveLength(2)
      if (name === 'write') expect(text).not.toContain('/** 读一个东西。 */')
    }
    const externalDocs = `/** 所有操作只接受项目内路径。 */\ndeclare module 'velaros:demo' {\n/** 读取。 */\nexport function read(): Promise<void>\n/** 写入。 */\nexport function write(): Promise<void>\n}`
    const text = sliceModuleExports(externalDocs, 'velaros:demo', ['write']).declarations ?? ''
    expect(text).toStartWith('/** 所有操作只接受项目内路径。 */')
    expect(text).not.toContain('/** 读取。 */')
  })

  test('INV-43 多导出合并闭包、重载和循环类型，每个声明一次，缺失名称不交不完整合同', () => {
    const combined = declarations.replace(
      'export interface WriteInput { path: string; data: string }',
      'export interface WriteInput { path: string; data: string; options?: ReadOptions; cycle?: Cycle }\nexport interface Cycle { next?: Cycle }\nexport function read(input: string): Promise<ReadResult>'
    )
    const slice = sliceModuleExports(combined, 'velaros:demo', ['write', 'read', 'write'])
    const text = slice.declarations ?? ''
    expect(slice.missing).toEqual([])
    expect(text.match(/function read/gu)).toHaveLength(2)
    for (const declaration of [
      'interface ReadOptions',
      'type Encoding',
      'interface Cycle',
      '读写一个东西。',
    ])
      expect(text.split(declaration)).toHaveLength(2)
    expect(sliceModuleExports(combined, 'velaros:demo', ['read', 'absent'])).toEqual({
      declarations: null,
      exports: ['read', 'write'],
      missing: ['absent'],
    })
  })

  test('INV-43 内容版本覆盖类型文档和模板，真实值导出不混入类型', () => {
    const first = scriptPackageCompiler.index(declarations, 'velaros:demo', '// example')
    expect(first.exports).toEqual(['read', 'write'])
    expect(scriptPackageCompiler.index(declarations, 'velaros:demo', '// example')).toEqual(first)
    expect(
      scriptPackageCompiler.index(
        declarations.replace('读的入参。', '路径相对工作区。'),
        'velaros:demo',
        '// example'
      ).contentRevision
    ).not.toBe(first.contentRevision)
    expect(
      scriptPackageCompiler.index(declarations, 'velaros:demo', '// changed example')
        .contentRevision
    ).not.toBe(first.contentRevision)
  })

  test('模块里没有这个名字：declarations 为 null，交回它导出的值', () => {
    expect(sliceModuleExports(declarations, 'velaros:demo', ['remove'])).toEqual({
      declarations: null,
      exports: ['read', 'write'],
      missing: ['remove'],
    })
    expect(sliceModuleExports(declarations, 'velaros:other', ['read'])).toEqual({
      declarations: null,
      exports: [],
      missing: ['read'],
    })
  })
})
