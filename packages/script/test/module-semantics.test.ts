import { expect, test } from 'bun:test'

import type { InvocationJournal, InvocationRecord } from '@velaros-ai/kernel'
import { createOperationRuntime } from '@velaros-ai/kernel'

import { codeProgramChecker } from '../src/impl/CodeProgramChecker'
import { createCodeSurfaceSession } from '../src/impl/CodeSurfaceSession'
import { createKernelScriptSession } from '../src/impl/KernelScriptSession'
import { nodeSubprocessCodeRunner } from '../src/impl/NodeSubprocessCodeRunner'
import { readModuleSpecifiers } from '../src/utils/module-form'

const cases = [
  {
    name: '动态 import 延迟求值且未执行分支不初始化模块',
    source:
      "const before=globalThis.initialized??0; if(false) await import('./unused.js'); const ns=await import('./value.js'); export default [before,ns.n,globalThis.initialized,globalThis.unused??0]",
    modules: {
      'value.js': 'globalThis.initialized=(globalThis.initialized??0)+1; export const n=7',
      'unused.js': 'globalThis.unused=1; export const n=99',
    },
    value: [0, 7, 1, 0],
  },
  {
    name: '嵌套函数模板字面量 import 与计算相对路径共享原生 namespace',
    path: 'app/main.js',
    source:
      "const load=()=>import(`../lib/value.js`); const first=await load(); const target='../lib/'+'value.js'; const second=await import(target); first.bump(); export default [first===second,second.n,globalThis.initialized]",
    modules: {
      'lib/value.js':
        'globalThis.initialized=(globalThis.initialized??0)+1; export let n=7; export function bump(){n++}',
    },
    value: [true, 8, 1],
  },
  {
    name: '动态 import 的 then 导出遵循原生 Promise assimilation',
    source:
      "import * as statically from './value.js'; const dynamic=await import('./value.js'); export default [statically.n,dynamic]",
    modules: { 'value.js': 'export const n=7; export function then(resolve){resolve(99)}' },
    value: [7, 99],
  },
  {
    name: '主模块 namespace 重导出不向 direct eval 暴露额外局部绑定',
    source:
      "export * as counter from './lib/counter.js'; export default [eval('typeof __velarosNamespace0'),eval('typeof value')]",
    modules: { 'lib/counter.js': 'export const n=7' },
    value: { counter: { n: 7 }, default: ['undefined', 'undefined'] },
  },
  {
    name: '附属模块 namespace 重导出不改变 eval 词法域',
    source: "import {observed} from './lib/public.js'; export default observed",
    modules: {
      'lib/public.js':
        "export * as counter from './counter.js'; export const observed=[eval('typeof __velarosNamespace0'),eval('typeof value')]",
      'lib/counter.js': 'export const n=7',
    },
    value: ['undefined', 'undefined'],
  },
  {
    name: '虚拟 namespace 桥避开用户路径且保留深层相对路径与 TLA 身份',
    path: 'app/deep/main.js',
    source:
      "export * as first from '../../lib/public.js'; import {first} from './main.js'; import * as direct from '../../lib/public.js'; import marker from '../../_velaros_namespace_0.js'; export default [first===direct,first.n,globalThis.initialized,marker]",
    modules: {
      '_velaros_namespace_0.js': "export default 'user-module'",
      'lib/public.js': "export * as nested from './counter.js'; export {n} from './counter.js'",
      'lib/counter.js':
        'globalThis.initialized=(globalThis.initialized??0)+1; export const n=await Promise.resolve(9)',
    },
    value: { first: { nested: { n: 9 }, n: 9 }, default: [true, 9, 1, 'user-module'] },
  },
  {
    name: 'namespace 桥保持循环内的模块身份与活绑定',
    source:
      "import {peer,check} from './lib/a.js'; import * as b from './lib/b.js'; b.bump(); export default [peer===b,check(),peer.n]",
    modules: {
      'lib/a.js':
        "export * as peer from './b.js'; import {peer} from './a.js'; export function check(){ return peer.n }",
      'lib/b.js':
        "import {check} from './a.js'; export let n=4; export function bump(){ n+=2 }; export {check}",
    },
    value: [true, 6, 6],
  },
  {
    name: '主程序多个namespace重导出保持同一模块身份',
    source:
      "export * as first from './lib/counter.js'; export * as second from './lib/counter.js'; import {first,second} from './main.js'; export default first===second",
    path: 'main.js',
    modules: { 'lib/counter.js': 'export const n=7' },
    value: { first: { n: 7 }, second: { n: 7 }, default: true },
  },
  {
    name: '命名空间重导出只读且内部仍为 live binding',
    source:
      "import * as outer from './lib/public.js'; import * as direct from './lib/counter.js'; const before=outer.counter; let rejected=false; try{outer.counter={n:99}}catch{rejected=true}; direct.bump(); export default [rejected,outer.counter===before,outer.counter===direct,outer.counter.n]",
    modules: {
      'lib/public.js':
        "const __velarosNamespace0='occupied'; export * as counter from './counter.js'; export { __velarosNamespace0 }",
      'lib/counter.js': 'export let n=4; export function bump(){ n+=2 }',
    },
    value: [true, true, true, 6],
  },
  {
    name: '具名 import 保留 live binding',
    source: "import { n, bump } from './lib/counter.js'; bump(); export default n",
    modules: { 'lib/counter.js': 'export let n=0; export function bump(){ n++ }' },
    value: 1,
  },
  {
    name: 'namespace 和 re-export 保留 live binding',
    source: "import * as values from './lib/public.js'; values.bump(); export default values.n",
    modules: {
      'lib/public.js': "export * from './counter.js'",
      'lib/counter.js': 'export let n=4; export function bump(){ n+=2 }',
    },
    value: 6,
  },
  {
    name: '静态 import 在主模块正文之前执行',
    source: "globalThis.order=2; import './lib/init.js'; export default globalThis.order",
    modules: { 'lib/init.js': 'globalThis.order=1' },
    value: 2,
  },
  {
    name: '循环依赖链接函数声明而不递归执行模块',
    source: "import { a } from './lib/a.js'; export default a()",
    modules: {
      'lib/a.js': "import { b } from './b.js'; export function a(){ return b() }; export const n=7",
      'lib/b.js': "import { n } from './a.js'; export function b(){ return n }",
    },
    value: 7,
  },
  {
    name: '附属模块顶层 await 与别名 import 只初始化一次',
    source:
      "import { n } from './lib/counter.js'; import * as again from './lib/counter.js'; export default [n,again.n,globalThis.initialized]",
    modules: {
      'lib/counter.js':
        'globalThis.initialized=(globalThis.initialized??0)+1; export let n=await Promise.resolve(9)',
    },
    value: [9, 9, 1],
  },
  {
    name: '主程序 path 决定相对 import 且 default 函数保持其自身名字',
    path: 'lib/main.js',
    source: "import value from './value.js'; export default value()",
    modules: { 'lib/value.js': 'export default function named(){ return named.name }' },
    value: 'named',
  },
  {
    name: '同步模块导出 then 不被宿主当作 Promise assimilation 执行',
    source: 'export function then(resolve){ resolve(99) }; export const n=7',
    modules: {},
    value: { n: 7 },
  },
  {
    name: '顶层 await 模块导出 then 保留普通导出含义',
    source:
      'await Promise.resolve(); export function then(resolve){ resolve(99) }; export const n=7',
    modules: {},
    value: { n: 7 },
  },
] as const

