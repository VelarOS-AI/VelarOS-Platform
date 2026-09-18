/** utils 的单元测试：预算裁剪、体量判定、手滑判据、模块改写、底稿编辑、时间线的引用、逐行差量、工作区标记、重放核对。不起隔离进程。 */

import { describe, expect, test } from 'bun:test'

import { CodeSurfaceErrorCodes, CodeSurfaceLimits } from '../src/contract/constants'
import { enforceResultBudget, fitJournalToBudget, fitLogsToBudget, fitValueToBudget } from '../src/utils/budget'
import { isTypeScriptOnlySyntax } from '../src/utils/compiler'
import { applyProgramEdits } from '../src/utils/edit'
import { unifiedLineDiff } from '../src/utils/line-diff'
import { buildMarkerTree, diffFileMaps, diffMarkerTrees, markerFiles } from '../src/utils/markers'
import { readModuleSpecifiers, readProgramImports, rewriteModuleForIsolate } from '../src/utils/module-form'
import { keepTail, readCapabilityNamespace } from '../src/utils/program'
import { checkScriptPath, parseTimelineRef, resolveLibraryImport } from '../src/utils/refs'
import { replayPostMismatches, replayPreMismatches } from '../src/utils/replay'
import { describeProgramOversize } from '../src/utils/result'
import { describeChildExit } from '../src/utils/runner-bridge'
import { markerAt, selectHistory } from '../src/utils/timeline'
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
  test('源码看自己的上限，blobs 与 input 合在一起看；没超返回 null', () => {
    expect(describeProgramOversize('return 1', undefined)).toBeNull()
    expect(describeProgramOversize('x'.repeat(CodeSurfaceLimits.sourceChars + 1), undefined)).toContain('脚本正文')
    expect(
      describeProgramOversize('return 1', { a: 'x'.repeat(CodeSurfaceLimits.blobChars + 1) })
    ).toContain('blobs 加 input 合计')
    const half = 'x'.repeat(CodeSurfaceLimits.blobChars / 2)
    expect(describeProgramOversize('return 1', { a: half }, { b: half })).toContain('blobs 加 input 合计')
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
    const missing = applyProgramEdits('const a = 1', [{ oldText: 'a = 1', newText: 'a = 2' }, { oldText: 'b', newText: 'c' }])
    expect('failed' in missing && missing.failed).toContain('第 2 处')
    const empty = applyProgramEdits('const a = 1', [{ oldText: '', newText: 'x' }])
    expect('failed' in empty && empty.failed).toContain('oldText 是空的')
  })
})

void describe('库里的脚本改写', () => {
  test('相对 import 落到库里的路径、等它跑完；能力模块照旧同步取桩', () => {
    const source = ["import { read } from 'velar:demo'", "import { parse } from './util.js'", "import * as all from '../shared/all.js'", 'export default parse(read)'].join('\n')
    const lines = rewriteModuleForIsolate(source, { importer: 'lib/tools/main.js' }).split('\n')
    expect(lines[0]).toContain('const { read } = __velar("velar:demo")')
    expect(lines[1]).toBe('const { parse } = (await __import("lib/tools/util.js"));')
    expect(lines[2]).toBe('const all = (await __import("lib/shared/all.js"));')
    expect(readModuleSpecifiers(source)).toEqual(['velar:demo', './util.js', '../shared/all.js'])
  })

  test('转出去的就地取出来、末尾登记；export * 不转 default；库里的脚本总是交整个导出对象', () => {
    const source = ["export { parse as read } from './util.js'", "export * from './more.js'", "export * as ns from 'velar:demo'", 'export const x = 1'].join('\n')
    const output = rewriteModuleForIsolate(source, { importer: 'lib/index.js', library: true })
    const lines = output.split('\n')
    expect(lines[0]).toBe('const __exports = {}; const __reexport0 = (await __import("lib/util.js"));')
    expect(lines[1]).toBe('const __reexport1 = (await __import("lib/more.js"));')
    expect(lines[2]).toBe('const __reexport2 = __velar("velar:demo");')
    expect(lines[4]).toContain("if (name !== 'default') __exports[name] = value;")
    expect(lines[4]).toContain('__exports["read"] = __reexport0["parse"];')
    expect(lines[4]).toContain('__exports["ns"] = __reexport2;')
    expect(lines[4].endsWith('return __exports;')).toBe(true)
  })

  test('跨几行的 import 换完补足换行，后面每一行的行号都不挪', () => {
    const source = ['import {', '  read,', '  write,', "} from 'velar:demo'", 'const r = await read({})', 'export default r'].join('\n')
    const lines = rewriteModuleForIsolate(source).split('\n')
    expect(lines[0]).toContain('const { read, write } = __velar("velar:demo");')
    expect(lines[4]).toBe('const r = await read({})')
    expect(lines[5]).toBe('__exports.default = r;')
  })
})

