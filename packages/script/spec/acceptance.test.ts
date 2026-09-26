/** 代码面验收：每条用例以不变量编号开头，`spec/invariants.md` 是它的登记表。 */

import { existsSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import { CodeSurfaceErrorCodes, CodeSurfaceLimits } from '../src/contract/constants'
import type { CodeCapabilityPort } from '../src/contract/requires'
import type { KernelScriptSessionOptions } from '../src/contract/requires'
import { createCapabilityPort } from '../src/impl/CapabilityOperationPort'
import { codeProgramChecker } from '../src/impl/CodeProgramChecker'
import { createCodeSurfaceSession } from '../src/impl/CodeSurfaceSession'
import { createKernelScriptSession } from '../src/impl/KernelScriptSession'
import {
  nodeSubprocessCodeRunner,
  NodeSubprocessRunnerIsReleaseReady,
} from '../src/impl/NodeSubprocessCodeRunner'
import type { GrantedModule } from '../src/types/script'
import { resolveNodeExecutable } from '../src/utils/node-executable'
import { CodeSurfaceTuning } from '../src/utils/tuning'

/** 这一轮授权的那一个命名空间；没授权的模块 import 不出来，那道闸是语言给的。 */
const granted: GrantedModule[] = [
  {
    namespace: 'demo',
    declarations: `declare module 'velaros:demo' {
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
    declarations: `declare module 'velaros:approval' {
  export function request(input: { what: string }): Promise<{ grant: string }>
}`,
  },
]

/** 装作在等用户点头：这段时间**不算**程序的时间。 */
const approvalWaitMs = 1_500

/** 挂着不回的调用收到的取消：程序停下之后，会话要叫停它们。 */
const hangAborted: string[] = []

const capabilities: CodeCapabilityPort = {
  listOperations: () => ({
    demo: ['read', 'write', 'danger', 'bulk', 'refuse', 'slow', 'hang'],
    approval: ['request'],
  }),
  invoke: async ({ namespace, operation, input }, signal) => {
    if (namespace === 'approval') {
      await new Promise((settle) => setTimeout(settle, approvalWaitMs))
      return { value: { grant: 'grant-1' } }
    }
    const value = input as Record<string, never>
    if (operation === 'read') {
      const paths = (value as unknown as { paths: string[] }).paths
      return {
        value: {
          files: paths.map((path) => ({
            path,
            content: `${path}\nTODO: 补这里\n`,
            hasMore: false,
          })),
        },
      }
    }
    if (operation === 'write')
      return { value: { received: (value as unknown as { text: string }).text } }
    if (operation === 'bulk')
      return { value: { text: 'x'.repeat((value as unknown as { size: number }).size) } }
    if (operation === 'refuse')
      return { error: { code: 'DENIED', message: `拒绝：${'z'.repeat(10_000)}` } }
    if (operation === 'slow') {
      await new Promise((settle) => setTimeout(settle, (value as unknown as { ms: number }).ms))
      return { value: { done: true } }
    }
    if (operation === 'hang') {
      // 一直不回，直到被叫停：像一条还在跑的命令。
      await new Promise<void>((settle) =>
        signal?.addEventListener('abort', () => settle(), { once: true })
      )
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

const submit = (
  source: string,
  extra: { blobs?: Record<string, string>; timeoutMs?: number } = {}
) =>
  session.submit({
    program: { source, blobs: extra.blobs },
    granted,
    timeoutMs: extra.timeoutMs ?? 10_000,
  })

const importDemo = "import { read, write, danger, bulk } from 'velaros:demo'"

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

  test('INV-3 在等待能力的同时死循环也会耗尽 CPU 预算', async () => {
    const outcome = await submit(
      "import { hang } from 'velaros:demo'; void hang({tag:'cpu-wait'}); while(true){}",
      { timeoutMs: 300 }
    )
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.failed?.code).toBe(CodeSurfaceErrorCodes.timeout)
    expect(hangAborted).toContain('cpu-wait')
  }, 5_000)

  test('INV-2 Function 构造器不能取得宿主网络或进程，运行之间隔离全局状态', async () => {
    const first = await submit(
      "export default Function('globalThis.testMark=1;return [typeof fetch,typeof WebSocket,typeof process,typeof require]')()"
    )
    if (!first.checked) throw new Error('应当通过检查')
    expect(first.result.value).toEqual(['undefined', 'undefined', 'undefined', 'undefined'])
    const second = await submit("export default Function('return typeof testMark')()")
    if (!second.checked) throw new Error('应当通过检查')
    expect(second.result.value).toBe('undefined')
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
      capabilities: {
        listOperations: () => ({ demo: ['read'] }),
        invoke: async () => ({ error: { code: 'TARGET_NOT_FOUND', message: '没有这个文件。' } }),
      },
    })
    const caught = await missing.submit({
      program: {
        source: `import { read } from 'velaros:demo'
let outcome
try { await read({ paths: ['nope.ts'] }) } catch (error) { outcome = error.code }
export default outcome`,
      },
      granted,
      timeoutMs: 10_000,
    })
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

  test('INV-9 Electron 宿主必须显式注入自己的进程运行器', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron')
    try {
      Object.defineProperty(process.versions, 'electron', { value: '44.0.0', configurable: true })
      expect(resolveNodeExecutable()).toBeNull()
    } finally {
      if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor)
      else Reflect.deleteProperty(process.versions, 'electron')
    }
  })

  test('INV-5 这个运行器不许发版', () => {
    expect(NodeSubprocessRunnerIsReleaseReady).toBe(false)
  })

  test('INV-6 blobs 原样送达，反引号与转义一个不错', async () => {
    const patch = 'const x = `反引号 ${不是插值} \\ 反斜杠 "双引号" \'单引号\'`\n'
    const outcome = await submit(
      [
        importDemo,
        "import { blobs } from 'velaros:program'",
        'export default await write({ text: blobs.patch })',
      ].join('\n'),
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
    const outcome = await submit(
      `// ${'x'.repeat(CodeSurfaceLimits.sourceChars + 10)}\nexport default 1`
    )
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
    const rendered = outcome.check.diagnostics.map((item) => item.frame).join('\n')
    expect(rendered).toContain('3 | export default r.files[0].contents')
    expect(rendered).toContain('^')
  })

  test('INV-38 名字写错时，诊断接上实际有什么：成员、入参字段、模块导出，还是 Promise 时提醒 await', () => {
    const messages = (source: string, modules: GrantedModule[] = granted) => {
      const checked = codeProgramChecker.check({ source, granted: modules })
      if (checked.ok) throw new Error('应当没通过检查')
      return checked.diagnostics.map((item) => item.message)
    }

    // 猜得离谱的字段：TS 只说没有，后面接上这个类型实际有的成员，类型照声明原文写
    expect(
      messages(
        `${importDemo}\nconst r = await read({ paths: ['a.ts'] })\nexport default r.files[0].body`
      )
    ).toEqual([
      "Property 'body' does not exist on type 'ReadFile'. ReadFile 的成员：path: string、content: string、hasMore: boolean",
    ])
    // 入参里多写的字段：列出入参实际收什么
    expect(
      messages(`${importDemo}\nexport default await read({ paths: ['a.ts'], recursive: true })`)[0]
    ).toEndWith('可用的成员：paths: string[]')
    // import 了模块没有的名字：列出模块的值导出。名字和某个类型相近时 TS 会建议那个类型（脚本用不上），照样列
    const demoExports =
      'velaros:demo 的导出：read()、write()、danger()、bulk()、refuse()、slow()、hang()'
    expect(
      messages("import { listEverything } from 'velaros:demo'\nexport default listEverything")[0]
    ).toEndWith(demoExports)
    expect(
      messages("import { readFile } from 'velaros:demo'\nexport default readFile")[0]
    ).toEndWith(demoExports)
    // 忘了 await：不列 Promise 的 then/catch，直接说先 await
    expect(
      messages(`${importDemo}\nconst r = read({ paths: ['a.ts'] })\nexport default r.files`)[0]
    ).toEndWith('这个值还是 Promise：先 await 再取字段。')
    // 模型本来就认得的类型不补
    expect(messages("const s = 'abc'\nexport default s.body")).toEqual([
      "Property 'body' does not exist on type '\"abc\"'.",
    ])
    expect(messages('export default [1, 2].items')).toEqual([
      "Property 'items' does not exist on type 'number[]'.",
    ])
  })

  test('INV-38 联合类型按分支列并先说怎么收窄；列不下只说一共几个，整条守住单条诊断的预算', () => {
    const wideFields = Array.from({ length: 60 }, (_, index) => `field${index}: string`).join('; ')
    const probe: GrantedModule[] = [
      {
        namespace: 'probe',
        declarations: `declare module 'velaros:probe' {
  interface Found { entries: string[]; truncated: boolean }
  interface Wide { ${wideFields} }
  export function diagnose(): Promise<Found | { error: string }>
  export function wide(): Promise<Wide>
  export function sprawl(): Promise<{ ${wideFields} } | { error: string }>
}`,
      },
    ]
    const first = (source: string) => {
      const checked = codeProgramChecker.check({ source, granted: probe })
      if (checked.ok) throw new Error('应当没通过检查')
      return checked.diagnostics[0]?.message ?? ''
    }

    expect(
      first(
        "import { diagnose } from 'velaros:probe'\nconst d = await diagnose()\nexport default d.entries"
      )
    ).toEndWith(
      "先用 'entries' in 值 判断是哪一种。各分支：Found 有 entries、truncated；{ error: string; } 有 error"
    )

    const wide = first(
      "import { wide } from 'velaros:probe'\nconst w = await wide()\nexport default w.nope"
    )
    expect(wide).toContain('Wide 的成员：field0: string、field1: string')
    expect(wide).toEndWith('…共 60 个')

    // TS 的原话本身就很长时截的是它，补的那句完整留着
    const sprawl = first(
      "import { sprawl } from 'velaros:probe'\nconst s = await sprawl()\nexport default s.nope"
    )
    expect(sprawl.length).toBeLessThanOrEqual(CodeSurfaceTuning.diagnosticMessageChars)
    expect(sprawl).toStartWith("Property 'nope' does not exist")
    expect(sprawl).toContain('… 各分支：')
  })

  test('INV-13 import 了没授权的模块：一行都不执行，回要补的命名空间', async () => {
    const outcome = await submit("import { log } from 'velaros:git'\nexport default await log({})")
    expect(outcome.checked).toBe(false)
    if (outcome.checked || !('needsModules' in outcome)) throw new Error('应当要求先补模块')
    expect(outcome.needsModules).toEqual(['git'])
  })

  test('INV-13 没 import 直接用没授权的名字，是干净的报错不是要补模块', async () => {
    const outcome = await submit('export default await git.log({})')
    expect(outcome.checked).toBe(false)
    if (outcome.checked || !('check' in outcome)) throw new Error('应当是诊断')
    expect(
      outcome.check.diagnostics.some((d) => d.message.includes("Cannot find name 'git'"))
    ).toBe(true)
  })

  test('INV-15 blobs 必须导入，不是隐形全局；velaros:program 不占授权名额也不进租约账', async () => {
    // 不导入直接用 → 干净的报错，不是「有个全局你本来就该知道」
    const bare = await submit('export default blobs.patch', { blobs: { patch: 'x' } })
    expect(bare.checked).toBe(false)
    if (bare.checked || !('check' in bare)) throw new Error('应当是诊断')
    expect(bare.check.diagnostics.some((d) => d.message.includes("Cannot find name 'blobs'"))).toBe(
      true
    )

    // 导入了就能用，而且 velaros:program 不出现在回给宿主的 imports 里
    const imported = await submit(
      ["import { blobs } from 'velaros:program'", 'export default blobs.patch'].join('\n'),
      { blobs: { patch: '内容' } }
    )
    expect(imported.checked).toBe(true)
    if (!imported.checked) throw new Error('应当通过检查')
    expect(imported.result.value).toBe('内容')
    expect(imported.imports).toBeUndefined()
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
    const outcome = await submit(
      `${importDemo}\nawait read({ paths: ['a.ts'] })\nexport default 'ok'`
    )
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
    const outcome = await submit(
      "import { slow } from 'velaros:demo'\nconst { done } = await slow({ ms: 1500 })\nexport default done",
      { timeoutMs: 1_000 }
    )
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.failed).toBeUndefined()
    expect(outcome.result.value).toBe(true)
  }, 20_000)

  test('INV-18 等用户点头的时间不计进程序超时', async () => {
    // 审批等 1.5 秒，而程序自己的预算只有 1 秒：不停表的话这段程序必被我们自己杀掉。
    const outcome = await submit(
      [
        "import { request } from 'velaros:approval'",
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
        "import { request } from 'velaros:approval'",
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
    const outcome = await submit(
      `${importDemo}\nconst r = await bulk({ size: 3_000_000 })\nthrow new Error(r.text)`
    )
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.failed?.code).toBe(CodeSurfaceErrorCodes.programError)
    expect(outcome.result.failed!.message.length).toBeLessThan(CodeSurfaceLimits.failureChars + 200)
    expect(outcome.result.failed!.message).toContain('字符省略')
    expect(JSON.stringify(outcome).length).toBeLessThan(CodeSurfaceLimits.resultChars)
  })

  test('INV-21 被拒两百次、每次一万字：连着的同一件事折成一条', async () => {
    const outcome = await submit(`import { refuse } from 'velaros:demo'
for (let i = 0; i < 150; i++) { try { await refuse({ n: i }) } catch (error) { void error } }
export default 1`)
    if (!outcome.checked) throw new Error('应当通过检查')
    const denied = outcome.result.notices?.filter((notice) => notice.action === 'denied') ?? []
    expect(denied).toHaveLength(1)
    expect(denied[0]!.detail).toContain('连着 150 次')
    expect(JSON.stringify(outcome).length).toBeLessThan(CodeSurfaceLimits.noticeChars + 500)
  })

  test('INV-21 两千个类型错只列前面那几条，并说明省了几条', async () => {
    const outcome = await submit(
      Array.from({ length: 2000 }, (_, index) => `const v${index} = 1; v${index}.nope()`).join('\n')
    )
    if (outcome.checked || !('check' in outcome)) throw new Error('应当是诊断')
    expect(outcome.check.diagnostics.length).toBeLessThanOrEqual(CodeSurfaceLimits.diagnostics)
    expect(outcome.check.omitted).toBeGreaterThan(1900)
    expect(JSON.stringify(outcome).length).toBeLessThan(CodeSurfaceLimits.diagnosticChars + 500)
  })

  test('INV-22 只有 export default 就交它；有具名导出就交 { default?, ...具名 }，跟 import * 的形状一样', async () => {
    const onlyDefault = await submit('export default 42')
    if (!onlyDefault.checked) throw new Error('应当通过检查')
    expect(onlyDefault.result.value).toBe(42)

    const onlyNamed = await submit('export const total = 3\nexport const names = ["a", "b"]')
    if (!onlyNamed.checked) throw new Error('应当通过检查')
    expect(onlyNamed.result.value).toEqual({ total: 3, names: ['a', 'b'] })

    const both = await submit(
      'const detail = { ok: true }\nexport { detail }\nexport default "摘要"'
    )
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

    const thrown = await submit(
      'export const a = 1\nexport default a\nthrow new Error("第三行炸了")'
    )
    if (!thrown.checked) throw new Error('应当通过检查')
    expect(thrown.result.failed?.line).toBe(3)

    // 能力报的错没接住：行号是发起那次调用的那一行（错误是收回音时造的，栈上本来没有程序的帧）。
    const uncaught = await submit(
      `${importDemo}\nawait read({ paths: ['a.ts'] })\n\nawait danger({ command: 'rm -rf /' })\nexport default '到不了'`
    )
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
              attach({
                type: 'image-data',
                mediaType: 'image/png',
                data: pixels,
                label: `第 ${index + 1} 张`,
              })
            }
            return { shown: input.n }
          },
        },
      }),
    })
    const outcome = await imaging.submit({
      program: {
        source:
          "import { show } from 'velaros:pics'\nconst r = await show({ n: 25 })\nexport default { shown: r.shown, keys: Object.keys(r) }",
      },
      granted: [
        {
          namespace: 'pics',
          declarations:
            "declare module 'velaros:pics' {\n  export function show(input: { n: number }): Promise<{ shown: number }>\n}",
        },
      ],
      timeoutMs: 10_000,
    })
    if (!outcome.checked) throw new Error('应当通过检查')
    // 程序只看得到操作的返回值
    expect(outcome.result.value).toEqual({ shown: 25, keys: ['shown'] })
    expect(JSON.stringify(outcome.result)).not.toContain(pixels)
    // 图在旁边：只给前 20 张，并说明丢了几张
    expect(outcome.attachments).toHaveLength(CodeSurfaceLimits.images)
    expect(outcome.attachments?.[0]?.label).toBe('第 1 张')
    expect(outcome.result.notices?.some((notice) => notice.detail.includes('只给了前 20 张'))).toBe(
      true
    )
  })
})