for (const fixture of cases)
  test(`INV-40 原生模块语义：${fixture.name}`, async () => {
    const session = createCodeSurfaceSession({
      checker: codeProgramChecker,
      runner: nodeSubprocessCodeRunner,
      capabilities: { listOperations: () => ({}), invoke: async () => ({}) },
    })
    const outcome = await session.submit({ program: fixture, granted: [], timeoutMs: 3000 })
    expect(outcome.checked).toBe(true)
    if (!outcome.checked) throw new Error('模块应通过预检')
    expect(outcome.result.failed).toBeUndefined()
    expect(outcome.rawValue).toEqual(fixture.value)
  })

test('INV-40 namespace 重导出语法降级保持后续错误行号', async () => {
  const session = createCodeSurfaceSession({
    checker: codeProgramChecker,
    runner: nodeSubprocessCodeRunner,
    capabilities: { listOperations: () => ({}), invoke: async () => ({}) },
  })
  const outcome = await session.submit({
    program: {
      source: "export *\n as counter\n from './lib/counter.js';\nthrow new Error('line proof');",
      modules: { 'lib/counter.js': 'export const n=7' },
    },
    granted: [],
    timeoutMs: 3000,
  })
  expect(outcome.checked).toBe(true)
  if (!outcome.checked) throw new Error('模块应通过预检')
  expect(outcome.result.failed?.line).toBe(4)
  expect(outcome.result.failed?.message).toContain('line proof')
})

