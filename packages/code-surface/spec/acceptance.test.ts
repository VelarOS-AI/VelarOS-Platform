/** 代码面验收：每条用例以不变量编号开头，`spec/invariants.md` 是它的登记表。 */

import { existsSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import { CodeSurfaceErrorCodes, CodeSurfaceLimits } from '../src/contract/constants'
import type { CodeCapabilityPort } from '../src/contract/requires'
import { codeProgramChecker } from '../src/impl/CodeProgramChecker'
import { createCodeSurfaceSession } from '../src/impl/CodeSurfaceSession'
import {
  nodeSubprocessCodeRunner,
  NodeSubprocessRunnerIsReleaseReady,
} from '../src/impl/NodeSubprocessCodeRunner'
import type { CodeProgramEdit } from '../src/types/code-surface'
import { renderDiagnostics } from '../src/utils/diagnostics'
import { resolveNodeExecutable } from '../src/utils/node-executable'

const declarations = `
interface ReadFile { path: string; content: string; hasMore: boolean }
declare const demo: {
  read(input: { paths: string[] }): Promise<{ files: ReadFile[] }>
  write(input: { text: string }): Promise<{ received: string }>
  danger(input: { command: string }): Promise<{ ok: boolean }>
  bulk(input: { size: number }): Promise<{ text: string }>
}
declare const blobs: Record<string, string>
`

const capabilities: CodeCapabilityPort = {
  listOperations: () => ({ demo: ['read', 'write', 'danger', 'bulk'] }),
  invoke: async ({ operation, input }) => {
    const value = input as Record<string, never>
    if (operation === 'read') {
      const paths = (value as unknown as { paths: string[] }).paths
      return { value: { files: paths.map((path) => ({ path, content: `${path}\nTODO: 补这里\n`, hasMore: false })) } }
    }
    if (operation === 'write') return { value: { received: (value as unknown as { text: string }).text } }
    if (operation === 'bulk') return { value: { text: 'x'.repeat((value as unknown as { size: number }).size) } }
    return { error: { code: 'APPROVAL_DENIED', message: '用户拒绝了这条危险命令。' } }
  },
}

const session = createCodeSurfaceSession({
  checker: codeProgramChecker,
  runner: nodeSubprocessCodeRunner,
  capabilities,
})

const submit = (source: string, extra: { blobs?: Record<string, string>; timeoutMs?: number } = {}) =>
  session.submit({ program: { source, blobs: extra.blobs }, declarations, timeoutMs: extra.timeoutMs ?? 10_000 })

const submitEdits = (edits: CodeProgramEdit[], previousSource?: string) =>
  session.submit({ program: { edits }, declarations, previousSource, timeoutMs: 10_000 })

void describe('代码面验收', () => {
  test('INV-1 typecheck 没过就一行都不执行，行号与模型写的对得上', async () => {
    const outcome = await submit(`const r = await demo.read({ paths: ['a.ts'] })\nreturn r.files[0].contents`)
    expect(outcome.checked).toBe(false)
    if (outcome.checked) throw new Error('应当没通过检查')
    const [first] = outcome.check.diagnostics
    expect(first?.line).toBe(2)
    expect(first?.message).toContain('content')
  })

  test('INV-1 通过检查的程序照常跑完，只有它 return 的那点东西出来', async () => {
    const outcome = await submit(`
const r = await demo.read({ paths: ['a.ts', 'b.ts'] })
return r.files.flatMap((f) => f.content.split('\\n')
  .map((text, i) => ({ path: f.path, line: i + 1, text }))
  .filter((x) => x.text.includes('TODO')))`)
    expect(outcome.checked).toBe(true)
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.failed).toBeUndefined()
    expect(outcome.result.value).toEqual([
      { path: 'a.ts', line: 2, text: 'TODO: 补这里' },
      { path: 'b.ts', line: 2, text: 'TODO: 补这里' },
    ])
  })

  test('INV-2 程序够不到文件系统与子进程', async () => {
    const readFile = await submit(`
// @ts-ignore 故意绕开声明：验证运行时确实拦得住
const fs = await import('node:fs')
return fs.readFileSync('/etc/hosts', 'utf8')`)
    expect(readFile.checked).toBe(true)
    if (!readFile.checked) throw new Error('应当通过检查')
    expect(readFile.result.failed?.code).toBe(CodeSurfaceErrorCodes.programError)

    const spawn = await submit(`
// @ts-ignore 同上
const cp = await import('node:child_process')
return cp.execSync('echo 逃逸').toString()`)
    if (!spawn.checked) throw new Error('应当通过检查')
    expect(spawn.result.failed?.code).toBe(CodeSurfaceErrorCodes.programError)
  })

  test('INV-3 死循环到时必停', async () => {
    const outcome = await submit('while (true) {}', { timeoutMs: 800 })
    expect(outcome.checked).toBe(true)
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.failed?.code).toBe(CodeSurfaceErrorCodes.timeout)
  })

  test('INV-4 拒绝是能 try/catch 的异常，并且进 notices', async () => {
    const outcome = await submit(`
try {
  await demo.danger({ command: 'rm -rf /' })
  return '没拦住'
} catch (error) {
  return { 捕获到: error.message }
}`)
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.value).toEqual({ 捕获到: '用户拒绝了这条危险命令。' })
    expect(outcome.result.notices?.some((notice) => notice.action === 'denied')).toBe(true)
  })

  test('INV-9 非 node 运行时下必须解析到真正的 node，否则拒绝执行', () => {
    const resolved = resolveNodeExecutable()
    expect(resolved).not.toBeNull()
    expect(existsSync(String(resolved))).toBe(true)
    // 跑在 bun 下时绝不能退回 process.execPath——那正是隔离静默失效的那条路。
    if ((process.versions as Record<string, string | undefined>).bun !== undefined) {
      expect(resolved).not.toBe(process.execPath)
    }
  })

  test('INV-10 手滑写 TypeScript 照跑，并提醒下次写 JavaScript', async () => {
    const outcome = await submit(`
const r = await demo.read({ paths: ['a.ts'] })
const first = r.files[0] as ReadFile
return first.path`)
    expect(outcome.checked).toBe(true)
    if (!outcome.checked) throw new Error('语法偏好不该把一整轮弹回去')
    expect(outcome.result.value).toBe('a.ts')
    expect(outcome.result.notices?.some((notice) => notice.action === 'normalized')).toBe(true)
  })

  test('INV-10 但真的类型错照样拦下来，不因为夹带 TypeScript 语法就放行', async () => {
    const outcome = await submit(`
const r = await demo.read({ paths: ['a.ts'] })
const first = r.files[0] as ReadFile
return first.contents`)
    expect(outcome.checked).toBe(false)
    if (outcome.checked) throw new Error('应当拦下来')
    expect(outcome.check.diagnostics.some((d) => d.message.includes('content'))).toBe(true)
  })

  test('INV-11 在上一份程序上改，不必整份重写', async () => {
    const previous = `const r = await demo.read({ paths: ['a.ts'] })\nreturn r.files.map((f) => f.contents)`
    const outcome = await submitEdits([{ oldText: 'f.contents', newText: 'f.path' }], previous)
    expect(outcome.checked).toBe(true)
    if (!outcome.checked) throw new Error('改完应当通过检查')
    expect(outcome.result.value).toEqual(['a.ts'])
  })

  test('INV-11 oldText 不唯一、找不到、没有上一份，都明确拒绝且不猜', async () => {
    const previous = `const a = 1\nconst b = 1\nreturn a + b`
    const notUnique = await submitEdits([{ oldText: '= 1', newText: '= 2' }], previous)
    if (!notUnique.checked) throw new Error('应当走到结果')
    expect(notUnique.result.failed?.code).toBe(CodeSurfaceErrorCodes.editFailed)
    expect(notUnique.result.failed?.message).toContain('不止一次')

    const missing = await submitEdits([{ oldText: '找不到的原文', newText: 'x' }], previous)
    if (!missing.checked) throw new Error('应当走到结果')
    expect(missing.result.failed?.message).toContain('找不到')

    const noBase = await submitEdits([{ oldText: 'a', newText: 'b' }])
    if (!noBase.checked) throw new Error('应当走到结果')
    expect(noBase.result.failed?.message).toContain('发一份完整的')
  })

  test('INV-11 source 与 edits 只能给一个', async () => {
    const outcome = await session.submit({
      program: { source: 'return 1', edits: [{ oldText: 'a', newText: 'b' }] },
      declarations,
      previousSource: 'const a = 1\nreturn a',
    })
    if (!outcome.checked) throw new Error('应当走到结果')
    expect(outcome.result.failed?.message).toContain('只能给一个')
  })

  test('INV-12 诊断带代码帧，模型不必数行', async () => {
    const outcome = await submit(`const r = await demo.read({ paths: ['a.ts'] })\nreturn r.files[0].contents`)
    expect(outcome.checked).toBe(false)
    if (outcome.checked) throw new Error('应当没通过检查')
    const rendered = renderDiagnostics(
      `const r = await demo.read({ paths: ['a.ts'] })\nreturn r.files[0].contents`,
      outcome.check.diagnostics
    )
    expect(rendered).toContain('2 | return r.files[0].contents')
    expect(rendered).toContain('^')
    expect(rendered).toContain('oldText')
  })

  test('INV-5 这个运行器不许发版', () => {
    expect(NodeSubprocessRunnerIsReleaseReady).toBe(false)
  })

  test('INV-6 blobs 原样送达，反引号与转义一个不错', async () => {
    const patch = 'const x = `反引号 ${不是插值} \\ 反斜杠 "双引号" \'单引号\'`\n'
    const outcome = await submit('return await demo.write({ text: blobs.patch })', { blobs: { patch } })
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.value).toEqual({ received: patch })
  })

  test('INV-7 返回值超预算按结尾保留并说明', async () => {
    const outcome = await submit(`
const r = await demo.bulk({ size: ${CodeSurfaceLimits.valueChars + 5_000} })
return r.text`)
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.notices?.some((notice) => notice.action === 'truncated')).toBe(true)
    expect(String(outcome.result.value)).toContain('字符省略')
  })

  test('INV-8 源码超体量直接拒，不跑', async () => {
    const outcome = await submit(`// ${'x'.repeat(CodeSurfaceLimits.sourceChars + 10)}\nreturn 1`)
    expect(outcome.checked).toBe(true)
    if (!outcome.checked) throw new Error('体量应当在检查之前就拒掉')
    expect(outcome.result.failed?.code).toBe(CodeSurfaceErrorCodes.tooLarge)
  })
})