describe('程序停下、数据与回执', () => {
  test('INV-26 程序停下时还没落定的调用被叫停，并逐条列在 unsettled 里', async () => {
    // 发出去不等就交卷：程序跑完了，那次调用还挂着。
    const leftBehind = await submit(
      "import { hang } from 'velaros:demo'\nvoid hang({ tag: 'left' })\nexport default 'done'"
    )
    if (!leftBehind.checked) throw new Error('应当通过检查')
    expect(leftBehind.result.value).toBe('done')
    expect(leftBehind.result.unsettled).toEqual(['demo.hang'])
    expect(hangAborted).toContain('left')

    // 外面停下这一轮：死在一次调用中途，模型要知道哪件事可能做了一半。
    const stop = new AbortController()
    const interrupted = createCodeSurfaceSession({
      checker: codeProgramChecker,
      runner: nodeSubprocessCodeRunner,
      capabilities: {
        ...capabilities,
        invoke: (call, signal) => {
          const pending = capabilities.invoke(call, signal)
          queueMicrotask(() => stop.abort())
          return pending
        },
      },
    })
    const stopped = await interrupted.submit({
      program: {
        source:
          "import { hang } from 'velaros:demo'\nawait hang({ tag: 'stopped' })\nexport default 1",
      },
      granted,
      timeoutMs: 10_000,
      signal: stop.signal,
    })
    if (!stopped.checked) throw new Error('应当通过检查')
    expect(stopped.result.failed?.code).toBe(CodeSurfaceErrorCodes.aborted)
    expect(stopped.result.unsettled).toEqual(['demo.hang'])
    expect(hangAborted).toContain('stopped')
  }, 20_000)

  test('INV-27 程序数据模块只导出本次 input 与 blobs，保持原文与冻结边界', async () => {
    const input = { key: 'progress', nested: { version: 2 } }
    const blobs = { body: 'literal ` ${text} \\ 内容\nsecond line' }
    const read = await session.submit({
      program: {
        source:
          "import * as program from 'velaros:program'\nexport default {keys:Object.keys(program).sort(),input:program.input,blobs:program.blobs,frozen:Object.isFrozen(program)&&Object.isFrozen(program.input.nested)&&Object.isFrozen(program.blobs)}",
        input,
        blobs,
      },
      granted,
      timeoutMs: 10_000,
    })
    if (!read.checked) throw new Error('应当通过检查')
    expect(read.result.failed).toBeUndefined()
    expect(read.result.value).toEqual({ keys: ['blobs', 'input'], input, blobs, frozen: true })
  })

  test('INV-27 旧模板导入在检查阶段拒绝，运行器不会执行', async () => {
    let ran = false
    const guarded = createCodeSurfaceSession({
      checker: codeProgramChecker,
      capabilities,
      runner: {
        run: async () => {
          ran = true
          throw new Error('检查失败不应运行')
        },
      },
    })
    const result = await guarded.submit({
      program: {
        source:
          "import { template } from 'velaros:program'\nexport default template('velaros:demo')",
      },
      granted,
    })
    expect(result.checked).toBe(false)
    if (result.checked || !('check' in result)) throw new Error('应当返回检查诊断')
    expect(result.check.diagnostics.some((item) => item.code === 2305)).toBe(true)
    expect(ran).toBe(false)
  })
})

