/** 代码面验收：每条用例以不变量编号开头，`spec/invariants.md` 是它的登记表。 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import { afterAll, describe, expect, test } from 'bun:test'

import { CodeSurfaceErrorCodes, CodeSurfaceLimits, CodeSurfaceModId, CodeSurfaceToolNames } from '../src/contract/constants'
import type { CodeCapabilityPort, CodeSurfaceSpacePort, CodeSurfaceToolContext } from '../src/contract/requires'
import { createCapabilityPort } from '../src/impl/CapabilityOperationPort'
import { codeProgramChecker } from '../src/impl/CodeProgramChecker'
import type { CodeProgramGateApi } from '../src/impl/CodeProgramGate'
import { createCodeProgramGate } from '../src/impl/CodeProgramGate'
import { createCodeSurfaceSession } from '../src/impl/CodeSurfaceSession'
import { codeSurfaceTools, createCodeSurfaceKernelModule } from '../src/impl/CodeSurfaceTools'
import {
  nodeSubprocessCodeRunner,
  NodeSubprocessRunnerIsReleaseReady,
} from '../src/impl/NodeSubprocessCodeRunner'
import type { GrantedModule, MountedCapabilityModule } from '../src/types/code-surface'
import type { CodeGateReply, ScriptStepInput } from '../src/types/gate'
import type { CapabilityOperationTable } from '../src/types/operations'
import { ProgramModuleDeclarations } from '../src/utils/compiler'
import { renderDiagnostics } from '../src/utils/diagnostics'
import { renderProgramResult } from '../src/utils/gate'
import { resolveNodeExecutable } from '../src/utils/node-executable'

/** 这份验收建的临时目录：跑完一起删，删之前核对它确实在系统临时区里——删错目录的代价太大。 */
const temporaries: string[] = []

/** 在系统临时区里建一个目录，记下来跑完删。 */
async function temporary(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  temporaries.push(path)
  return path
}

afterAll(async () => {
  const base = await realpath(tmpdir())
  for (const path of temporaries) {
    if (!path.startsWith(`${base}${sep}`)) throw new Error(`拒绝删除临时区以外的目录：${path}`)
    await rm(path, { recursive: true, force: true })
  }
})

/** 一个目录下内容里带着 text 的文件。 */
async function filesContaining(root: string, text: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    if ((await readFile(path, 'utf8')).includes(text)) found.push(path)
  }
  return found
}

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
  export function refuse(input: { n: number }): Promise<{ ok: boolean }>
  export function slow(input: { ms: number }): Promise<{ done: boolean }>
  export function hang(input: { tag: string }): Promise<{ never: boolean }>
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

/** 挂着不回的调用收到的取消：程序停下之后，会话要叫停它们。 */
const hangAborted: string[] = []