test('INV-40 namespace 桥只链接原来授权的能力并保持直接导入身份', async () => {
  let calls = 0
  const session = createCodeSurfaceSession({
    checker: codeProgramChecker,
    runner: nodeSubprocessCodeRunner,
    capabilities: {
      listOperations: () => ({ proof: ['read'] }),
      invoke: async () => {
        calls++
        return { value: 7 }
      },
    },
  })
  const granted = [
    {
      namespace: 'proof',
      declarations: "declare module 'velaros:proof' { export function read(): Promise<number> }",
    },
  ]
  const outcome = await session.submit({
    program: {
      path: 'main.js',
      source:
        "export * as tools from 'velaros:proof'; import {tools} from './main.js'; import * as direct from 'velaros:proof'; export default [tools===direct,await tools.read()]",
    },
    granted,
    timeoutMs: 3000,
  })
  expect(outcome.checked).toBe(true)
  if (!outcome.checked) throw new Error('模块应通过预检')
  expect(outcome.result.failed).toBeUndefined()
  expect(outcome.rawValue).toEqual({ tools: {}, default: [true, 7] })
  expect(calls).toBe(1)
  const denied = await session.submit({
    program: { source: "export * as blocked from 'velaros:private'" },
    granted,
  })
  expect(denied).toEqual({ checked: false, needsModules: ['private'] })
  expect(calls).toBe(1)
})

test('INV-40 动态字面量依赖按 AST 收集，保留首次出现顺序', () => {
  expect(
    readModuleSpecifiers(
      "import './a.js'; const load=()=>import(`velaros:proof`); if(false) import('./b.js'); import(target); export * from './a.js'; // import('ignored')"
    )
  ).toEqual(['./a.js', 'velaros:proof', './b.js'])
})