describe('程序编辑与附属模块', () => {
  test('INV-11 精确编辑主程序和附属模块时使用同一底稿，失败不修改原文', () => {
    const editor = createKernelScriptSession({} as KernelScriptSessionOptions)
    const base = {
      source: 'const a = 1;\nexport default a',
      modules: { 'lib/value.js': 'export const n = 2;' },
      input: { n: 3 },
      blobs: { text: '原文' },
    }
    const edits = [
      { oldText: 'a = 1', newText: 'a = 4' },
      { module: 'lib/value.js', oldText: 'n = 2', newText: 'n = 5' },
    ]
    const updated = editor.edit(base, edits)
    expect(updated.ok).toBe(true)
    if (!updated.ok) throw new Error('应当编辑成功')
    expect(updated.program.source).toContain('a = 4')
    expect(updated.program.modules?.['lib/value.js']).toContain('n = 5')
    expect(updated.program.input).toEqual(base.input)
    expect(updated.program.blobs).toEqual(base.blobs)
    const failed = editor.edit(base, [...edits, { oldText: '不存在', newText: 'x' }])
    expect(failed).toMatchObject({ ok: false, code: 'SCRIPT_EDIT', editIndex: 2 })
    expect(base.source).toContain('a = 1')
    expect(base.modules['lib/value.js']).toContain('n = 2')
    expect(
      editor.edit(base, [
        { oldText: 'const a', newText: 'let a' },
        { oldText: 'a = 1', newText: 'a = 3' },
      ]).ok
    ).toBe(false)
  })

  test('INV-33 附属模块按提交版本执行一次，模块诊断带自己的源码位置', async () => {
    const program = {
      source:
        "import { n } from './lib/value.js'\nimport { twice } from './lib/use.js'\nexport default [n, twice]",
      modules: {
        'lib/value.js': "console.log('module-once'); export const n = 3;",
        'lib/use.js': "import { n } from './value.js'; export const twice = n * 2;",
      },
    }
    const outcome = await session.submit({ program, granted, timeoutMs: 10_000 })
    expect(outcome.checked).toBe(true)
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.value).toEqual([3, 6])
    expect(outcome.result.logs?.filter((line) => line.includes('module-once'))).toHaveLength(1)
    const checked = codeProgramChecker.check({
      ...program,
      modules: { ...program.modules, 'lib/value.js': 'export const n = missingName;' },
      granted,
    })
    expect(checked.ok).toBe(false)
    if (checked.ok) throw new Error('应当给出模块诊断')
    expect(checked.diagnostics[0]).toMatchObject({ file: 'lib/value.js', line: 1 })
    expect(checked.diagnostics[0]?.frame).toContain('export const n = missingName;')
    expect(checked.diagnostics[0]?.frame).toContain('^')
    const failed = await session.submit({
      program: {
        source: "import { fail } from './lib/fail.js'; fail();",
        modules: {
          'lib/fail.js': "export function fail() {\n  throw new Error('module failure')\n}",
        },
      },
      granted,
      timeoutMs: 10_000,
    })
    if (!failed.checked) throw new Error('应当执行后失败')
    expect(failed.result.failed?.message).toContain('module failure')
  }, 20_000)
})