void describe('时间线的引用', () => {
  test('调用、步骤、脚本（带不带版本）、now 各自认得出；认不出的说清楚怎么写', () => {
    expect(parseTimelineRef('C14')).toEqual({ kind: 'call', call: 14 })
    expect(parseTimelineRef('C14.2')).toEqual({ kind: 'step', call: 14, step: 2 })
    expect(parseTimelineRef('lib/x.js')).toEqual({ kind: 'script', path: 'lib/x.js' })
    expect(parseTimelineRef('lib/x.js@3')).toEqual({ kind: 'script', path: 'lib/x.js', version: 3 })
    expect(parseTimelineRef('now')).toEqual({ kind: 'now' })
    expect(parseTimelineRef('C14.x')).toContain('引用写成调用 C14')
  })

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

void describe('工作区标记', () => {
  const nodes = new Map<string, string>()
  const read = async (hash: string) => nodes.get(hash)
  const mark = (files: Record<string, string>) => {
    const built = buildMarkerTree(new Map(Object.entries(files)))
    for (const [hash, text] of built.nodes) nodes.set(hash, text)
    return built.marker
  }

  test('内容相同标记就相同；树里只有哈希，读回来的文件表和原来一样', async () => {
    const files = { 'a.txt': 'h1', 'src/b.ts': 'h2', 'src/deep/c.ts': 'h3' }
    const marker = mark(files)
    expect(mark({ 'src/deep/c.ts': 'h3', 'a.txt': 'h1', 'src/b.ts': 'h2' })).toBe(marker)
    expect(Object.fromEntries(await markerFiles(marker, read))).toEqual(files)
  })

  test('两棵树之间改了哪些文件：新增、删除、改了，文件换成目录两边都照记；和按文件表比出来的一样', async () => {
    const before = { 'a.txt': 'h1', 'src/b.ts': 'h2', 'x': 'hx' }
    const after = { 'a.txt': 'h1-new', 'src/c.ts': 'h3', 'x/inner.txt': 'hi' }
    const changes = await diffMarkerTrees(mark(before), mark(after), read)
    expect(changes).toEqual([
      { path: 'a.txt', before: 'h1', after: 'h1-new' },
      { path: 'src/b.ts', before: 'h2' },
      { path: 'src/c.ts', after: 'h3' },
      { path: 'x', before: 'hx' },
      { path: 'x/inner.txt', after: 'hi' },
    ])
    expect(diffFileMaps(new Map(Object.entries(before)), new Map(Object.entries(after)))).toEqual(changes)
  })
})

void describe('重放核对', () => {
  const change = { path: 'a.txt', before: 'h0', after: 'h1' }

  test('跑之前：改过的文件得还是改前的样子，新建的得还不存在', () => {
    expect(replayPreMismatches([change], new Map([['a.txt', 'h0']]))).toEqual([])
    expect(replayPreMismatches([change], new Map([['a.txt', 'h9']]))).toEqual([{ path: 'a.txt', expected: 'h0', actual: 'h9' }])
    expect(replayPreMismatches([{ path: 'new.txt', after: 'h1' }], new Map([['new.txt', 'h1']]))).toEqual([{ path: 'new.txt', actual: 'h1' }])
  })

  test('跑之后：多改、少改、改得不一样都算对不上', () => {
    expect(replayPostMismatches([change], [change])).toEqual([])
    expect(replayPostMismatches([change], [{ ...change, after: 'h2' }])).toEqual([{ path: 'a.txt', expected: 'h1', actual: 'h2' }])
    expect(replayPostMismatches([change], [])).toEqual([{ path: 'a.txt', expected: 'h1', actual: 'h0' }])
    expect(replayPostMismatches([], [{ path: 'extra.txt', after: 'h5' }])).toEqual([{ path: 'extra.txt', actual: 'h5' }])
  })
})

void describe('时间线挑拣', () => {
  const view = (call: number, marker: string, steps: Array<{ step: number; marker?: string; path?: string; changes?: Array<{ path: string; after?: string }> }>) => ({
    record: { t: 'call' as const, call, session: 's1', at: 0, marker },
    steps: steps.map((step) => ({ t: 'step' as const, call, op: 'run' as const, at: 0, ms: 0, ok: true, ...step })),
  })
  const views = [
    view(1, 'm0', [{ step: 1, marker: 'm1', changes: [{ path: 'a.txt', after: 'h' }] }, { step: 2, path: 'lib/x.js' }]),
    view(2, 'm1', [{ step: 1 }, { step: 2, marker: 'm2', changes: [{ path: 'b.txt', after: 'h' }] }]),
  ]

  test('某个时间点的标记：从那次调用开头起，顺着每一步做完时的标记走', () => {
    expect(markerAt(views, 1)).toBe('m1')
    expect(markerAt(views, 1, 1)).toBe('m1')
    expect(markerAt(views, 2, 1)).toBe('m1')
    expect(markerAt(views, 2)).toBe('m2')
    expect(markerAt(views, 3)).toBeUndefined()
  })

  test('按文件、按脚本筛；只留最近的几条，更早的数一数', () => {
    expect(selectHistory(views, { file: 'b.txt', limit: 10 }).calls.map(({ view, steps }) => [view.record.call, steps.map((step) => step.step)])).toEqual([[2, [2]]])
    expect(selectHistory(views, { script: 'lib/x.js', limit: 10 }).calls).toHaveLength(1)
    const recent = selectHistory(views, { limit: 2 })
    expect(recent.omitted).toBe(2)
    expect(recent.calls.map(({ view, steps }) => [view.record.call, steps.length])).toEqual([[2, 2]])
  })
})