test('INV-40 动态字面量能力进入统一绑定，计算模块名不扩大授权', async () => {
  let calls = 0
  const records = new Map<string, InvocationRecord>()
  const key = (value: { sessionId: string; id: string }) =>
    JSON.stringify([value.sessionId, value.id])
  const journal: InvocationJournal = {
    read: async (sessionId, id) => records.get(key({ sessionId, id })) ?? null,
    claim: async (prepared) => {
      const existing = records.get(key(prepared))
      if (existing) return existing
      records.set(key(prepared), { phase: 'reserved', prepared })
      return null
    },
    prepare: async (prepared) => {
      records.set(key(prepared), { phase: 'prepared', prepared })
    },
    settle: async (receipt) => {
      records.set(key(receipt.invocation), {
        phase: 'settled',
        prepared: receipt.invocation,
        receipt,
      })
    },
  }
  const runtime = createOperationRuntime({
    modules: [
      {
        binding: {
          moduleId: 'velaros:proof',
          instanceId: 'proof',
          generation: 1,
          schemaRevision: '1',
        },
        summary: 'dynamic import proof',
        operations: {
          read: {
            summary: 'read',
            input: { type: 'null' },
            output: { type: 'number' },
            effects: 'none',
            run: () => ++calls,
          },
        },
      },
    ],
    journal,
  })
  try {
    const run = (source: string, allowedModules = ['velaros:proof']) =>
      createKernelScriptSession({
        runtime,
        runner: nodeSubprocessCodeRunner,
        sessionId: 'dynamic-session',
        executionId: `dynamic-${calls}-${allowedModules.length}`,
        allowedModules,
      }).run({ source })
    const result = await run(
      "const first=await import(`velaros:proof`); const target='velaros:'+'proof'; const second=await import(target); export default [first===second,await second.read()]"
    )
    expect(result.checked).toBe(true)
    if (!result.checked) throw new Error('动态字面量应通过预检')
    expect(result.result.failed).toBeUndefined()
    expect(result.rawValue).toEqual([true, 1])
    expect(calls).toBe(1)
    expect([...records.values()].map((record) => [record.phase, record.receipt?.outcome])).toEqual([
      ['settled', 'succeeded'],
    ])
    const denied = await run("const proof=await import('velaros:proof'); await proof.read()", [])
    expect(denied.checked).toBe(true)
    if (!denied.checked) throw new Error('Node 链接时验证权限')
    expect(denied.result.failed).toBeDefined()
    expect(calls).toBe(1)
    const computed = await run(
      "const target='velaros:'+'proof'; let message=''; try {await import(target)} catch(error){message=error.message}; export default message",
      []
    )
    expect(computed.checked).toBe(true)
    if (!computed.checked) throw new Error('计算目标在运行时核对')
    expect(computed.result.failed).toBeUndefined()
    expect(computed.rawValue).toContain('velaros:proof')
    expect(calls).toBe(1)
  } finally {
    await runtime.dispose()
  }
})

test('INV-40 动态字面量路径在任何能力副作用前预检并保留目标名', async () => {
  let calls = 0
  const session = createCodeSurfaceSession({
    checker: codeProgramChecker,
    runner: nodeSubprocessCodeRunner,
    capabilities: {
      listOperations: () => ({ proof: ['read'] }),
      invoke: async () => ({ value: ++calls }),
    },
  })
  const granted = [
    {
      namespace: 'proof',
      declarations: "declare module 'velaros:proof' { export function read(): Promise<number> }",
    },
  ]
  for (const target of ['./missing.js', 'velaros/shell', 'node:fs']) {
    const result = await session.submit({
      program: {
        source: `import {read} from 'velaros:proof'; await read(); await import(${JSON.stringify(target)})`,
      },
      granted,
    })
    expect(result.checked).toBe(false)
    if (result.checked || !('check' in result)) throw new Error('应在执行前诊断非法路径')
    expect(result.check.diagnostics[0]?.message).toContain(target)
  }
  const nested = await session.submit({
    program: {
      source: "await import('./nested.js')",
      modules: { 'nested.js': 'export const x = ;' },
    },
    granted,
  })
  expect(nested.checked).toBe(false)
  if (nested.checked || !('check' in nested)) throw new Error('动态附属模块也应检查语法')
  expect(nested.check.diagnostics[0]?.file).toBe('nested.js')
  expect(calls).toBe(0)
})

test('INV-40 原生动态导入加载标准库，缺失模块可 catch 并保留目标路径', async () => {
  const session = createCodeSurfaceSession({
    checker: codeProgramChecker,
    runner: nodeSubprocessCodeRunner,
    capabilities: { listOperations: () => ({}), invoke: async () => ({}) },
  })
  const result = await session.submit({
    program: {
      source:
        "const failures=[]; for (const target of ['node:fs','./missing.js','../../escape.js','hidden.js']) { try {await import(target); failures.push('opened')} catch(error){failures.push(error.message)} }; export default failures",
      modules: { 'hidden.js': "export default 'private relative module'" },
    },
    granted: [],
  })
  expect(result.checked).toBe(true)
  if (!result.checked) throw new Error('计算目标在运行时核对')
  expect(result.result.failed).toBeUndefined()
  expect(result.rawValue).toEqual([
    'opened',
    expect.stringContaining('missing.js'),
    expect.stringContaining('escape.js'),
    expect.stringContaining('hidden.js'),
  ])
})
