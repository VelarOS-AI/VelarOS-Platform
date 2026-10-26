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

// executeNativeNode / nodeSubprocessCodeRunner 的进程组宿主仅支持 POSIX。
const it = test.skipIf(process.platform === 'win32')

/** 这一轮授权的命名空间；没授权的模块不在声明里，import 它就落不到。 */
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
  test('INV-1 语法没过就一行都不执行，行号与模型写的对得上', async () => {
    const outcome = await submit(
      `${importDemo}\nawait write({ text: '不该跑' })\nexport default [1, 2].map((n) => n * 2`
    )
    expect(outcome.checked).toBe(false)
    if (outcome.checked || !('check' in outcome)) throw new Error('应当没通过检查')
    const [first] = outcome.check.diagnostics
    expect(first?.line).toBe(3)
    expect(first?.message).toContain("')' expected")
  })

  it('INV-1 类型不查：字段名写错、空数组推不出类型的程序照跑，写错的字段读到 undefined', async () => {
    const outcome = await submit(`${importDemo}
const r = await read({ paths: ['a.ts'] })
const found = { items: [] }
found.items.push(r.files[0].path)
export default { missing: r.files[0].contents ?? '没有这个字段', items: found.items }`)
    expect(outcome.checked).toBe(true)
    if (!outcome.checked) throw new Error('类型不查，应当照跑')
    expect(outcome.result.failed).toBeUndefined()
    expect(outcome.result.value).toEqual({ missing: '没有这个字段', items: ['a.ts'] })
  })

  it('INV-1 通过检查的程序照常跑完，只有它交出的那点东西出来', async () => {
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

  it('INV-2 Node 标准库与子进程使用宿主授权范围', async () => {
    const result = await nodeSubprocessCodeRunner.run(
      {
        source:
          "import {readFile} from 'node:fs/promises';import {spawnSync} from 'node:child_process';export default [typeof readFile,spawnSync(process.execPath,['-e','process.stdout.write(String(6*7))'],{encoding:'utf8'}).stdout]",
        operations: {},
        modules: {},
        blobs: {},
        input: undefined,
        timeoutMs: 5000,
      },
      async () => ({}),
      () => {}
    )
    expect(result.ok).toBe(true)
    expect(result.value).toEqual(['function', '42'])
  })

  it('INV-3 死循环到时必停', async () => {
    const outcome = await submit('while (true) {}\nexport default 1', { timeoutMs: 800 })
    expect(outcome.checked).toBe(true)
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.failed?.code).toBe(CodeSurfaceErrorCodes.timeout)
  })

  it('INV-3 阻塞事件循环时仍由宿主终止进程', async () => {
    const outcome = await submit(
      "import { hang } from 'velaros:demo'; void hang({tag:'cpu-wait'}); while(true){}",
      { timeoutMs: 300 }
    )
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.failed?.code).toBe(CodeSurfaceErrorCodes.timeout)
    expect(outcome.result.completed).toBeUndefined() // 事件循环阻塞前尚未派发的 I/O 不记作已执行
  }, 5_000)

  it('INV-2 Node 原生全局可用，运行之间隔离全局状态', async () => {
    const first = await submit(
      "export default Function('globalThis.testMark=1;return [typeof fetch,typeof WebSocket,typeof process,typeof require]')()"
    )
    if (!first.checked) throw new Error('应当通过检查')
    expect(first.result.value).toEqual(['function', 'function', 'object', 'undefined'])
    const second = await submit("export default Function('return typeof testMark')()")
    if (!second.checked) throw new Error('应当通过检查')
    expect(second.result.value).toBe('undefined')
  })

  it('INV-4 拒绝是能 try/catch 的异常，并且进 notices', async () => {
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

  it('INV-4 只有拒绝进 notices：调用自己的失败程序接得住，不再回放；程序死在拒绝上时 failed 说了就不重复', async () => {
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

  it('INV-6 blobs 原样送达，反引号与转义一个不错', async () => {
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

  it('INV-7 返回值超预算按结尾保留并说明', async () => {
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

  it('INV-10 手滑写 TypeScript 照跑，并提醒下次写 JavaScript', async () => {
    const outcome = await submit(`${importDemo}
const r = await read({ paths: ['a.ts'] })
const first = r.files[0] as { path: string }
export default first.path`)
    expect(outcome.checked).toBe(true)
    if (!outcome.checked) throw new Error('语法偏好不该把一整轮弹回去')
    expect(outcome.result.value).toBe('a.ts')
    expect(outcome.result.notices?.some((notice) => notice.action === 'normalized')).toBe(true)
  })

  test('INV-10 但真的语法错照样拦下来，不因为夹带 TypeScript 语法就放行', async () => {
    const outcome = await submit(`${importDemo}
const r = await read({ paths: ['a.ts'] })
const first = r.files[0] as { path: string }
export default first.path)`)
    expect(outcome.checked).toBe(false)
    if (outcome.checked || !('check' in outcome)) throw new Error('应当拦下来')
    expect(outcome.check.diagnostics.some((diagnostic) => diagnostic.line === 4)).toBe(true)
  })

  test('INV-12 诊断带代码帧，模型不必数行', async () => {
    const source = `${importDemo}\nconst r = await read({ paths: ['a.ts'] })\nexport default r.files.map((f) => f.content`
    const outcome = await submit(source)
    expect(outcome.checked).toBe(false)
    if (outcome.checked || !('check' in outcome)) throw new Error('应当没通过检查')
    const rendered = outcome.check.diagnostics.map((item) => item.frame).join('\n')
    expect(rendered).toContain('3 | export default r.files.map((f) => f.content')
    expect(rendered).toContain('^')
  })

  test('INV-39 代码模版另走完整类型检查：写错的键照声明拦下；模型交的程序不走这条', () => {
    const template = `${importDemo}\nconst r = await read({ paths: ['a.ts'] })\nexport default r.files[0].contents`
    const typed = codeProgramChecker.typecheck({ source: template, granted })
    expect(typed.ok).toBe(false)
    if (typed.ok) throw new Error('模版写错的键应当被拦下')
    expect(typed.diagnostics[0]).toMatchObject({ line: 3 })
    expect(typed.diagnostics[0]?.message).toContain("'content'")
    expect(codeProgramChecker.check({ source: template, granted }).ok).toBe(true)
  })

  test('INV-13 import 了没授权的模块：一行都不执行，回要补的命名空间', async () => {
    const outcome = await submit("import { log } from 'velaros:git'\nexport default await log({})")
    expect(outcome.checked).toBe(false)
    if (outcome.checked || !('needsModules' in outcome)) throw new Error('应当要求先补模块')
    expect(outcome.needsModules).toEqual(['git'])
  })

  it('INV-13 没 import 直接用没授权的名字，不是要补模块：跑到那一行干净地报错', async () => {
    const outcome = await submit('export default await git.log({})')
    if (!outcome.checked) throw new Error('没有 import 就不是要补模块')
    expect(outcome.result.failed?.message).toContain('git')
  })

  test('INV-13 能力模块的导出名照声明核对：写错的名字执行之前就报，并说它实际导出什么', async () => {
    const outcome = await submit(
      "import { readFile } from 'velaros:demo'\nexport default await readFile({})"
    )
    expect(outcome.checked).toBe(false)
    if (outcome.checked || !('check' in outcome)) throw new Error('应当是诊断')
    expect(outcome.check.diagnostics).toMatchObject([
      {
        line: 1,
        code: 2305,
        message:
          "'velaros:demo' 没有导出 readFile；它导出 read、write、danger、bulk、refuse、slow、hang。",
      },
    ])
  })

  test('INV-13 import 落不到的都在执行之前拦下：非能力模块、库里没有的脚本', async () => {
    const outcome = await submit(
      "import { readFileSync } from 'node:fs'\nimport { helper } from './lib/missing.js'\nexport default helper(readFileSync)"
    )
    expect(outcome.checked).toBe(false)
    if (outcome.checked || !('check' in outcome)) throw new Error('应当是诊断')
    expect(
      outcome.check.diagnostics.map(({ line, code, message }) => [line, code, message])
    ).toEqual([
      [
        1,
        2307,
        "找不到模块 'node:fs'：脚本只能 import velaros 的能力模块和库里的脚本（./ 或 ../ 开头）。",
      ],
      [2, 2307, "找不到模块 './lib/missing.js'：库里没有 lib/missing.js。"],
    ])
  })

  it('INV-15 blobs 必须导入，不是隐形全局；velaros:program 不占授权名额也不进租约账', async () => {
    // 不导入直接用 → 干净的报错，不是「有个全局你本来就该知道」
    const bare = await submit('export default blobs.patch', { blobs: { patch: 'x' } })
    if (!bare.checked) throw new Error('语法没错，应当照跑')
    expect(bare.result.failed?.message).toContain('blobs')

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

  it('INV-16 被时间掐断时交出执行账，模型知道自己做到哪了', async () => {
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

  it('INV-16 跑完了不交账：程序是模型自己写的，它知道自己调了什么', async () => {
    const outcome = await submit(
      `${importDemo}\nawait read({ paths: ['a.ts'] })\nexport default 'ok'`
    )
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.value).toBe('ok')
    expect(outcome.result.completed).toBeUndefined()
  })

  it('INV-17 堆爆了是 TOO_LARGE 并说清怎么改，不是一句「意外退出」', async () => {
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

  it('INV-18 能力调用的时间不计进程序超时：命令跑多久由它自己的时限管', async () => {
    // 调用本身要 1.5 秒，而程序自己的预算只有 1 秒：调用期间不停表的话，这段程序必被我们自己杀掉。
    const outcome = await submit(
      "import { slow } from 'velaros:demo'\nconst { done } = await slow({ ms: 1500 })\nexport default done",
      { timeoutMs: 1_000 }
    )
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.failed).toBeUndefined()
    expect(outcome.result.value).toBe(true)
  }, 20_000)

  it('INV-18 等用户点头的时间不计进程序超时', async () => {
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

  it('INV-18 停表只扣等人的那段，程序自己的预算一点不变', async () => {
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

  it('INV-21 把读到的大段内容塞进 throw，回到模型那里的仍然只有开头一小段', async () => {
    const outcome = await submit(
      `${importDemo}\nconst r = await bulk({ size: 3_000_000 })\nthrow new Error(r.text)`
    )
    if (!outcome.checked) throw new Error('应当通过检查')
    expect(outcome.result.failed?.code).toBe(CodeSurfaceErrorCodes.programError)
    expect(outcome.result.failed!.message.length).toBeLessThan(CodeSurfaceLimits.failureChars + 200)
    expect(outcome.result.failed!.message).toContain('字符省略')
    expect(JSON.stringify(outcome).length).toBeLessThan(CodeSurfaceLimits.resultChars)
  })

  it('INV-21 被拒两百次、每次一万字：连着的同一件事折成一条', async () => {
    const outcome = await submit(`import { refuse } from 'velaros:demo'
for (let i = 0; i < 150; i++) { try { await refuse({ n: i }) } catch (error) { void error } }
export default 1`)
    if (!outcome.checked) throw new Error('应当通过检查')
    const denied = outcome.result.notices?.filter((notice) => notice.action === 'denied') ?? []
    expect(denied).toHaveLength(1)
    expect(denied[0]!.detail).toContain('连着 150 次')
    expect(JSON.stringify(outcome).length).toBeLessThan(CodeSurfaceLimits.noticeChars + 500)
  })

  test('INV-21 两千个语法错只列前面那几条，并说明省了几条', async () => {
    const outcome = await submit(
      Array.from({ length: 2000 }, (_, index) => `const v${index} = ;`).join('\n')
    )
    if (outcome.checked || !('check' in outcome)) throw new Error('应当是诊断')
    expect(outcome.check.diagnostics.length).toBeLessThanOrEqual(CodeSurfaceLimits.diagnostics)
    expect(outcome.check.omitted).toBeGreaterThan(1900)
    expect(JSON.stringify(outcome).length).toBeLessThan(CodeSurfaceLimits.diagnosticChars + 500)
  })

  it('INV-22 只有 export default 就交它；有具名导出就交 { default?, ...具名 }，跟 import * 的形状一样', async () => {
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

  it('INV-22 export default 不中断执行：它后面的代码照样跑，运行时报错的行号仍是模型写的那一行', async () => {
    const after = await submit('export default "先交"\nconsole.log("后面也跑了")')
    if (!after.checked) throw new Error('应当通过检查')
    expect(after.result.value).toBe('先交')
    expect(after.result.process?.stdout.trim()).toBe('后面也跑了')

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

  it('INV-23 能力交出的图走旁边的通道：程序拿不到像素，结果里没有 base64，超过张数上限按顺序丢后面的', async () => {
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
  it('INV-26 程序停下时还没落定的调用被叫停，并逐条列在 unsettled 里', async () => {
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

  it('INV-27 程序数据模块只导出本次 input 与 blobs，保持原文与冻结边界', async () => {
    const input = { key: 'progress', nested: { version: 2 } }
    const blobs = { body: 'literal ` ${text} \\ 内容\nsecond line' }
    const read = await session.submit({
      program: {
        source:
          "import * as program from 'velaros:program'\nexport default {keys:Object.keys(program).sort(),input:program.input,blobs:program.blobs,frozen:!Object.isExtensible(program)&&!Reflect.set(program,'input',null)&&Object.isFrozen(program.input.nested)&&Object.isFrozen(program.blobs)}",
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

  it('INV-33 附属模块按提交版本执行一次，模块诊断带自己的源码位置', async () => {
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
    expect(
      outcome.result.process?.stdout.split('\n').filter((line) => line.includes('module-once'))
    ).toHaveLength(1)
    const checked = codeProgramChecker.check({
      ...program,
      modules: { ...program.modules, 'lib/value.js': 'export const n = (3;' },
      granted,
    })
    expect(checked.ok).toBe(false)
    if (checked.ok) throw new Error('应当给出模块诊断')
    expect(checked.diagnostics[0]).toMatchObject({ file: 'lib/value.js', line: 1 })
    expect(checked.diagnostics[0]?.frame).toContain('export const n = (3;')
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
