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
import type { GrantedModule } from '../src/types/module-form'
import { renderDiagnostics } from '../src/utils/diagnostics'
import { resolveNodeExecutable } from '../src/utils/node-executable'

/** 这一轮授权的那一个命名空间；没授权的模块 import 不出来，那道闸是语言给的。 */
const granted: GrantedModule[] = [
  {
    namespace: 'demo',
    declarations: `declare module 'velar:demo' {
  interface ReadFile { path: string; content: string; hasMore: boolean }
  export function read(input: { paths: string[] }): Promise<{ files: ReadFile[] }>
  export function write(input: { text: string }): Promise<{ received: string }>
  export function danger(input: { command: string }): Promise<{ ok: boolean }>
  export function bulk(input: { size: number }): Promise<{ text: string }>
}`,
  },
  {
    namespace: 'approval',
    declarations: `declare module 'velar:approval' {
  export function request(input: { what: string }): Promise<{ grant: string }>
}`,
  },
]

/** 装作在等用户点头：这段时间**不算**程序的时间。 */
const approvalWaitMs = 1_500

const capabilities: CodeCapabilityPort = {
  listOperations: () => ({ demo: ['read', 'write', 'danger', 'bulk'], approval: ['request'] }),
  invoke: async ({ namespace, operation, input }) => {
    if (namespace === 'approval') {
      await new Promise((settle) => setTimeout(settle, approvalWaitMs))
      return { value: { grant: 'grant-1' } }
    }
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
  session.submit({ program: { source, blobs: extra.blobs }, granted, timeoutMs: extra.timeoutMs ?? 10_000 })

const submitEdits = (edits: CodeProgramEdit[], previousSource?: string) =>
  session.submit({ program: { edits }, granted, previousSource, timeoutMs: 10_000 })

const importDemo = "import { read, write, danger, bulk } from 'velar:demo'"

void describe('代码面验收', () => {
  test('INV-1 typecheck 没过就一行都不执行，行号与模型写的对得上', async () => {
    const outcome = await submit(
      `${importDemo}\nconst r = await read({ paths: ['a.ts'] })\nexport default r.files[0].contents`
    )
    expect(outcome.checked).toBe(false)
    if (outcome.checked || !('check' in outcome)) throw new Error('应当没通过检查')
    const [first] = outcome.check.diagnostics
    expect(first?.line).toBe(3)
    expect(first?.message).toContain('content')
  })

  test('INV-1 通过检查的程序照常跑完，只有它交出的那点东西出来', async () => {
    const outcome = await submit(`${importDemo}
const r = await read({ paths: ['a.ts', 'b.ts'] })
export default r.files.flatMap((f) => f.content.split('\\n')
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
export default fs.readFileSync('/etc/hosts', 'utf8')`)
    expect(readFile.checked).toBe(true)
    if (!readFile.checked) throw new Error('应当通过检查')
    expect(readFile.result.failed?.code).toBe(CodeSurfaceErrorCodes.programError)

    const spawn = await submit(`
// @ts-ignore 同上
const cp = await import('node:child_process')
export default cp.execSync('echo 逃逸').toString()`)
    if (!spawn.checked) throw new Error('应当通过检查')
    expect(spawn.result.failed?.code).toBe(CodeSurfaceErrorCodes.programError)
  })

  test('INV-3 死循环到时必停', async () => {
    const outcome = await submit('while (true) {}\nexport default 1', { timeoutMs: 800 })
    expect(outcome.checked).toBe(true)
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.failed?.code).toBe(CodeSurfaceErrorCodes.timeout)
  })

  test('INV-4 拒绝是能 try/catch 的异常，并且进 notices', async () => {
    const outcome = await submit(`${importDemo}
let caught = '没拦住'
try {
  await danger({ command: 'rm -rf /' })
} catch (error) {
  caught = error.message
}
export default { 捕获到: caught }`)
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

  test('INV-5 这个运行器不许发版', () => {
    expect(NodeSubprocessRunnerIsReleaseReady).toBe(false)
  })

  test('INV-6 blobs 原样送达，反引号与转义一个不错', async () => {
    const patch = 'const x = `反引号 ${不是插值} \\ 反斜杠 "双引号" \'单引号\'`\n'
    const outcome = await submit(
      [importDemo, "import { blobs } from 'velar:program'", 'export default await write({ text: blobs.patch })'].join('\n'),
      { blobs: { patch } }
    )
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.value).toEqual({ received: patch })
  })

  test('INV-7 返回值超预算按结尾保留并说明', async () => {
    const outcome = await submit(`${importDemo}
const r = await bulk({ size: ${CodeSurfaceLimits.valueChars + 5_000} })
export default r.text`)
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.notices?.some((notice) => notice.action === 'truncated')).toBe(true)
    expect(String(outcome.result.value)).toContain('字符省略')
  })

  test('INV-8 源码超体量直接拒，不跑', async () => {
    const outcome = await submit(`// ${'x'.repeat(CodeSurfaceLimits.sourceChars + 10)}\nexport default 1`)
    expect(outcome.checked).toBe(true)
    if (!outcome.checked) throw new Error('体量应当在检查之前就拒掉')
    expect(outcome.result.failed?.code).toBe(CodeSurfaceErrorCodes.tooLarge)
  })

  test('INV-10 手滑写 TypeScript 照跑，并提醒下次写 JavaScript', async () => {
    const outcome = await submit(`${importDemo}
const r = await read({ paths: ['a.ts'] })
const first = r.files[0] as { path: string }
export default first.path`)
    expect(outcome.checked).toBe(true)
    if (!outcome.checked) throw new Error('语法偏好不该把一整轮弹回去')
    expect(outcome.result.value).toBe('a.ts')
    expect(outcome.result.notices?.some((notice) => notice.action === 'normalized')).toBe(true)
  })

  test('INV-10 但真的类型错照样拦下来，不因为夹带 TypeScript 语法就放行', async () => {
    const outcome = await submit(`${importDemo}
const r = await read({ paths: ['a.ts'] })
const first = r.files[0] as { path: string }
export default first.contents`)
    expect(outcome.checked).toBe(false)
    if (outcome.checked || !('check' in outcome)) throw new Error('应当拦下来')
    expect(outcome.check.diagnostics.length).toBeGreaterThan(0)
  })

  test('INV-11 在上一份程序上改，不必整份重写', async () => {
    const previous = `${importDemo}\nconst r = await read({ paths: ['a.ts'] })\nexport default r.files.map((f) => f.contents)`
    const outcome = await submitEdits([{ oldText: 'f.contents', newText: 'f.path' }], previous)
    expect(outcome.checked).toBe(true)
    if (!outcome.checked) throw new Error('改完应当通过检查')
    expect(outcome.result.value).toEqual(['a.ts'])
  })

  test('INV-11 oldText 不唯一、找不到、没有上一份，都明确拒绝且不猜', async () => {
    const previous = 'const a = 1\nconst b = 1\nexport default a + b'
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
      program: { source: 'export default 1', edits: [{ oldText: 'a', newText: 'b' }] },
      granted,
      previousSource: 'const a = 1\nexport default a',
    })
    if (!outcome.checked) throw new Error('应当走到结果')
    expect(outcome.result.failed?.message).toContain('只能给一个')
  })

  test('INV-12 诊断带代码帧，模型不必数行', async () => {
    const source = `${importDemo}\nconst r = await read({ paths: ['a.ts'] })\nexport default r.files[0].contents`
    const outcome = await submit(source)
    expect(outcome.checked).toBe(false)
    if (outcome.checked || !('check' in outcome)) throw new Error('应当没通过检查')
    const rendered = renderDiagnostics(source, outcome.check.diagnostics)
    expect(rendered).toContain('3 | export default r.files[0].contents')
    expect(rendered).toContain('^')
    expect(rendered).toContain('oldText')
  })

  test('INV-13 import 了没授权的模块：一行都不执行，回要补的命名空间', async () => {
    const outcome = await submit("import { log } from 'velar:git'\nexport default await log({})")
    expect(outcome.checked).toBe(false)
    if (outcome.checked || !('needsModules' in outcome)) throw new Error('应当要求先补模块')
    expect(outcome.needsModules).toEqual(['git'])
  })

  test('INV-13 没 import 直接用没授权的名字，是干净的报错不是要补模块', async () => {
    const outcome = await submit('export default await git.log({})')
    expect(outcome.checked).toBe(false)
    if (outcome.checked || !('check' in outcome)) throw new Error('应当是诊断')
    expect(outcome.check.diagnostics.some((d) => d.message.includes("Cannot find name 'git'"))).toBe(true)
  })

  test('INV-15 blobs 必须导入，不是隐形全局；velar:program 不占授权名额也不进租约账', async () => {
    // 不导入直接用 → 干净的报错，不是「有个全局你本来就该知道」
    const bare = await submit("export default blobs.patch", { blobs: { patch: 'x' } })
    expect(bare.checked).toBe(false)
    if (bare.checked || !('check' in bare)) throw new Error('应当是诊断')
    expect(bare.check.diagnostics.some((d) => d.message.includes("Cannot find name 'blobs'"))).toBe(true)

    // 导入了就能用，而且 velar:program 不出现在回给宿主的 imports 里
    const imported = await submit(
      ["import { blobs } from 'velar:program'", 'export default blobs.patch'].join('\n'),
      { blobs: { patch: '内容' } }
    )
    expect(imported.checked).toBe(true)
    if (!imported.checked) throw new Error('应当通过检查')
    expect(imported.result.value).toBe('内容')
    expect(imported.imports).toBeUndefined()
  })

  test('INV-14 租约随 import 一起带回来，不独占一轮', async () => {
    const outcome = await submit(
      `import { read } from 'velar:demo' with { lease: 'task' }\nconst r = await read({ paths: ['a.ts'] })\nexport default r.files.length`
    )
    expect(outcome.checked).toBe(true)
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.value).toBe(1)
    expect(outcome.imports).toEqual([{ namespace: 'demo', specifier: 'velar:demo', lease: 'task' }])
  })

  test('INV-16 被时间掐断时交出执行账，模型知道自己做到哪了', async () => {
    const outcome = await submit(
      [
        importDemo,
        "await read({ paths: ['a.ts'] })",
        "await read({ paths: ['b.ts'] })",
        "try { await danger({ command: 'x' }) } catch (error) { console.log(error.message) }",
        'while (true) {}',
      ].join('\n'),
      { timeoutMs: 800 }
    )
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.failed?.code).toBe(CodeSurfaceErrorCodes.timeout)
    // 连着的同名同结果折成一条：循环里读了两个文件是「read ×2」，不是两行一模一样的账
    expect(outcome.result.completed).toEqual([
      { call: 'demo.read', ok: true, times: 2 },
      { call: 'demo.danger', ok: false },
    ])
  })

  test('INV-16 跑完了不交账：程序是模型自己写的，它知道自己调了什么', async () => {
    const outcome = await submit(`${importDemo}\nawait read({ paths: ['a.ts'] })\nexport default 'ok'`)
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.value).toBe('ok')
    expect(outcome.result.completed).toBeUndefined()
  })

  test('INV-17 堆爆了是 TOO_LARGE 并说清怎么改，不是一句「意外退出」', async () => {
    const outcome = await submit(
      [
        'const kept = []',
        '// 一直攒到堆满；--max-old-space-size 之外没有别的东西拦得住它',
        'while (true) kept.push("x".repeat(1_000_000))',
        'export default kept.length',
      ].join('\n'),
      { timeoutMs: 60_000 }
    )
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.failed?.code).toBe(CodeSurfaceErrorCodes.tooLarge)
    expect(outcome.result.failed?.message).toContain('堆')
  }, 90_000)

  test('INV-18 等用户点头的时间不计进程序超时', async () => {
    // 审批等 1.5 秒，而程序自己的预算只有 1 秒：不停表的话这段程序必被我们自己杀掉。
    const outcome = await submit(
      [
        "import { request } from 'velar:approval'",
        importDemo,
        "const { grant } = await request({ what: '删掉 dist' })",
        "await read({ paths: ['a.ts'] })",
        'export default grant',
      ].join('\n'),
      { timeoutMs: 1_000 }
    )
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.failed).toBeUndefined()
    expect(outcome.result.value).toBe('grant-1')
  }, 20_000)

  test('INV-18 停表只扣等人的那段，程序自己的预算一点不变', async () => {
    const outcome = await submit(
      [
        "import { request } from 'velar:approval'",
        "await request({ what: '先等我一下' })",
        '// 等完之后仍然只剩原来的预算，死循环照样按时被掐断',
        'while (true) {}',
        'export default 1',
      ].join('\n'),
      { timeoutMs: 1_000 }
    )
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.failed?.code).toBe(CodeSurfaceErrorCodes.timeout)
    expect(outcome.result.completed).toEqual([{ call: 'approval.request', ok: true }])
  }, 20_000)
})