const capabilities: CodeCapabilityPort = {
  listOperations: () => ({ demo: ['read', 'write', 'danger', 'bulk', 'refuse', 'slow', 'hang'], approval: ['request'] }),
  invoke: async ({ namespace, operation, input }, signal) => {
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
    if (operation === 'refuse') return { error: { code: 'DENIED', message: `拒绝：${'z'.repeat(10_000)}` } }
    if (operation === 'slow') {
      await new Promise((settle) => setTimeout(settle, (value as unknown as { ms: number }).ms))
      return { value: { done: true } }
    }
    if (operation === 'hang') {
      // 一直不回，直到被叫停：像一条还在跑的命令。
      await new Promise<void>((settle) => signal?.addEventListener('abort', () => settle(), { once: true }))
      hangAborted.push((value as unknown as { tag: string }).tag)
      return { error: { code: 'ABORTED', message: '被叫停了' } }
    }
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

  test('INV-4 只有拒绝进 notices：调用自己的失败程序接得住，不再回放；程序死在拒绝上时 failed 说了就不重复', async () => {
    const missing = createCodeSurfaceSession({
      checker: codeProgramChecker,
      runner: nodeSubprocessCodeRunner,
      capabilities: { listOperations: () => ({ demo: ['read'] }), invoke: async () => ({ error: { code: 'TARGET_NOT_FOUND', message: '没有这个文件。' } }) },
    })
    const caught = await missing.submit({ program: { source: `import { read } from 'velar:demo'
let outcome
try { await read({ paths: ['nope.ts'] }) } catch (error) { outcome = error.code }
export default outcome` }, granted, timeoutMs: 10_000 })
    if (!caught.checked) throw new Error('应当通过检查')
    expect(caught.result.value).toBe('TARGET_NOT_FOUND')
    expect(caught.result.notices).toBeUndefined()

    const refused = await submit(`${importDemo}\nawait danger({ command: 'rm -rf /' })`)
    if (!refused.checked) throw new Error('应当通过检查')
    expect(refused.result.failed?.message).toBe('用户拒绝了这条危险命令。')
    expect(refused.result.notices).toBeUndefined()
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

  test('INV-12 诊断带代码帧，模型不必数行', async () => {
    const source = `${importDemo}\nconst r = await read({ paths: ['a.ts'] })\nexport default r.files[0].contents`
    const outcome = await submit(source)
    expect(outcome.checked).toBe(false)
    if (outcome.checked || !('check' in outcome)) throw new Error('应当没通过检查')
    const rendered = renderDiagnostics(source, outcome.check.diagnostics)
    expect(rendered).toContain('3 | export default r.files[0].contents')
    expect(rendered).toContain('^')
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

  test('INV-18 能力调用的时间不计进程序超时：命令跑多久由它自己的时限管', async () => {
    // 调用本身要 1.5 秒，而程序自己的预算只有 1 秒：调用期间不停表的话，这段程序必被我们自己杀掉。
    const outcome = await submit("import { slow } from 'velar:demo'\nconst { done } = await slow({ ms: 1500 })\nexport default done", { timeoutMs: 1_000 })
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.failed).toBeUndefined()
    expect(outcome.result.value).toBe(true)
  }, 20_000)

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

  test('INV-21 把读到的大段内容塞进 throw，回到模型那里的仍然只有开头一小段', async () => {
    const outcome = await submit(`${importDemo}\nconst r = await bulk({ size: 3_000_000 })\nthrow new Error(r.text)`)
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.failed?.code).toBe(CodeSurfaceErrorCodes.programError)
    expect(outcome.result.failed!.message.length).toBeLessThan(CodeSurfaceLimits.failureChars + 200)
    expect(outcome.result.failed!.message).toContain('字符省略')
    expect(JSON.stringify(outcome).length).toBeLessThan(CodeSurfaceLimits.resultChars)
  })

  test('INV-21 被拒两百次、每次一万字：连着的同一件事折成一条', async () => {
    const outcome = await submit(`import { refuse } from 'velar:demo'
for (let i = 0; i < 150; i++) { try { await refuse({ n: i }) } catch (error) { void error } }
export default 1`)
    if (!outcome.checked) throw new Error('应当通过检查')
    const denied = outcome.result.notices?.filter((notice) => notice.action === 'denied') ?? []
    expect(denied).toHaveLength(1)
    expect(denied[0]!.detail).toContain('连着 150 次')
    expect(JSON.stringify(outcome).length).toBeLessThan(CodeSurfaceLimits.noticeChars + 500)
  })

  test('INV-21 两千个类型错只列前面那几条，并说明省了几条', async () => {
    const outcome = await submit(Array.from({ length: 2000 }, (_, index) => `const v${index} = 1; v${index}.nope()`).join('\n'))
    if (outcome.checked || !('check' in outcome)) throw new Error('应当是诊断')
    expect(outcome.check.diagnostics.length).toBeLessThanOrEqual(CodeSurfaceLimits.diagnostics)
    expect(outcome.check.omitted).toBeGreaterThan(1900)
    expect(JSON.stringify(outcome).length).toBeLessThan(CodeSurfaceLimits.diagnosticChars + 500)
  })

  test('INV-21 门的说明里模型看得见 velar:program 与写程序的规矩：导出什么才回来、上限多少，数字跟着常量表走', () => {
    const checked = codeProgramChecker.check({ source: "import { blobs, template } from 'velar:program'\nexport default [blobs, template('velar:demo')]", granted: [] })
    expect(checked.ok).toBe(true)
    const text = createCodeProgramGate({ checker: codeProgramChecker, runner: nodeSubprocessCodeRunner }).describe([])
    // 检查器用的那份声明原样摆在模型面前：两边同一份。
    expect(text).toContain(ProgramModuleDeclarations)
    expect(text).toContain('export function template(module: string): string')
    expect(text).toContain('不进你的上下文')
    expect(text).toContain('具名导出')
    expect(text).toContain(String(CodeSurfaceLimits.resultChars))
    expect(text).toContain(String(CodeSurfaceLimits.valueChars))
  })

  test('INV-22 只有 export default 就交它；有具名导出就交 { default?, ...具名 }，跟 import * 的形状一样', async () => {
    const onlyDefault = await submit('export default 42')
    if (!onlyDefault.checked) throw new Error('应当通过检查')
    expect(onlyDefault.result.value).toBe(42)

    const onlyNamed = await submit('export const total = 3\nexport const names = ["a", "b"]')
    if (!onlyNamed.checked) throw new Error('应当通过检查')
    expect(onlyNamed.result.value).toEqual({ total: 3, names: ['a', 'b'] })

    const both = await submit('const detail = { ok: true }\nexport { detail }\nexport default "摘要"')
    if (!both.checked) throw new Error('应当通过检查')
    expect(both.result.value).toEqual({ default: '摘要', detail: { ok: true } })

    const nothing = await submit('const unused = 1\nvoid unused')
    if (!nothing.checked) throw new Error('应当通过检查')
    expect(nothing.result.value).toBeUndefined()
  })

  test('INV-22 export default 不中断执行：它后面的代码照样跑，运行时报错的行号仍是模型写的那一行', async () => {
    const after = await submit('export default "先交"\nconsole.log("后面也跑了")')
    if (!after.checked) throw new Error('应当通过检查')
    expect(after.result.value).toBe('先交')
    expect(after.result.logs).toEqual(['后面也跑了'])

    const thrown = await submit('export const a = 1\nexport default a\nthrow new Error("第三行炸了")')
    if (!thrown.checked) throw new Error('应当通过检查')
    expect(thrown.result.failed?.line).toBe(3)

    // 能力报的错没接住：行号是发起那次调用的那一行（错误是收回音时造的，栈上本来没有程序的帧）。
    const uncaught = await submit(`${importDemo}\nawait read({ paths: ['a.ts'] })\n\nawait danger({ command: 'rm -rf /' })\nexport default '到不了'`)
    if (!uncaught.checked) throw new Error('应当通过检查')
    expect(uncaught.result.failed?.message).toBe('用户拒绝了这条危险命令。')
    expect(uncaught.result.failed?.line).toBe(4)
  })

  test('INV-23 能力交出的图走旁边的通道：程序拿不到像素，结果里没有 base64，超过张数上限按顺序丢后面的', async () => {
    const pixels = Buffer.from('fake-png-bytes').toString('base64')
    const imaging = createCodeSurfaceSession({
      checker: codeProgramChecker,
      runner: nodeSubprocessCodeRunner,
      capabilities: createCapabilityPort({
        pics: {
          show: async (input: { n: number }, { attach }) => {
            for (let index = 0; index < input.n; index += 1) {
              attach({ type: 'image-data', mediaType: 'image/png', data: pixels, label: `第 ${index + 1} 张` })
            }
            return { shown: input.n }
          },
        },
      }),
    })
    const outcome = await imaging.submit({
      program: { source: "import { show } from 'velar:pics'\nconst r = await show({ n: 25 })\nexport default { shown: r.shown, keys: Object.keys(r) }" },
      granted: [{ namespace: 'pics', declarations: "declare module 'velar:pics' {\n  export function show(input: { n: number }): Promise<{ shown: number }>\n}" }],
      timeoutMs: 10_000,
    })
    if (!outcome.checked) throw new Error('应当通过检查')
    // 程序只看得到操作的返回值
    expect(outcome.result.value).toEqual({ shown: 25, keys: ['shown'] })
    expect(JSON.stringify(outcome.result)).not.toContain(pixels)
    // 图在旁边：只给前 20 张，并说明丢了几张
    expect(outcome.attachments).toHaveLength(CodeSurfaceLimits.images)
    expect(outcome.attachments?.[0]?.label).toBe('第 1 张')
    expect(outcome.result.notices?.some((notice) => notice.detail.includes('只给了前 20 张'))).toBe(true)
  })
})

describe('门与时间线', () => {
  const notes: MountedCapabilityModule = {
    resident: true,
    surface: { specifier: 'velar:notes', namespace: 'notes', methods: ['list'], declarations: "declare module 'velar:notes' {\n  export function list(input: { limit: number }): Promise<{ items: string[] }>\n}", template: "// velar:notes 的代码模版\nimport { list } from 'velar:notes'\n\nasync function firstTwo() {\n  return (await list({ limit: 2 })).items\n}" },
  }
  const extra: MountedCapabilityModule = {
    resident: false,
    surface: { specifier: 'velar:extra', namespace: 'extra', methods: ['count'], declarations: "declare module 'velar:extra' {\n  /** 数一数有几个字。 */\n  export function count(input: { of: string }): Promise<{ n: number }>\n}", template: "// velar:extra 的代码模版\nimport { count } from 'velar:extra'" },
  }
  const disk: MountedCapabilityModule = {
    resident: true,
    surface: { specifier: 'velar:disk', namespace: 'disk', methods: ['write', 'remove'], declarations: "declare module 'velar:disk' {\n  export function write(input: { path: string; text: string }): Promise<{ ok: boolean }>\n  export function remove(input: { path: string }): Promise<{ ok: boolean }>\n}", template: '// velar:disk 的代码模版' },
  }
  /** 一个空间：notes、extra 两件，给了 workspace 就再挂一件往那个目录里写文件的 disk，并给它打标记。 */
  const spaceOf = async (options: { workspace?: string; retainBytes?: number } = {}): Promise<CodeSurfaceSpacePort> => {
    const root = options.workspace
    const operations: CapabilityOperationTable = {
      notes: { list: async (input) => ({ items: Array.from({ length: (input as { limit: number }).limit }, (_, index) => `n${index}`) }) },
      extra: { count: async (input) => ({ n: String((input as { of: string }).of).length }) },
    }
    const timeline: CodeSurfaceSpacePort['timeline'] = { directory: await temporary('cs-timeline-') }
    if (options.retainBytes) timeline.retainBytes = options.retainBytes
    if (root === undefined) return { modules: [notes, extra], capabilities: createCapabilityPort(operations), timeline }
    timeline.workspace = root
    const withDisk: CapabilityOperationTable = {
      ...operations,
      disk: {
        write: async (input) => {
          const { path, text } = input as { path: string; text: string }
          await mkdir(dirname(join(root, path)), { recursive: true })
          await writeFile(join(root, path), text)
          return { ok: true }
        },
        remove: async (input) => {
          await rm(join(root, (input as { path: string }).path), { force: true })
          return { ok: true }
        },
      },
    }
    return { modules: [notes, extra, disk], capabilities: createCapabilityPort(withDisk), timeline }
  }
  const gateOf = () => createCodeProgramGate({ checker: codeProgramChecker, runner: nodeSubprocessCodeRunner })
  const exec = (gate: CodeProgramGateApi, sessionId: string, space: CodeSurfaceSpacePort, steps: ScriptStepInput[]) =>
    gate.exec({ sessionId, steps, space, timeoutMs: 20_000 })
  /** 只有一步的回执里，段头下面的那部分。 */
  const bodyOf = (reply: CodeGateReply): string => reply.text.split('\n').slice(1).join('\n')
  const counting = (of: string, lease = '') => `import { count } from 'velar:extra'${lease}\nconst { n } = await count({ of: '${of}' })\nexport default n`

  test('INV-24 门的说明里有写脚本的规矩、四个工具怎么用、常驻模块的完整声明、其余模块的方法名（按需模块的声明与代码模版不在里面）', () => {
    const text = gateOf().describe([notes, extra])
    expect(text).toContain('export default')
    expect(text).toContain('script:exec')
    expect(text).toContain('script:history')
    expect(text).toContain('export function list(input: { limit: number })')
    expect(text).toContain('velar:extra：count')
    expect(text).not.toContain('数一数有几个字')
    // 代码模版不常驻：说明里没有它们，脚本要看时自己读。
    expect(text).not.toContain('velar:notes 的代码模版')
  })

  test('INV-24 头一次 import 按需模块不执行、交回它的完整声明；之后这个会话一直能用；退租后再用静默装回；别的会话各算各的', async () => {
    const gate = gateOf()
    const space = await spaceOf()
    const first = await exec(gate, 's1', space, [{ op: 'run', program: counting('abc') }])
    expect(first.steps[0]?.error?.code).toBe(CodeSurfaceErrorCodes.modulesNeeded)
    expect(first.text).toContain('这一步没有执行')
    expect(first.text).toContain('数一数有几个字')
    expect(bodyOf(await exec(gate, 's1', space, [{ op: 'run', program: counting('abc') }]))).toBe('3')
    expect(bodyOf(await exec(gate, 's1', space, [{ op: 'run', program: counting('abcd', " with { lease: 'done' }") }]))).toBe('4')
    // 退租之后又用到：静默装回去再检查一遍，不让模型白跑一轮。
    expect(bodyOf(await exec(gate, 's1', space, [{ op: 'run', program: counting('ab') }]))).toBe('2')
    expect((await exec(gate, 's2', space, [{ op: 'run', program: counting('ab') }])).steps[0]?.ok).toBe(false)
    // 空间里没有的模块：说清楚有哪些。
    const missing = await exec(gate, 's1', space, [{ op: 'run', program: "import { x } from 'velar:nowhere'\nexport default await x()" }])
    expect(missing.text).toContain('这个空间里没有 velar:nowhere')
  }, 60_000)

  test('INV-11 在底稿上改，不必整份重写：没过检查的那一步也能当底稿；会话结束也还在，时间线属于空间', async () => {
    const gate = gateOf()
    const space = await spaceOf()
    const broken = await exec(gate, 's1', space, [{ op: 'run', program: "import { list } from 'velar:notes'\nconst r = await list({ limit: 2 })\nexport default r.itemz" }])
    expect(broken.steps[0]?.error?.code).toBe(CodeSurfaceErrorCodes.checkFailed)
    expect(broken.text).toContain('export default r.itemz')
    expect(broken.text).toContain('from 填 C1.1')
    gate.forget('s1')
    const fixed = await exec(gate, 's1', space, [{ op: 'run', from: 'C1.1', edits: [{ oldText: 'r.itemz', newText: 'r.items' }] }])
    expect(bodyOf(fixed)).toBe('["n0","n1"]')
  }, 60_000)

  test('INV-11 oldText 不唯一、找不到都整组不落；from 指到没有的步骤明确拒绝，不猜', async () => {
    const gate = gateOf()
    const space = await spaceOf()
    await exec(gate, 's1', space, [{ op: 'run', program: 'const a = 1\nconst b = 1\nexport default a + b' }])
    const notUnique = await exec(gate, 's1', space, [{ op: 'run', from: 'C1.1', edits: [{ oldText: '= 1', newText: '= 2' }] }])
    expect(notUnique.steps[0]?.error?.code).toBe(CodeSurfaceErrorCodes.editFailed)
    expect(notUnique.text).toContain('不止一次')
    const missing = await exec(gate, 's1', space, [{ op: 'run', from: 'C1.1', edits: [{ oldText: '找不到的原文', newText: 'x' }] }])
    expect(missing.text).toContain('找不到')
    const noBase = await exec(gate, 's1', space, [{ op: 'run', from: 'C9.9' }])
    expect(noBase.steps[0]?.error?.code).toBe(CodeSurfaceErrorCodes.refNotFound)
  }, 60_000)

  test('INV-11 program 与 from 只给一个；edits 要和 from 一起给', async () => {
    const gate = gateOf()
    const space = await spaceOf()
    const both = await exec(gate, 's1', space, [{ op: 'run', program: 'export default 1', from: 'C1.1' }])
    expect(both.steps[0]?.error?.code).toBe(CodeSurfaceErrorCodes.invalidStep)
    expect(both.text).toContain('给一个')
    const loose = await exec(gate, 's1', space, [{ op: 'run', program: 'export default 1', edits: [{ oldText: '1', newText: '2' }] }])
    expect(loose.text).toContain('edits 要和 from 一起给')
  }, 60_000)

  test('INV-29 一次调用里写、存、跑：按顺序做，某一步没成就停；存进库的先过检查（要是 JavaScript），同样的内容不存新版本；回执每步一段、开头是步骤号', async () => {
    const gate = gateOf()
    const space = await spaceOf()
    const pick = "import { list } from 'velar:notes'\nexport async function pick(n) { return (await list({ limit: n })).items }"
    const reply = await exec(gate, 's1', space, [
      { op: 'write', path: 'lib/pick.js', program: pick },
      { op: 'run', program: "import { input } from 'velar:program'\nimport { pick } from './lib/pick.js'\nexport default (await pick(input.n)).join(',')", input: { n: 3 } },
      { op: 'write', path: 'lib/pick.js', program: pick },
      { op: 'write', path: 'lib/typed.js', program: 'export const x: number = 1' },
      { op: 'run', program: 'export default 1' },
    ])
    expect(reply.call).toBe('C1')
    expect(reply.steps.map((step) => [step.ref, step.ok])).toEqual([['C1.1', true], ['C1.2', true], ['C1.3', true], ['C1.4', false]])
    expect(reply.steps[0]?.saved).toBe('lib/pick.js@1')
    expect(reply.text).toContain('── C1.2 run 直接跑的代码 ──\nn0,n1,n2')
    expect(reply.text).toContain('和 lib/pick.js@1 一模一样，没存新版本')
    expect(reply.steps[3]?.error?.code).toBe(CodeSurfaceErrorCodes.checkFailed)
    expect(reply.text).toContain('要是 JavaScript')
    expect(reply.text).toContain('后面 1 步没做')
    // 路径不合规矩、缺字段：这一步不做，说清楚怎么写。
    const invalid = await exec(gate, 's1', space, [{ op: 'write', path: '../escape.js', program: 'export default 1' }])
    expect(invalid.steps[0]?.error?.code).toBe(CodeSurfaceErrorCodes.invalidStep)
  }, 60_000)

  test('INV-30 每一步的代码、参数、结果都记在时间线上：换一扇门（重启）也还在，history、show、diff 读得到；restore 追加一个同样内容的新版本，run 从之前的一步来时沿用当时的参数', async () => {
    const space = await spaceOf()
    await exec(gateOf(), 's1', space, [
      { op: 'write', path: 'lib/greet.js', program: "// 打招呼\nexport function greet(name) { return 'hi ' + name }" },
      { op: 'edit', path: 'lib/greet.js', edits: [{ oldText: "'hi '", newText: "'hello '" }] },
      { op: 'run', program: "import { input } from 'velar:program'\nimport { greet } from './lib/greet.js'\nexport default greet(input.name)", input: { name: 'velar' } },
    ])
    // 新的一扇门：时间线从磁盘读回来。
    const gate = gateOf()
    const query = { sessionId: 's2', timeline: space.timeline }
    const history = await gate.history({ ...query, query: {} })
    expect(history).toContain('别的会话')
    expect(history).toContain('C1.2 edit lib/greet.js@1 → lib/greet.js@2 · 成功')
    expect(history).toContain('C1.3 run 直接跑的代码 · input {"name":"velar"} · 成功')
    const step = await gate.show({ ...query, query: { ref: 'C1.3' } })
    expect(step).toContain('用到库里的：lib/greet.js@2')
    expect(step).toContain("import { greet } from './lib/greet.js'")
    expect(step).toContain('hello velar')
    expect(await gate.show({ ...query, query: {} })).toContain('lib/greet.js@2 · ')
    expect(await gate.show({ ...query, query: {} })).toContain('打招呼')
    const diff = await gate.diff({ ...query, query: { from: 'lib/greet.js@1' } })
    expect(diff).toContain("-export function greet(name) { return 'hi ' + name }")
    expect(diff).toContain("+export function greet(name) { return 'hello ' + name }")
    const restored = await exec(gate, 's2', space, [{ op: 'restore', path: 'lib/greet.js', version: 1 }, { op: 'run', from: 'C1.3' }])
    expect(restored.steps[0]?.saved).toBe('lib/greet.js@3')
    // 沿用 C1.3 当时的参数，库用最新版（退回来的 @3）。
    expect(restored.text).toContain('── C2.2 run from C1.3 ──\nhi velar')
    expect(await gate.history({ ...query, query: { script: 'lib/greet.js', limit: 2 } })).toContain('更早的还有')
  }, 60_000)

  test('INV-31 只存哈希不存文件内容：每一步记下改了哪些文件（前后 sha256），.gitignore 忽略的不算；外面改的在下一次调用开头记成外部改动，整份退回之前某一点时认得出', async () => {
    const workspace = await temporary('cs-workspace-')
    await writeFile(join(workspace, '.gitignore'), 'build/\n')
    await writeFile(join(workspace, 'keep.txt'), 'keep')
    const space = await spaceOf({ workspace })
    const gate = gateOf()
    // 写进文件的内容在脚本里现拼，脚本正文与参数里都没有它：时间线里就不该出现它。
    const first = await exec(gate, 's1', space, [{ op: 'run', program: "import { write } from 'velar:disk'\nconst text = 'Q'.repeat(3) + '-generated-' + (6 * 7)\nawait write({ path: 'src/a.txt', text })\nawait write({ path: 'build/out.txt', text })\nexport default 'ok'" }])
    const generated = 'QQQ-generated-42'
    expect(first.steps[0]?.changes).toEqual([{ path: 'src/a.txt', after: createHash('sha256').update(generated).digest('hex') }])
    expect(first.text).toContain('改了 1 个文件：src/a.txt（新）')
    expect(await filesContaining(space.timeline.directory, generated)).toEqual([])

    await writeFile(join(workspace, 'keep.txt'), 'changed')
    const noticed = await exec(gate, 's1', space, [{ op: 'run', program: 'export default 1' }])
    expect(noticed.text).toContain('工作区被外面改了 1 个文件：keep.txt')
    expect(await gate.history({ sessionId: 's1', timeline: space.timeline, query: { file: 'keep.txt' } })).toContain('C2 · ')

    // 整份退回 C1 之前的样子：认得出是哪一点。
    await writeFile(join(workspace, 'keep.txt'), 'keep')
    await rm(join(workspace, 'src'), { recursive: true, force: true })
    const back = await exec(gate, 's1', space, [{ op: 'run', program: 'export default 1' }])
    expect(back.text).toContain('现在工作区和 C1 开头一模一样')
    const files = await gate.diff({ sessionId: 's1', timeline: space.timeline, query: { from: 'C1' } })
    expect(files).toContain('C1 之后 → 现在：改了 1 个文件')
    expect(files).toContain('删除 src/a.txt')
  }, 60_000)

  test('INV-32 重放按记录再跑一遍：同一份代码、参数与当时的库版本；跑前核对改前、跑后核对改后，对不上就停；改动已经在了明说不用重放', async () => {
    const workspace = await temporary('cs-workspace-')
    const space = await spaceOf({ workspace })
    const gate = gateOf()
    await exec(gate, 's1', space, [
      { op: 'write', path: 'lib/emit.js', program: "import { write } from 'velar:disk'\nexport function emit(name) { return write({ path: 'notes/' + name + '.txt', text: name.toUpperCase() }) }" },
      { op: 'run', program: "import { input } from 'velar:program'\nimport { emit } from './lib/emit.js'\nawait emit(input.name)\nexport default 'done'", input: { name: 'first' } },
    ])
    await exec(gate, 's1', space, [{ op: 'edit', path: 'lib/emit.js', edits: [{ oldText: 'toUpperCase', newText: 'toLowerCase' }] }])
    // 不小心全撤了：重放回来，用的是当时的库版本（大写），不是后来改的。
    await rm(join(workspace, 'notes'), { recursive: true, force: true })
    const replayed = await exec(gate, 's1', space, [{ op: 'replay', step: 'C1.2' }])
    expect(replayed.steps[0]?.ok).toBe(true)
    expect(await readFile(join(workspace, 'notes/first.txt'), 'utf8')).toBe('FIRST')
    const again = await exec(gate, 's1', space, [{ op: 'replay', step: 'C1.2' }])
    expect(again.steps[0]?.error?.code).toBe(CodeSurfaceErrorCodes.replayMismatch)
    expect(again.text).toContain('现在已经在了')
    // 改前的底子变了：不重放，逐个文件说清楚。
    await writeFile(join(workspace, 'notes/first.txt'), 'other')
    const drifted = await exec(gate, 's1', space, [{ op: 'replay', step: 'C1.2' }, { op: 'run', program: 'export default 1' }])
    expect(drifted.text).toContain('notes/first.txt：应当不存在')
    expect(drifted.steps).toHaveLength(1)
    // 跑出来和当时不一样（依赖时间）：跑了，但算没成。
    await exec(gate, 's1', space, [{ op: 'run', program: "import { write } from 'velar:disk'\nawait write({ path: 'clock.txt', text: String(Date.now()) + Math.random() })\nexport default 1" }])
    await rm(join(workspace, 'clock.txt'), { force: true })
    const clock = await exec(gate, 's1', space, [{ op: 'replay', step: 'C6.1' }])
    expect(clock.steps[0]?.error?.code).toBe(CodeSurfaceErrorCodes.replayMismatch)
    expect(clock.text).toContain('改出来的和当时不一样')
    // 只有 run 与 replay 能重放。
    const notRunnable = await exec(gate, 's1', space, [{ op: 'replay', step: 'C1.1' }])
    expect(notRunnable.steps[0]?.error?.code).toBe(CodeSurfaceErrorCodes.invalidStep)
  }, 90_000)

  test('INV-32 一段一段地重放：给 from、to 两个调用号，按先后重跑那一段里跑成了、改过文件的每一步；改动已经在了的跳过，不算没成', async () => {
    const workspace = await temporary('cs-workspace-')
    const space = await spaceOf({ workspace })
    const gate = gateOf()
    const writing = (path: string, text: string) => `import { write } from 'velar:disk'\nawait write({ path: '${path}', text: '${text}' })\nexport default 'ok'`
    await exec(gate, 's1', space, [{ op: 'run', program: writing('notes/a.txt', 'A') }])
    await exec(gate, 's1', space, [{ op: 'run', program: writing('notes/b.txt', 'B') }, { op: 'run', program: writing('notes/a.txt', 'A2') }])
    await exec(gate, 's1', space, [{ op: 'run', program: 'export default 1' }])
    // 不小心整个目录都没了：从 C1 起按先后重放回来。
    await rm(join(workspace, 'notes'), { recursive: true, force: true })
    const replayed = await exec(gate, 's1', space, [{ op: 'replay', from: 'C1' }])
    expect(replayed.steps.map((step) => [step.ref, step.ok])).toEqual([['C4.1', true], ['C4.2', true], ['C4.3', true]])
    expect(replayed.text).toContain('── C4.1 replay C1.1 ──')
    expect(replayed.text).toContain('── C4.3 replay C2.2 ──')
    expect(await readFile(join(workspace, 'notes/a.txt'), 'utf8')).toBe('A2')
    expect(await readFile(join(workspace, 'notes/b.txt'), 'utf8')).toBe('B')
    // 再来一遍：都已经在了，全部跳过；这一段里的重放步骤（C4.x）也一样。
    const again = await exec(gate, 's1', space, [{ op: 'replay', from: 'C1', to: 'C4' }])
    expect(again.steps.every((step) => step.ok)).toBe(true)
    expect(again.text).toContain('C5.1 replay C1.1 ──\nC1.1 改过的文件已经是这一段做完的样子')
    expect(again.text).toContain('C5.2 replay C2.1 ──\nC2.1 的改动现在已经在了，跳过')
    // 这一段里没有能重放的：说清楚。
    const empty = await exec(gate, 's1', space, [{ op: 'replay', from: 'C3', to: 'C3' }])
    expect(empty.steps[0]?.error?.code).toBe(CodeSurfaceErrorCodes.invalidStep)
    expect(empty.text).toContain('没什么可重放')
  }, 90_000)

  test('INV-33 脚本库：相对路径 import 库里的脚本，每个只跑一次；检查连带检查，诊断带那个脚本的路径与代码帧；出错报库里的行号；别人写的代码 import 的能力模块直接给上；循环 import 说清楚', async () => {
    const gate = gateOf()
    const space = await spaceOf()
    const reply = await exec(gate, 's1', space, [
      { op: 'write', path: 'lib/base.js', program: "console.log('base 跑了一次')\nexport const unit = 2" },
      { op: 'write', path: 'lib/twice.js', program: "import { unit } from './base.js'\nexport const twice = (n) => n * unit" },
      { op: 'write', path: 'lib/boom.js', program: "export function boom() {\n  throw new Error('炸了')\n}" },
      { op: 'run', program: "import { unit } from './lib/base.js'\nimport { twice } from './lib/twice.js'\nexport default twice(unit)" },
    ])
    expect(reply.steps.every((step) => step.ok)).toBe(true)
    expect(reply.text).toContain('── console.log ──\nbase 跑了一次')
    expect(reply.text.match(/base 跑了一次/gu)).toHaveLength(1)
    const failed = await exec(gate, 's1', space, [{ op: 'run', program: "import { boom } from './lib/boom.js'\n\nboom()" }])
    expect(failed.text).toContain('第 3 行')
    expect(failed.text).toContain('出在库里的 lib/boom.js 第 2 行')

    // 库里的脚本有错：诊断带着它的路径，代码帧取自它。
    const modules = { 'lib/a.js': 'export function f() { return missingName }' }
    const checked = codeProgramChecker.check({ source: "import { f } from './lib/a.js'\nexport default f()", granted, modules })
    if (checked.ok) throw new Error('应当没通过检查')
    expect(checked.diagnostics[0]?.file).toBe('lib/a.js')
    expect(renderDiagnostics("import { f } from './lib/a.js'\nexport default f()", checked.diagnostics, modules)).toContain('1 | export function f() { return missingName }')

    // s1 写的脚本用了按需模块；s2 头一次用它，不用先读声明。
    await exec(gate, 's1', space, [{ op: 'write', path: 'lib/len.js', program: counting('x').replace('export default n', 'export const len = n') }])
    await exec(gate, 's1', space, [{ op: 'write', path: 'lib/len.js', program: counting('x').replace('export default n', 'export const len = n') }])
    const quiet = await exec(gate, 's2', space, [{ op: 'run', program: "import { len } from './lib/len.js'\nexport default len" }])
    expect(bodyOf(quiet)).toBe('1')

    await exec(gate, 's1', space, [
      { op: 'write', path: 'lib/ping.js', program: 'export const ping = 1' },
      { op: 'write', path: 'lib/pong.js', program: "import { ping } from './ping.js'\nexport const pong = ping" },
      { op: 'write', path: 'lib/ping.js', program: "import { pong } from './pong.js'\nexport const ping = 1\nexport const echo = () => pong" },
    ])
    const cycle = await exec(gate, 's1', space, [{ op: 'run', program: "import { ping } from './lib/ping.js'\nexport default ping" }])
    expect(cycle.text).toContain('循环 import')
  }, 90_000)

  test('INV-34 存的东西超过保留上限时从最旧的调用清起：结果正文、参数与标记清掉，代码留着；清掉参数的步骤不能重放，run 要沿用参数时要求重给', async () => {
    const gate = gateOf()
    const space = await spaceOf({ retainBytes: 1 })
    await exec(gate, 's1', space, [{ op: 'run', program: "import { input } from 'velar:program'\nexport default input.x", input: { x: 7 } }])
    await exec(gate, 's1', space, [{ op: 'run', program: 'export default 2' }])
    const query = { sessionId: 's1', timeline: space.timeline }
    const shown = await gate.show({ ...query, query: { ref: 'C1.1' } })
    expect(shown).toContain('时间线的保留上限清掉了：结果正文、参数（不能再重放）')
    expect(shown).toContain('── 代码 ──')
    expect(await gate.history({ ...query, query: {} })).toContain('参数已清')
    const replay = await exec(gate, 's1', space, [{ op: 'replay', step: 'C1.1' }])
    expect(replay.text).toContain('参数已经被时间线的保留上限清掉了')
    const reuse = await exec(gate, 's1', space, [{ op: 'run', from: 'C1.1' }])
    expect(reuse.text).toContain('当时的参数已经被时间线的保留上限清掉了')
    expect(bodyOf(await exec(gate, 's1', space, [{ op: 'run', from: 'C1.1', input: { x: 8 } }]))).toBe('8')
  }, 60_000)
})

describe('脚本库的删除', () => {
  const notes: MountedCapabilityModule = {
    resident: true,
    surface: { specifier: 'velar:notes', namespace: 'notes', methods: ['list'], declarations: "declare module 'velar:notes' {\n  export function list(input: { limit: number }): Promise<{ items: string[] }>\n}", template: '// velar:notes' },
  }
  const gateOf = () => createCodeProgramGate({ checker: codeProgramChecker, runner: nodeSubprocessCodeRunner })
  const exec = (gate: CodeProgramGateApi, space: CodeSurfaceSpacePort, steps: ScriptStepInput[]) => gate.exec({ sessionId: 's1', steps, space, timeoutMs: 20_000 })

  test('INV-35 脚本库能删脚本：remove 之后最新版取不到、库目录里不列、import 它报找不到，还在 import 它的脚本当场点名；带版本号照样取得到，restore 让它回来，版本号接着往下排', async () => {
    const gate = gateOf()
    const space: CodeSurfaceSpacePort = {
      modules: [notes],
      capabilities: createCapabilityPort({ notes: { list: async (input) => ({ items: Array.from({ length: (input as { limit: number }).limit }, (_, index) => `n${index}`) }) } }),
      timeline: { directory: await temporary('cs-timeline-') },
    }
    const query = { sessionId: 's1', timeline: space.timeline }
    await exec(gate, space, [
      { op: 'write', path: 'lib/base.js', program: '// 基础\nexport const base = 1' },
      { op: 'write', path: 'lib/user.js', program: "import { base } from './base.js'\nexport const user = base + 1" },
    ])
    const removed = await exec(gate, space, [{ op: 'remove', path: 'lib/base.js' }])
    expect(removed.steps[0]?.ok).toBe(true)
    expect(removed.text).toContain('最后一版是 @1')
    expect(removed.text).toContain('还在 import 它的：lib/user.js')
    const listing = await gate.show({ ...query, query: {} })
    expect(listing).toContain('脚本库里有 1 个脚本')
    expect(listing).toContain('拿掉了的（restore 能找回来）：lib/base.js（最后一版 @1）')
    expect((await exec(gate, space, [{ op: 'run', program: "import { base } from './lib/base.js'\nexport default base" }])).steps[0]?.error?.code).toBe(CodeSurfaceErrorCodes.checkFailed)
    const fromRemoved = await exec(gate, space, [{ op: 'run', from: 'lib/base.js' }])
    expect(fromRemoved.text).toContain('已经从脚本库里拿掉了')
    expect(await gate.show({ ...query, query: { ref: 'lib/base.js@1' } })).toContain('已经从脚本库里拿掉了')
    expect((await exec(gate, space, [{ op: 'remove', path: 'lib/base.js' }])).text).toContain('已经删掉了')
    const back = await exec(gate, space, [{ op: 'restore', path: 'lib/base.js', version: 1 }, { op: 'run', program: "import { user } from './lib/user.js'\nexport default user" }])
    expect(back.steps[0]?.saved).toBe('lib/base.js@2')
    expect(back.text).toContain('── C6.2 run 直接跑的代码 ──\n2')
  }, 60_000)
})

describe('门的工具', () => {
  const pictures: MountedCapabilityModule = {
    resident: true,
    surface: { specifier: 'velar:pics', namespace: 'pics', methods: ['show'], declarations: "declare module 'velar:pics' {\n  export function show(input: { n: number }): Promise<{ shown: number }>\n}", template: "// velar:pics 的代码模版\nimport { show } from 'velar:pics'" },
  }
  const pixels = Buffer.from('fake-png-bytes').toString('base64')
  const capabilities = createCapabilityPort({
    pics: {
      show: async (input: unknown, { attach }) => {
        const { n } = input as { n: number }
        for (let index = 0; index < n; index += 1) attach({ type: 'image-data', mediaType: 'image/png', data: pixels, label: `第 ${index + 1} 张` })
        return { shown: n }
      },
    },
  })
  const gate = createCodeProgramGate({ checker: codeProgramChecker, runner: nodeSubprocessCodeRunner })
  const contextOf = async (modalities: readonly string[]): Promise<CodeSurfaceToolContext> => ({
    abortSignal: new AbortController().signal,
    sessionId: 's1',
    gate,
    space: { modules: [pictures], capabilities, timeline: { directory: await temporary('cs-timeline-') } },
    getSupportedModelInputModalities: () => modalities,
  })

  test('INV-25 模型面上是四个工具：script:exec 改东西，另外三个只读时间线；都常驻、回执不卸载，说明只讲入参怎么填', () => {
    expect(Object.keys(codeSurfaceTools)).toEqual(['script:exec', 'script:history', 'script:show', 'script:diff'])
    for (const tool of Object.values(codeSurfaceTools)) {
      expect(tool.category).toBe('script')
      expect(tool.outputInline).toBe(true)
      expect(tool.exposure).toMatchObject({ tier: 'essential', alwaysResident: true })
      expect(tool.description.length).toBeLessThanOrEqual(1_800)
    }
    expect(codeSurfaceTools[CodeSurfaceToolNames.exec].isConcurrencySafe?.({ steps: [] })).toBe(false)
    expect(codeSurfaceTools[CodeSurfaceToolNames.history].isConcurrencySafe?.({})).toBe(true)
    expect(createCodeSurfaceKernelModule().manifest.id).toBe(CodeSurfaceModId)
  })

  test('INV-25 回执的文字与交给模型的内容块逐字一致，图跟在后面、各带一行说明；模型不收图时图不放进去、只说一声；只读的三个交回一块文字', async () => {
    const tool = codeSurfaceTools[CodeSurfaceToolNames.exec]
    const steps = [{ op: 'run', program: "import { show } from 'velar:pics'\nexport default await show({ n: 2 })" }]
    const seen = await tool.execute({ steps }, await contextOf(['text', 'image'])) as { result: string; modelContent: Array<{ type: string; text?: string }> }
    const texts = seen.modelContent.filter((part) => part.type === 'text').map((part) => part.text)
    expect(seen.result).toBe(texts.join('\n').trim())
    expect(texts[0]).toBe('── C1.1 run 直接跑的代码 ──\n{"shown":2}')
    expect(seen.modelContent.map((part) => part.type)).toEqual(['text', 'text', 'image-data', 'text', 'image-data'])
    expect(texts.slice(1)).toEqual(['第 1 张', '第 2 张'])

    const blind = await tool.execute({ steps }, await contextOf(['text'])) as { result: string; modelContent: Array<{ type: string }> }
    expect(blind.modelContent.map((part) => part.type)).toEqual(['text'])
    expect(blind.result).toContain('当前模型不收图')

    const shown = await codeSurfaceTools[CodeSurfaceToolNames.show].execute({}, await contextOf(['text'])) as { result: string; modelContent: Array<{ type: string; text?: string }> }
    expect(shown.modelContent).toEqual([{ type: 'text', text: shown.result }])
    expect(shown.result).toContain('脚本库是空的')
  }, 60_000)
})

describe('程序停下、模版与回执', () => {
  test('INV-26 程序停下时还没落定的调用被叫停，并逐条列在 unsettled 里', async () => {
    // 发出去不等就交卷：程序跑完了，那次调用还挂着。
    const leftBehind = await submit("import { hang } from 'velar:demo'\nvoid hang({ tag: 'left' })\nexport default 'done'")
    if (!leftBehind.checked) throw new Error('应当通过检查')
    expect(leftBehind.result.value).toBe('done')
    expect(leftBehind.result.unsettled).toEqual(['demo.hang'])
    expect(hangAborted).toContain('left')

    // 外面停下这一轮：死在一次调用中途，模型要知道哪件事可能做了一半。
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 300)
    const stopped = await session.submit({ program: { source: "import { hang } from 'velar:demo'\nawait hang({ tag: 'stopped' })\nexport default 1" }, granted, timeoutMs: 10_000, signal: stop.signal })
    if (!stopped.checked) throw new Error('应当通过检查')
    expect(stopped.result.failed?.code).toBe(CodeSurfaceErrorCodes.aborted)
    expect(stopped.result.unsettled).toEqual(['demo.hang'])
    expect(hangAborted).toContain('stopped')
  }, 20_000)

  test('INV-27 代码模版不常驻，程序里 template() 按模块名读；写错名字抛错并列出有哪些', async () => {
    const templates = { 'velar:demo': "// velar:demo 的代码模版\nimport { read } from 'velar:demo'" }
    const read = await session.submit({ program: { source: "import { template } from 'velar:program'\nexport default template('velar:demo')" }, granted, templates, timeoutMs: 10_000 })
    if (!read.checked) throw new Error('应当通过检查')
    expect(read.result.value).toBe(templates['velar:demo'])
    const wrong = await session.submit({ program: { source: "import { template } from 'velar:program'\nexport default template('velar:nope')" }, granted, templates, timeoutMs: 10_000 })
    if (!wrong.checked) throw new Error('应当通过检查')
    expect(wrong.result.failed?.code).toBe(CodeSurfaceErrorCodes.programError)
    expect(wrong.result.failed?.message).toContain('velar:demo')
  }, 20_000)

  test('INV-28 回执写成可读的文字：字符串原样、别的按 JSON，具名导出按名字分段，没跑完第一行说为什么', async () => {
    // 只导出一个字符串：原样交回，多行照原样，不转义。
    expect(renderProgramResult({ value: 'line "1"\nline 2' })).toBe('line "1"\nline 2')
    // 具名导出：每个名字一段，字符串照原样，别的按 JSON。
    const named = await submit("export const total = 3\nexport const text = 'a\\nb'\nexport default { ok: true }")
    if (!named.checked) throw new Error('应当通过检查')
    expect(named.result.named).toBe(true)
    const shown = renderProgramResult(named.result)
    expect(shown).toContain('── export default ──\n{"ok":true}')
    expect(shown).toContain('── export total ──\n3')
    expect(shown).toContain('── export text ──\na\nb')
    // 没跑完：第一行是失败码、行号与说明，已经做完的调用跟在后面。
    const failed = renderProgramResult({ failed: { code: 'PROGRAM_ERROR', message: 'boom', line: 3 }, completed: [{ call: 'demo.read', ok: true, times: 2 }] })
    expect(failed.split('\n')[0]).toBe('脚本没跑完（PROGRAM_ERROR，第 3 行）：boom')
    expect(failed).toContain('demo.read ×2')
  }, 20_000)
})
