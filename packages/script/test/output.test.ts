import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, spyOn, test } from 'bun:test'
import ts from 'typescript'

import { VelarosStandardDeclarations } from '../src/contract/surface.js'
import {
  codeProgramChecker,
  createCodeSurfaceSession,
  nodeSubprocessCodeRunner,
  ScriptOutputLimits,
  scriptOutputs,
  scriptPackageCompiler,
} from '../src/index.js'
import { createOutputCollector, validateOutputOptions } from '../src/utils/output-capture.js'

const session = createCodeSurfaceSession({
  checker: codeProgramChecker,
  runner: nodeSubprocessCodeRunner,
  capabilities: { listOperations: () => ({}), invoke: async () => ({}) },
})
const run = (source: string, timeoutMs?: number) =>
  session.submit({
    program: { source: `import {output} from 'velaros';${source}` },
    ...scriptPackageCompiler.compile([], []),
    timeoutMs,
  })
function capture(value: unknown, options = {}) {
  const collector = createOutputCollector(ScriptOutputLimits, validateOutputOptions, () => {})
  collector.output(value, options)
  return collector.snapshot()
}

test('INV-35 text projection uses the sent representation without changing default JSON or full semantics', () => {
  const value = 'alpha("beta");\n'.repeat(40)
  const raw = capture(value, { key: 'sample', type: 'code', view: { mode: 'full' } })
  const before = JSON.stringify(raw)
  const legacy = scriptOutputs.project(raw, 'archive', 900)
  const text = scriptOutputs.project(raw, 'archive', 900, undefined, undefined, undefined, 'text')
  expect(legacy.format).toBe('json')
  expect(JSON.parse(legacy.prompt).blocks[0].representation).toBe('reference')
  expect(text.format).toBe('text')
  expect(text.blocks[0]!.representation).toBe('full')
  expect(text.blocks[0]!.text).toBe(value)
  expect(text.prompt).toContain(value)
  expect(text.prompt.length).toBeLessThanOrEqual(900)
  expect(JSON.stringify(raw)).toBe(before)
})

test('INV-35 text projection preserves the admitted block set and prior content before using free space', () => {
  const collector = createOutputCollector(ScriptOutputLimits, validateOutputOptions, () => {})
  const code = Array.from({ length: 80 }, (_, i) => `\t中文🙂 ${i} e\u0301="引用";\r`).join('\n')
  collector.output('low\n'.repeat(300), { key: 'low', type: 'text', priority: 'low' })
  collector.output(code, { key: 'high', type: 'code', priority: 'high' })
  collector.output(
    { success: false, exitCode: 2, code: 'TEST_FAILURE' },
    { key: 'failure', required: true }
  )
  collector.output(code, { key: 'zero', type: 'code', view: { maxChars: 0 } })
  collector.output(code, { key: 'reference', type: 'code', view: { mode: 'reference' } })
  collector.output('short', { key: 'short', type: 'text' })
  const raw = { ...collector.snapshot(), issues: ['synthetic capture failure retained'] }
  for (const budget of [0, 100, 400, 1200, 2400, 6000]) {
    const legacy = scriptOutputs.project(raw, 'archive-reference', budget)
    const text = scriptOutputs.project(
      raw,
      'archive-reference',
      budget,
      undefined,
      undefined,
      undefined,
      'text'
    )
    expect(text.blocks.map((b) => b.key)).toEqual(legacy.blocks.map((b) => b.key))
    expect(text.omittedBlocks).toBe(legacy.omittedBlocks)
    expect(text.issues).toEqual(legacy.issues)
    expect(text.prompt.length).toBeLessThanOrEqual(budget)
    for (const prior of legacy.blocks) {
      const next = text.blocks.find((b) => b.key === prior.key)!
      expect(next.rawRef).toBe(prior.rawRef)
      expect(next.pointer).toBe(prior.pointer)
      expect(next.contentHash).toBe(prior.contentHash)
      if (prior.bodyIncluded) expect(next.text).toContain(prior.text)
      if (prior.representation === 'full') expect(next.representation).toBe('full')
    }
    if (budget === 1200) {
      const before = legacy.blocks.find((b) => b.key === 'high')!
      const after = text.blocks.find((b) => b.key === 'high')!
      expect(before.text.length).toBeGreaterThan(0)
      expect(after.text.length).toBeGreaterThan(before.text.length)
    }
  }
})

test('INV-35 text projection keeps JSON and list baselines and preserves zero-budget issues', () => {
  for (const value of [
    { ok: false, detail: 'long\n'.repeat(600) },
    Array.from({ length: 80 }, (_, i) => ({ i, value: 'row' })),
  ]) {
    const raw = capture(value, { key: 'data' })
    for (const budget of [0, 200, 1800, 6000]) {
      const old = scriptOutputs.project(raw, 'archive', budget)
      const next = scriptOutputs.project(
        raw,
        'archive',
        budget,
        undefined,
        undefined,
        undefined,
        'text'
      )
      expect(next.blocks).toEqual(old.blocks)
      expect(next.omittedBlocks).toBe(old.omittedBlocks)
      expect(next.prompt.length).toBeLessThanOrEqual(budget)
    }
  }
  const raw = { ...capture('body', { key: 'body', required: true }), issues: ['capture failed'] }
  const none = scriptOutputs.project(raw, 'archive', 0, undefined, undefined, undefined, 'text')
  expect(none.prompt).toBe('')
  expect(none.issues).toEqual(['capture failed'])
  expect(none.omittedBlocks).toBe(1)
  expect(() =>
    scriptOutputs.project(
      raw,
      'archive',
      900,
      undefined,
      undefined,
      undefined,
      'unsupported' as 'text'
    )
  ).toThrow('输出展示编码')
})

test('INV-35 text projection expands only proven UTF-16 source ranges with unchanged view and full rules', () => {
  const value = Array.from({ length: 120 }, (_, i) => `\tline${i} = "😀\\path";\r`).join('\n')
  for (const edge of ['head', 'tail'] as const) {
    for (const mode of ['auto', 'full'] as const) {
      const raw = capture(value, {
        key: 'code',
        type: 'code',
        view: { edge, mode, lines: [7, 90] },
      })
      const old = scriptOutputs.project(raw, 'archive', 1400)
      const next = scriptOutputs.project(
        raw,
        'archive',
        1400,
        undefined,
        undefined,
        undefined,
        'text'
      )
      const prior = old.blocks[0]!
      const block = next.blocks[0]!
      expect(next.prompt.length).toBeLessThanOrEqual(1400)
      if (mode === 'full') expect(block.representation).toBe('reference')
      if (block.bodyIncluded) {
        const { from, shown, total } = (
          block.selection as { chars: { from: number; shown: number; total: number } }
        ).chars
        expect(value.slice(from, from + shown)).toBe(block.text)
        expect(total).toBe(value.length)
        if (prior.bodyIncluded) expect(block.text).toContain(prior.text)
      }
    }
  }
})

test('partial code selections locate the exact archived UTF-16 substring for head, tail and line windows', () => {
  const source = Array.from({ length: 120 }, (_, i) => `\tline${i} = "😀\\path";\r`).join('\n')
  for (const edge of ['head', 'tail'] as const) {
    for (const lines of [undefined, [7, 90] as const]) {
      const result = scriptOutputs.project(
        capture(source, { type: 'code', view: { edge, lines } }),
        'archive',
        1200
      )
      const block = result.blocks[0]!
      const { from, shown, total, unit } = (
        block.selection as { chars: { from: number; shown: number; total: number; unit: string } }
      ).chars
      expect(block.representation).toBe('excerpt')
      expect(source.slice(from, from + shown)).toBe(block.text)
      expect(total).toBe(source.length)
      expect(unit).toBe('utf16')
      expect(result.prompt.length).toBeLessThanOrEqual(1200)
      expect(block.text + source.slice(from + shown)).toBe(source.slice(from))
    }
  }
})

test('invalid display declarations identify expected and actual types in host and isolated execution', async () => {
  for (const [value, type, expected] of [
    [['source'], 'code', '要求字符串，实际为数组'],
    [{ value: 1 }, 'text', '要求字符串，实际为object'],
    ['source', 'list', '要求数组，实际为string'],
  ] as const) {
    expect(() => capture(value, { type })).toThrow(expected)
    // 动态值继续走原有运行时边界，不能靠类型预检省掉失败回执。
    const result = await run(
      `output(JSON.parse(${JSON.stringify(JSON.stringify(value))}),{type:${JSON.stringify(type)}})`
    )
    if (!result.checked) throw Error(JSON.stringify(result))
    expect(result.result.failed?.message).toContain(expected)
    expect(result.output?.blocks).toHaveLength(0)
  }
})

test('INV-41 标准 output 的确定类型矛盾在真实会话工具调用之前拒绝', async () => {
  for (const expression of [
    'output({body: 1}, {type: "text"})',
    'output(["body"], {type: "code"})',
    'output("body", {type: "list"})',
    'output(42, {type: "text"})',
    'output(null, {type: "list"})',
    'const {output: emit} = await import("velaros"); emit({body: 1}, {type: "text"})',
  ]) {
    let calls = 0
    let launches = 0
    const checkedSession = createCodeSurfaceSession({
      checker: codeProgramChecker,
      runner: {
        run: (...args) => {
          launches++
          return nodeSubprocessCodeRunner.run(...args)
        },
      },
      capabilities: {
        listOperations: () => ({ fixture: ['read'] }),
        invoke: async () => {
          calls++
          return { value: { body: 'synthetic' } }
        },
      },
    })
    const source = `import {output} from 'velaros'; import {read} from 'velaros:fixture';\nfor(let i=0;i<5;i++) await read({});\n${expression}`
    const outcome = await checkedSession.submit({
      program: { source },
      granted: [
        ...scriptPackageCompiler.compile([], []).granted,
        {
          namespace: 'fixture',
          declarations:
            "declare module 'velaros:fixture' { export function read(input: {}): Promise<{body: string}> }",
        },
      ],
      timeoutMs: 1000,
    })
    expect(outcome.checked).toBe(false)
    expect(calls).toBe(0)
    expect(launches).toBe(0)
    if (outcome.checked || !outcome.check || outcome.check.ok)
      throw new Error('应在工具执行前返回输出类型诊断')
    expect(outcome.check.diagnostics[0]).toMatchObject({ line: 3, code: 2345 })
    expect(outcome.check.diagnostics[0]?.frame).toContain(expression)
  }
})

test('INV-41 真实 output 的导入别名、命名空间与常量别名保持同一预检合同', () => {
  for (const source of [
    `import {output as emit} from 'velaros'; emit({}, {type:'text'});`,
    `import * as api from 'velaros'; api.output({}, {type:'text'});`,
    `import {output} from 'velaros'; const emit=output; emit({}, {type:'text'});`,
    `import {output} from 'velaros'; const value={body:'x'}; output(value, {type:'code'});`,
    `import {output} from 'velaros'; const value=Math.random()>0.5?42:false; output(value, {type:'text'});`,
    `const {output: emit}=await import('velaros'); emit({}, {type:'text'});`,
    `const api=await import('velaros'); api.output({}, {type:'text'});`,
    `import * as api from 'velaros'; const {output:emit}=api; emit({}, {type:'text'});`,
    `import * as api from 'velaros'; api['output']({}, {type:'text'});`,
    `import {output} from 'velaros'; const value={length:4}; const copy=value; output(copy, {type:'text'});`,
    `import {output} from 'velaros'; output({0:1,length:1}, {type:'list'});`,
    `import {output} from 'velaros'; output({}, {type:Math.random()>0.5?'text':'code'});`,
  ]) {
    const outcome = codeProgramChecker.check({
      source,
      granted: scriptPackageCompiler.compile([], []).granted,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics[0]?.code).toBe(2345)
  }
})

test('INV-41 合法值、未知值、泛型和动态声明保留兼容执行边界', () => {
  for (const body of [
    `output('body', {type:'text'}); output('body', {type:'code'}); output([], {type:'list'}); output({}, {type:'json'}); output({});`,
    `const value=JSON.parse('{}'); output(value, {type:'text'});`,
    `const value=Math.random()>0.5?'body':42; output(value, {type:'text'});`,
    `const options={type:Math.random()>0.5?'text':'json'}; output({}, options);`,
    `function emit(value, options) { output(value, options); }`,
    `const value:unknown=JSON.parse('{}'); output(value,{type:'text'});`,
    `function emit<T>(value:T){output(value,{type:'text'});} function words<T extends string>(value:T){output(value,{type:'text'});} function list<T>(value:T[]){output(value,{type:'list'});}`,
    `function emit(value: {}) { output(value,{type:'text'}); }`,
    `output({value:1},{get type(){return 'json'}});`,
  ]) {
    const outcome = codeProgramChecker.check({
      source: `import {output} from 'velaros'; ${body}`,
      granted: scriptPackageCompiler.compile([], []).granted,
    })
    expect(outcome.ok).toBe(true)
  }
})

test('INV-41 结构类型与动态属性不被静态推断误拒，真实执行仍交付原值', async () => {
  for (const [body, value] of [
    [`function emit(value:{length:number}){output(value,{type:'text'})} emit('hello');`, 'hello'],
    [
      `function emit(value:{slice(start?:number):string}){output(value,{type:'text'})} emit('hello');`,
      'hello',
    ],
    [
      `interface Sized {readonly length:number} function emit(value:Sized){output(value,{type:'code'})} emit('hello');`,
      'hello',
    ],
    [`function emit(value:String){output(value,{type:'text'})} emit('hello');`, 'hello'],
    [`function emit(value:ArrayLike<number>){output(value,{type:'list'})} emit([1,2]);`, [1, 2]],
    [`function emit(value:Iterable<number>){output(value,{type:'list'})} emit([1,2]);`, [1, 2]],
    [
      `function emit(value:readonly [number,string]){output(value,{type:'list'})} emit([1,'x']);`,
      [1, 'x'],
    ],
    [
      `const state={value:1};function update(){state.value='hello'}update();const alias=state.value;output(alias,{type:'text'});`,
      'hello',
    ],
    [
      `const values=[1];function update(){values[0]='hello'}update();output(values[0],{type:'text'});`,
      'hello',
    ],
    [
      `const options={type:'text' as const};function update(){options.type='json'}update();output({value:1},options);`,
      { value: 1 },
    ],
    [
      `const state={type:'text' as const};function update(){state.type='json'}update();output({value:1},{type:state.type});`,
      { value: 1 },
    ],
    [`const options={type:'json'};output({value:1},{type:'text',...options});`, { value: 1 }],
    [
      `const options={type:'json'};output({value:1},{type:'text',['type']:options.type});`,
      { value: 1 },
    ],
  ] as const) {
    const outcome = await run(body)
    expect(outcome.checked).toBe(true)
    if (!outcome.checked) throw new Error(JSON.stringify(outcome))
    expect(outcome.result.failed).toBeUndefined()
    expect(outcome.output?.blocks[0]?.value).toEqual(value)
  }
})

test('INV-41 局部同名函数、参数遮蔽与可重赋别名不冒充标准 output', () => {
  for (const source of [
    `function output(value, options) {} output({}, {type:'text'});`,
    `import {output} from 'velaros'; function local(output) { output({}, {type:'text'}); }`,
    `import {output as original} from 'velaros'; const output=(value,options)=>{}; output({}, {type:'text'});`,
    `import {output} from 'velaros'; let emit=output; emit=(value, options)=>{}; emit({}, {type:'text'});`,
  ])
    expect(
      codeProgramChecker.check({ source, granted: scriptPackageCompiler.compile([], []).granted })
        .ok
    ).toBe(true)
})

test('INV-41 附属模块的真实标准输出也在执行前给出原始文件定位', () => {
  const result = codeProgramChecker.check({
    source: "import './lib/display.js';",
    modules: {
      'lib/display.js': "import {output} from 'velaros';\noutput({body: 1}, {type:'text'});",
    },
    granted: scriptPackageCompiler.compile([], []).granted,
  })
  expect(result.ok).toBe(false)
  if (!result.ok)
    expect(result.diagnostics[0]).toMatchObject({ file: 'lib/display.js', line: 2, code: 2345 })
})

test('INV-34 output snapshots values at call time and preserves full raw structured values before preview clipping', async () => {
  const result = await run(
    `const value={text:'x'.repeat(80000),count:1};output(value,{key:'state',type:'json'});value.count=2;`
  )
  expect(result.checked).toBe(true)
  if (!result.checked) return
  expect(result.output?.blocks[0]?.value).toEqual({ text: 'x'.repeat(80000), count: 1 })
  expect(JSON.stringify(result.result).length).toBeLessThan(60001)
})

test('capture survives later exception and timeout, and caught duplicate keys remain an issue', async () => {
  for (const source of [
    `output(1,{key:'one'});throw Error('later');`,
    `output(1,{key:'one'});while(true){}`,
  ]) {
    const result = await run(source, 100)
    expect(result.checked).toBe(true)
    if (!result.checked) continue
    expect(result.result.failed).toBeDefined()
    expect(result.output?.blocks[0]?.value).toBe(1)
  }
  const result = await run(`output(1,{key:'one'});try{output(2,{key:'one'})}catch{};`)
  if (!result.checked) throw Error(JSON.stringify(result))
  expect(result.result.failed).toBeDefined()
  expect(result.output?.issues[0]).toContain('重复')
})

test('capture refuses lossy JSON, getters, cycles and raw limit without claiming complete archive', () => {
  const collector = createOutputCollector(ScriptOutputLimits, validateOutputOptions, () => {})
  let invoked = false
  expect(() =>
    collector.output({
      get value() {
        invoked = true
        return 1
      },
    })
  ).toThrow('getter')
  expect(invoked).toBe(false)
  const cycle: any = {}
  cycle.self = cycle
  expect(() => collector.output(cycle)).toThrow('无环')
  expect(() => collector.output(Infinity)).toThrow()
  expect(() => collector.output('x'.repeat(ScriptOutputLimits.rawChars))).toThrow('归档')
  expect(collector.snapshot().blocks).toHaveLength(0)
})

test('configure applies once before output and metadata does not change program value', async () => {
  const result = await run(
    `output.configure({maxChars:900});output({value:42},{key:'value',view:{mode:'reference'}});`
  )
  if (!result.checked) throw Error(JSON.stringify(result))
  expect(result.result.value).toEqual({ default: { value: 42 } })
  expect(result.output?.config.maxChars).toBe(900)
  const invalid = await run(`output(1);output.configure({maxChars:100});`)
  if (!invalid.checked) throw Error(JSON.stringify(invalid))
  expect(invalid.result.failed).toBeDefined()
})

test('INV-35 list selection keeps final complete items, correct ranges, immutable raw data and exact global budget', () => {
  const raw = capture(
    Array.from({ length: 100 }, (_, i) => ({ i, value: 'entry' })),
    { key: 'list', type: 'list', view: { maxItems: 5, edge: 'tail' } }
  )
  const result = scriptOutputs.project(raw, 'result', 1800)
  const block = result.blocks[0]!
  expect(JSON.parse(block.text).map((x: any) => x.i)).toEqual([95, 96, 97, 98, 99])
  expect(block.selection).toMatchObject({ from: 95, shown: 5, total: 100 })
  expect(block.representation).toBe('excerpt')
  expect(result.prompt.length).toBeLessThanOrEqual(1800)
  expect((raw.blocks[0]!.value as unknown[]).length).toBe(100)
})

test('INV-35 escaped code uses the available display budget without dropping half its complete lines', () => {
  const lines = Array.from({ length: 800 }, (_, i) => `\tconst value${i} = "source\\path😀";`)
  for (const edge of ['head', 'tail'] as const) {
    const raw = capture(lines.join('\n'), {
      key: 'code',
      type: 'code',
      view: { maxChars: 36000, edge },
    })
    const before = JSON.stringify(raw)
    for (const budget of [1800, 6000, 12000]) {
      const result = scriptOutputs.project(raw, 'ref', budget)
      const block = result.blocks[0]!
      expect(result.prompt.length).toBeLessThanOrEqual(budget)
      expect(result.prompt.length).toBeGreaterThan(budget - 100)
      expect(block.representation).toBe('excerpt')
      const shown = block.text.split('\n')
      expect(shown).toEqual(
        edge === 'head' ? lines.slice(0, shown.length) : lines.slice(-shown.length)
      )
      expect(block.selection).toMatchObject({
        shownLines: shown.length,
        edge,
        omittedLines: lines.length - shown.length,
      })
    }
    expect(JSON.stringify(raw)).toBe(before)
  }
})

test('INV-35 short later blocks return unused display space to earlier complete code lines', () => {
  const lines = Array.from({ length: 800 }, (_, i) => `\tconst value${i} = "source\\path😀";`)
  for (const edge of ['head', 'tail'] as const) {
    const collector = createOutputCollector(ScriptOutputLimits, validateOutputOptions, () => {})
    collector.output(lines.join('\n'), { key: 'a-code', type: 'code', view: { edge } })
    collector.output('finished', { key: 'z-status' })
    const raw = collector.snapshot()
    const before = JSON.stringify(raw)
    const result = scriptOutputs.project(raw, 'ref', 6000)
    expect(result.prompt.length).toBeLessThanOrEqual(6000)
    expect(result.prompt.length).toBeGreaterThan(5900)
    expect(result.blocks[1]!.representation).toBe('full')
    expect(result.blocks[1]!.text).toBe('finished')
    const code = result.blocks[0]!
    const shown = code.text.split('\n')
    expect(shown).toEqual(
      edge === 'head' ? lines.slice(0, shown.length) : lines.slice(-shown.length)
    )
    expect(code.representation).toBe('excerpt')
    expect(code.pointer).toBe('/output/blocks/0/value')
    expect(JSON.stringify(raw)).toBe(before)
  }
})

test('INV-35 redistributing spare space respects full-only views, explicit caps and reference policy', () => {
  const collector = createOutputCollector(ScriptOutputLimits, validateOutputOptions, () => {})
  collector.output('x'.repeat(3200), { key: 'a-full', view: { mode: 'full' } })
  collector.output('y\n'.repeat(5000), { key: 'b-limited', view: { maxChars: 40 } })
  collector.output('private body', { key: 'c-reference', view: { mode: 'reference' } })
  collector.output('ok', { key: 'z-status' })
  const raw = collector.snapshot()
  const result = scriptOutputs.project(raw, 'ref', 6000)
  expect(result.blocks[0]!.representation).toBe('full')
  expect(result.blocks[0]!.text).toBe('x'.repeat(3200))
  expect(result.blocks[1]!.text.length).toBeLessThanOrEqual(40)
  expect(result.blocks[1]!.representation).toBe('excerpt')
  expect(result.blocks[2]!.bodyIncluded).toBe(false)
  expect(result.blocks[2]!.reason).toBe('source-policy')
  expect(result.blocks[3]!.text).toBe('ok')
  expect(result.prompt.length).toBeLessThanOrEqual(6000)
  const tight = scriptOutputs.project(raw, 'ref', 1800)
  expect(tight.blocks[0]!.bodyIncluded).toBe(false)
  expect(tight.blocks[0]!.reason).toBe('full-unavailable')
  expect(tight.prompt.length).toBeLessThanOrEqual(1800)
})

test('INV-35 structured text fields expose complete lines and an exact raw pointer within the shared budget', () => {
  const lines = Array.from({ length: 600 }, (_, i) => `\tconst value${i} = "source\\path😀";`)
  for (const edge of ['head', 'tail'] as const) {
    const raw = capture(
      { success: true, exitCode: 0, 'out/~text': lines.join('\n'), stderr: '' },
      { key: 'command', view: { maxChars: 15000, edge } }
    )
    const before = JSON.stringify(raw)
    for (const budget of [1800, 6000, 12000]) {
      const result = scriptOutputs.project(raw, 'result-ref', budget)
      const value = JSON.parse(result.blocks[0]!.text)
      expect(value.success).toBe(true)
      expect(value.exitCode).toBe(0)
      expect(value.stderr).toBe('')
      const field = value['out/~text']
      expect(field.representation).toBe('excerpt')
      expect(field.rawRef).toBe('result-ref')
      expect(field.pointer).toBe('/output/blocks/0/value/out~1~0text')
      const shown = field.text.split('\n')
      expect(shown).toEqual(
        edge === 'head' ? lines.slice(0, shown.length) : lines.slice(-shown.length)
      )
      expect(field.selection).toMatchObject({
        shownLines: shown.length,
        omittedLines: lines.length - shown.length,
        edge,
      })
      expect(result.blocks[0]!.representation).toBe('excerpt')
      expect(result.prompt.length).toBeLessThanOrEqual(budget)
      expect(result.prompt.length).toBeGreaterThan(budget * 0.85)
    }
    expect(JSON.stringify(raw)).toBe(before)
  }
})

test('structured text selection keeps indivisible lines as references and respects full mode', () => {
  const value = { success: false, stdout: 'x'.repeat(20000), stderr: 'failed' }
  const raw = capture(value, { key: 'command' })
  const shown = JSON.parse(scriptOutputs.project(raw, 'ref', 1800).blocks[0]!.text)
  expect(shown.stdout.representation).toBe('reference')
  expect(shown.stdout.text).toBeUndefined()
  expect(shown.stderr).toBe('failed')
  const full = scriptOutputs.project(capture(value, { view: { mode: 'full' } }), 'ref', 1800)
  expect(full.blocks[0]!.reason).toBe('full-unavailable')
})

test('structured output shares space between long fields while keeping short diagnostics intact', () => {
  const value = {
    success: false,
    stdout: Array.from({ length: 500 }, (_, i) => `source line ${i}`).join('\n'),
    stderr: Array.from({ length: 500 }, (_, i) => `error line ${i}`).join('\n'),
    exitCode: 2,
  }
  const result = scriptOutputs.project(capture(value, { key: 'command' }), 'ref', 5000)
  const shown = JSON.parse(result.blocks[0]!.text)
  expect(shown.stdout.representation).toBe('excerpt')
  expect(shown.stderr.representation).toBe('excerpt')
  expect(shown.stdout.text).toStartWith('source line 0\n')
  expect(shown.stderr.text).toStartWith('error line 0\n')
  expect(shown.success).toBe(false)
  expect(shown.exitCode).toBe(2)
  expect(result.prompt.length).toBeLessThanOrEqual(5000)
})

test('code selects lines and long indivisible lines become references, never broken text', () => {
  const raw = capture('one\ntwo\nthree\nfour', {
    key: 'code',
    type: 'code',
    view: { lines: [2, 3] },
  })
  const block = scriptOutputs.project(raw, 'ref', 2000).blocks[0]!
  expect(block.text).toBe('two\nthree')
  expect(block.selection).toMatchObject({ lines: [2, 3], totalLines: 4, missing: false })
  const huge = capture('x'.repeat(10000), { key: 'code', type: 'code', view: { maxChars: 20 } })
  expect(scriptOutputs.project(huge, 'ref', 2000).blocks[0]!.representation).toBe('reference')
})

test('JSON pointers preserve valid structured values and surface missing paths', () => {
  const raw = capture(
    { user: { id: 1 }, 'a/b': 2 },
    { key: 'data', view: { paths: ['/user/id', '/a~1b', '/absent'] } }
  )
  const block = scriptOutputs.project(raw, 'ref', 4000).blocks[0]!
  expect(JSON.parse(block.text).fields).toEqual([
    { path: '/user/id', found: true, value: 1 },
    { path: '/a~1b', found: true, value: 2 },
    { path: '/absent', found: false },
  ])
  expect(block.selection).toMatchObject({
    paths: ['/user/id', '/a~1b', '/absent'],
    missing: ['/absent'],
  })
})

test('full mode never claims partial full and priority is independent of output order', () => {
  const collector = createOutputCollector(ScriptOutputLimits, validateOutputOptions, () => {})
  collector.output('x'.repeat(1000), { key: 'low', priority: 'low', view: { mode: 'full' } })
  collector.output('essential', { key: 'high', priority: 'high' })
  const result = scriptOutputs.project(collector.snapshot(), 'ref', 600)
  expect(result.blocks[0]?.key).toBe('high')
  expect(result.blocks[0]?.text).toBe('essential')
  expect(result.prompt.length).toBeLessThanOrEqual(600)
  const full = scriptOutputs.project(
    capture('x'.repeat(1000), { key: 'x', view: { mode: 'full', maxChars: 50 } }),
    'ref',
    1000
  )
  expect(full.blocks[0]?.reason).toBe('full-unavailable')
})

test('summary is invalidated by content and task revision, and never calls another model', () => {
  const raw = capture({ current: 1 }, { key: 'state', view: { mode: 'summary' } })
  const summary = {
    key: 'state',
    contentHash: scriptOutputs.hash({ current: 1 }),
    taskRevision: 'task-1',
    text: 'Current state is one.',
  }
  expect(
    scriptOutputs.project(raw, 'ref', 2000, undefined, [summary], 'task-1').blocks[0]!
      .representation
  ).toBe('summary')
  expect(
    scriptOutputs.project(raw, 'ref', 2000, undefined, [summary], 'task-2').blocks[0]!.reason
  ).toBe('summary-unavailable')
  expect(
    scriptOutputs.project(
      capture({ current: 2 }, { key: 'state', view: { mode: 'summary' } }),
      'ref',
      2000,
      undefined,
      [summary],
      'task-1'
    ).blocks[0]!.reason
  ).toBe('summary-unavailable')
})

test('INV-36 source editing preserves acquisition, intent and alias bindings and only changes view', () => {
  const source = `import {output as show} from 'velaros';\nconst data=await read();\nshow(data,{key:'code',purpose:'watch it',priority:'high',view:{maxChars:5000}});`
  const edited = scriptOutputs.edit(
    { source },
    {
      config: { maxChars: 2000 },
      outputs: [{ key: 'code', view: { maxChars: 500, mode: 'reference' } }],
    }
  )
  expect(edited.source).toContain('const data=await read();')
  expect(edited.source).toContain("purpose:'watch it',priority:'high'")
  expect(scriptOutputs.describe(edited).config).toEqual({ maxChars: 2000 })
  expect(scriptOutputs.describe(edited).outputs[0]!.view).toEqual({
    maxChars: 500,
    mode: 'reference',
  })
  expect(source).toContain('maxChars:5000')
})

test('source editor refuses shadowed, nested, dynamic, duplicate and privileged edits', () => {
  for (const source of [
    `function output(v,o){};output(1,{key:'x'});`,
    `import {output} from 'velaros';function f(){output(1,{key:'x'})}`,
    `import {output} from 'velaros';const options={key:'x'};output(1,options);`,
    `import {output} from 'velaros';output(1,{key:'x'});output(2,{key:'x'});`,
    `import {output} from 'velaros';output(1,{key:'x',view:{maxChars:limit()}});`,
  ])
    expect(() =>
      scriptOutputs.edit({ source }, { outputs: [{ key: 'x', view: { maxChars: 500 } }] })
    ).toThrow()
  expect(() =>
    scriptOutputs.edit({ source: `import {output} from 'velaros';output(1,{key:'x'})` }, {
      outputs: [{ key: 'x', view: { maxChars: 1 }, purpose: 'changed' }],
    } as any)
  ).toThrow('越权')
})

test('a result that does not fit says its display budget; one that fits does not', () => {
  const small = scriptOutputs.project(capture('short', { key: 'note' }), 'ref', 2000)
  expect(JSON.parse(small.prompt).displayChars).toBeUndefined()
  const long = scriptOutputs.project(capture('x'.repeat(5000), { key: 'code' }), 'ref', 2000)
  expect(JSON.parse(long.prompt).displayChars).toBe(2000)
})

test('configuration and per-block zero budget produce references or explicit omissions', () => {
  const raw = capture({ a: 1 }, { key: 'data', view: { maxChars: 0 } })
  expect(scriptOutputs.project(raw, 'ref', 2000).blocks[0]!.bodyIncluded).toBe(false)
  const none = scriptOutputs.project(raw, 'ref', 0)
  expect(none.prompt).toBe('')
  expect(none.omittedBlocks).toBe(1)
})

test('native image outputs use the attachment channel and file references carry bounded metadata', async () => {
  const data =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWAAAAABJRU5ErkJggg=='
  const result = await run(
    `output({type:'image-data',mediaType:'image/png',data:${JSON.stringify(data)},label:'pixel'},{key:'image',type:'image'});`
  )
  if (!result.checked) throw Error(JSON.stringify(result))
  expect(result.result.failed).toBeUndefined()
  expect(result.attachments?.[0]?.data).toBe(data)
  expect(result.outputAttachments).toEqual([{ key: 'image', index: 0 }])
  const file = scriptOutputs.project(
    capture(
      {
        ref: { sessionId: 's', id: 'file' },
        name: 'input.md',
        mediaType: 'text/markdown',
        bytes: 50,
      },
      { key: 'file', type: 'file' }
    ),
    'ref',
    2000
  )
  expect(file.blocks[0]?.selection).toEqual({
    ref: { sessionId: 's', id: 'file' },
    name: 'input.md',
    mediaType: 'text/markdown',
    bytes: 50,
  })
  expect(file.blocks[0]?.representation).toBe('reference')
})

test('a configuration-only edit does not evaluate calls and adding view supports trailing commas', () => {
  const source = `import {output} from 'velaros';output(doesNotRun(),{key:'v',});`
  const next = scriptOutputs.edit({ source }, { outputs: [{ key: 'v', view: { maxChars: 500 } }] })
  expect(next.source).toContain('doesNotRun()')
  expect(scriptOutputs.describe(next).outputs[0]?.view?.maxChars).toBe(500)
  expect(() =>
    scriptOutputs.edit(
      { source: `import {output} from 'velaros';output.configure(config());` },
      { config: { maxChars: 50 } }
    )
  ).toThrow('动态')
})

test('optional fields and sparse arrays preserve canonical JSON in the isolated output collector', async () => {
  const result = await run(`output({a:{present:1,missing:undefined},items:[1,undefined,,4]});`)
  if (!result.checked) throw Error(JSON.stringify(result))
  expect(result.result.failed).toBeUndefined()
  expect(result.output?.blocks[0]?.value).toEqual({ a: { present: 1 }, items: [1, null, null, 4] })
  const collector = createOutputCollector(ScriptOutputLimits, validateOutputOptions, () => {})
  collector.output(Array.from({ length: 3 }))
  expect(collector.snapshot().blocks[0]?.value).toEqual([null, null, null])
  expect(() => collector.output({ value: Infinity })).toThrow('/value')
})

test('INV-37 output 声明里写的上限与 ScriptOutputLimits 一致，校验恰好在这些边界上放行与拒绝', () => {
  const limits = ScriptOutputLimits
  for (const fragment of [
    `一次执行最多 ${limits.blocks} 块`,
    `原始 JSON 输出合计最多 ${limits.rawChars} 个字符`,
    'view 与 configure 只控制展示，不减少原始采集量',
    `最多 ${limits.keyChars} 个字符），整理工具凭它调整展示`,
    `purpose 说明持续观察它的原因（最多 ${limits.purposeChars} 个字符）`,
    `代码的语言标签，最多 ${limits.languageChars} 个字符`,
    `maxChars 包括输出目录与省略说明（最多 ${limits.maxDisplayChars}）`,
    `maxChars 本块最多展示多少字符（最多 ${limits.maxDisplayChars}）`,
    `JSON Pointer 数组（最多 ${limits.paths} 个）`,
  ])
    expect(VelarosStandardDeclarations).toContain(fragment)
  const boundary = (at: unknown, over: unknown, config = false) => {
    expect(() => validateOutputOptions(at, config)).not.toThrow()
    expect(() => validateOutputOptions(over, config)).toThrow()
  }
  boundary({ key: 'k'.repeat(limits.keyChars) }, { key: 'k'.repeat(limits.keyChars + 1) })
  boundary(
    { purpose: 'p'.repeat(limits.purposeChars) },
    { purpose: 'p'.repeat(limits.purposeChars + 1) }
  )
  boundary(
    { language: 'l'.repeat(limits.languageChars) },
    { language: 'l'.repeat(limits.languageChars + 1) }
  )
  boundary(
    { view: { paths: Array.from({ length: limits.paths }, () => '/a') } },
    { view: { paths: Array.from({ length: limits.paths + 1 }, () => '/a') } }
  )
  boundary(
    { view: { maxChars: limits.maxDisplayChars } },
    { view: { maxChars: limits.maxDisplayChars + 1 } }
  )
  boundary({ maxChars: limits.maxDisplayChars }, { maxChars: limits.maxDisplayChars + 1 }, true)
  const collector = createOutputCollector(limits, validateOutputOptions, () => {})
  for (let index = 0; index < limits.blocks; index++) collector.output(index)
  expect(() => collector.output(limits.blocks)).toThrow()
  const archive = createOutputCollector(limits, validateOutputOptions, () => {})
  expect(() =>
    archive.output('x'.repeat(limits.rawChars - 2), { view: { maxChars: 1 } })
  ).not.toThrow()
  expect(archive.snapshot().blocks[0]?.chars).toBe(limits.rawChars)
  expect(() => archive.output(0)).toThrow('输出采集上限')
  expect(archive.snapshot().blocks).toHaveLength(1)
  const oversized = createOutputCollector(limits, validateOutputOptions, () => {})
  expect(() =>
    oversized.output('x'.repeat(limits.rawChars - 1), { view: { mode: 'reference' } })
  ).toThrow('此块没有完整归档')
  expect(oversized.snapshot().blocks).toHaveLength(0)
})

test('INV-41 共享 const 条件分支与循环引用不会按路径展开或假定未知值', () => {
  const source = `import {output} from 'velaros';const v0=Math.random()>.5?{}:[];${Array.from({ length: 32 }, (_, i) => `const v${i + 1}=Math.random()>.5?v${i}:v${i};`).join('')}output(v32,{type:'text'});`
  const rejected = codeProgramChecker.check({
    source,
    granted: scriptPackageCompiler.compile([], []).granted,
  })
  expect(rejected.ok).toBe(false)
  if (!rejected.ok) expect(rejected.diagnostics[0]?.code).toBe(2345)
  expect(
    codeProgramChecker.check({
      source: `import {output} from 'velaros'; const a=b;const b=a;output(a,{type:'text'});`,
      granted: scriptPackageCompiler.compile([], []).granted,
    }).ok
  ).toBe(true)
})

test('INV-41 长 const 值链和导出别名链达到分析边界时保留运行时执行', () => {
  for (const [base, expression] of [
    ["'valid'", "output(v2400,{type:'text'});"],
    ['output', "v2400('valid',{type:'text'});"],
  ] as const) {
    const source = `import {output} from 'velaros';const v0=${base};${Array.from({ length: 2400 }, (_, i) => `const v${i + 1}=v${i};`).join('')}${expression}`
    expect(source.length).toBeLessThan(60000)
    expect(
      codeProgramChecker.check({ source, granted: scriptPackageCompiler.compile([], []).granted })
        .ok
    ).toBe(true)
  }
})

test('INV-41 输出预检只解析虚拟文件，不读取 reference 指向的宿主文件', () => {
  const directory = mkdtempSync(join(tmpdir(), 'script-output-proof-'))
  const path = join(directory, 'host-private.d.ts')
  writeFileSync(path, 'declare const syntheticPrivateMarker: string;\n')
  const reads = spyOn(ts.sys, 'readFile')
  const files = spyOn(ts.sys, 'fileExists')
  const directories = spyOn(ts.sys, 'directoryExists')
  try {
    const reference = `/// <reference path="${path}"/>\n`
    const granted = scriptPackageCompiler.compile([], []).granted
    expect(
      codeProgramChecker.check({
        source: `${reference}import {output} from 'velaros';output('ok',{type:'text'});`,
        granted,
      }).ok
    ).toBe(true)
    const invalid = codeProgramChecker.check({
      source: `import {emit} from './lib/display.js'; emit();`,
      granted,
      modules: {
        'lib/display.js': `${reference}import {output} from 'velaros';export function emit(){output({}, {type:'text'});}`,
      },
    })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok)
      expect(invalid.diagnostics[0]).toMatchObject({ file: 'lib/display.js', line: 2, code: 2345 })
    expect(reads.mock.calls).toHaveLength(0)
    expect(files.mock.calls).toHaveLength(0)
    expect(directories.mock.calls).toHaveLength(0)
  } finally {
    reads.mockRestore()
    files.mockRestore()
    directories.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('INV-35 单块显式 view 预算在宿主份额足够时申请完整正文与编码目录', () => {
  for (const [value, type] of [
    [{ body: 'synthetic\n'.repeat(2600) }, 'json'],
    ['🙂"\\\n'.repeat(4500), 'code'],
    [Array.from({ length: 700 }, (_, index) => ({ index, value: 'synthetic' })), 'list'],
  ] as const) {
    const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    const raw = capture(value, {
      key: 'required',
      type,
      required: true,
      view: { mode: 'full', maxChars: body.length },
    })
    for (const format of ['json', 'text'] as const) {
      const result = scriptOutputs.project(
        raw,
        'opaque-reference-🙂',
        200000,
        undefined,
        undefined,
        undefined,
        format
      )
      expect(result.blocks[0]?.representation).toBe('full')
      expect(result.blocks[0]?.text).toBe(body)
      expect(result.prompt.length).toBeLessThanOrEqual(result.allocatedChars)
      expect(result.allocatedChars).toBeLessThanOrEqual(200000)
    }
  }
})

test('INV-35 显式整体配置含零硬覆盖块申请，宿主更小份额仍生效', () => {
  for (const global of [0, 1000, 16000, 25000, 80000]) {
    const collector = createOutputCollector(ScriptOutputLimits, validateOutputOptions, () => {})
    collector.output.configure({ maxChars: global })
    collector.output('line\n'.repeat(5000), {
      key: 'body',
      required: true,
      view: { mode: 'full', maxChars: 50000 },
    })
    const raw = collector.snapshot()
    expect(scriptOutputs.requestBudget(raw, undefined, 'ref')).toEqual({
      maxChars: global,
      explicit: true,
    })
    for (const host of [0, 100, 12000, 200000]) {
      const result = scriptOutputs.project(raw, 'ref', host)
      expect(result.allocatedChars).toBe(Math.min(global, host))
      expect(result.prompt.length).toBeLessThanOrEqual(Math.min(global, host))
    }
  }
})

test('INV-35 无有效块申请保持默认，reference、summary、零上限不扩大申请', () => {
  for (const view of [
    undefined,
    { mode: 'full' },
    { maxChars: 0 },
    { mode: 'reference', maxChars: 200000 },
    { mode: 'summary', maxChars: 200000 },
  ] as const) {
    const raw = capture('line\n'.repeat(5000), { key: 'body', view })
    expect(scriptOutputs.requestBudget(raw)).toEqual({
      maxChars: ScriptOutputLimits.displayChars,
      explicit: false,
    })
    expect(scriptOutputs.project(raw, 'ref', 200000).allocatedChars).toBe(
      ScriptOutputLimits.displayChars
    )
  }
})

test('INV-35 多块申请计目录和转义，较小宿主份额保留真实引用与UTF-16上限', () => {
  const collector = createOutputCollector(ScriptOutputLimits, validateOutputOptions, () => {})
  const values = [
    '🙂"\\\n'.repeat(3200),
    'normal\r\n'.repeat(1700),
    'unicode e\u0301\n'.repeat(700),
  ]
  for (const [index, value] of values.entries())
    collector.output(value, {
      key: `required-${index}`,
      required: true,
      purpose: '合成预算验证',
      type: 'code',
      view: { mode: 'full', maxChars: value.length },
    })
  collector.output({ ok: true }, { key: 'ordinary' })
  const raw = collector.snapshot()
  const before = JSON.stringify(raw)
  const ref = 'opaque-long-reference-🙂'.repeat(30)
  for (const host of [0, 10, 512, 4096, 16000, 24000, 100000, 200000])
    for (const format of ['json', 'text'] as const) {
      const result = scriptOutputs.project(raw, ref, host, undefined, undefined, undefined, format)
      expect(result.prompt.length).toBeLessThanOrEqual(host)
      expect(result.prompt.length).toBeLessThanOrEqual(result.allocatedChars)
      expect(result.allocatedChars).toBeLessThanOrEqual(ScriptOutputLimits.maxDisplayChars)
      for (const block of result.blocks) {
        expect(block.rawRef).toBe(ref)
        if (block.representation === 'full' && block.key.startsWith('required-'))
          expect(block.text).toBe(values[Number(block.key.split('-')[1])])
        if (host < 16000 && block.key === 'required-0')
          expect(block.representation).toBe('reference')
      }
      if (host >= 100000)
        expect(result.blocks.every((block) => block.representation === 'full')).toBe(true)
    }
  expect(JSON.stringify(raw)).toBe(before)
})

test('INV-35 manifest 有效 view 与整体配置使用同一申请优先级', () => {
  const raw = capture('line\n'.repeat(5000), {
    key: 'body',
    required: true,
    view: { mode: 'full', maxChars: 8000 },
  })
  const enlarged = {
    config: {},
    outputs: [{ key: 'body', view: { mode: 'full' as const, maxChars: 30000 } }],
  }
  expect(scriptOutputs.project(raw, 'ref', 100000, enlarged).blocks[0]?.representation).toBe('full')
  const hidden = {
    config: {},
    outputs: [{ key: 'body', view: { mode: 'reference' as const, maxChars: 200000 } }],
  }
  expect(scriptOutputs.requestBudget(raw, hidden).explicit).toBe(false)
  for (const maxChars of [0, 5000]) {
    const manifest = { ...enlarged, config: { maxChars } }
    expect(scriptOutputs.requestBudget(raw, manifest)).toEqual({ maxChars, explicit: true })
    expect(scriptOutputs.project(raw, 'ref', 100000, manifest).allocatedChars).toBe(maxChars)
  }
  expect(
    scriptOutputs.requestBudget({ ...raw, config: { maxChars: 1000 } }, enlarged).maxChars
  ).toBe(1000)
})

test('INV-35 接近采集上限的64块申请仍受展示总上限约束', () => {
  const collector = createOutputCollector(ScriptOutputLimits, validateOutputOptions, () => {})
  for (let i = 0; i < 64; i++)
    collector.output('x'.repeat(14000), {
      key: `block-${i}`,
      view: { mode: 'full', maxChars: 20000 },
    })
  const raw = collector.snapshot()
  expect(raw.blocks.reduce((n, b) => n + b.chars, 0)).toBeLessThanOrEqual(
    ScriptOutputLimits.rawChars
  )
  expect(scriptOutputs.requestBudget(raw).maxChars).toBe(ScriptOutputLimits.maxDisplayChars)
  const result = scriptOutputs.project(raw, 'ref', 1000000)
  expect(result.allocatedChars).toBe(ScriptOutputLimits.maxDisplayChars)
  expect(result.prompt.length).toBeLessThanOrEqual(ScriptOutputLimits.maxDisplayChars)
})

test('INV-35 合法 undefined 字段不构成显式整体或块预算', () => {
  const raw = capture('line\n'.repeat(5000), {
    key: 'body',
    view: { mode: 'full', maxChars: undefined },
  })
  for (const [captureValue, manifest] of [
    [raw, undefined],
    [{ ...raw, config: { maxChars: undefined } }, undefined],
    [raw, { config: { maxChars: undefined }, outputs: [] }],
  ] as const) {
    expect(scriptOutputs.requestBudget(captureValue, manifest)).toEqual({
      maxChars: ScriptOutputLimits.displayChars,
      explicit: false,
    })
    expect(scriptOutputs.project(captureValue, 'ref', 200000, manifest).allocatedChars).toBe(
      ScriptOutputLimits.displayChars
    )
  }
})

test('INV-35 host full-value text encoding stays bounded and preserves original identity', () => {
  for (const text of ['plain'.repeat(700), '"\\\n'.repeat(1600), '界😀\r\n'.repeat(900)]) {
    const value = { metadata: { source: 'synthetic' }, text }
    const raw = capture(value, { key: 'page', view: { mode: 'full', maxChars: 6000 } })
    const original = JSON.stringify(raw)
    const display = [
      {
        key: 'page',
        contentHash: scriptOutputs.hash(value),
        text: `{"textChars":${text.length}}\n${text}`,
      },
    ]
    const projected = scriptOutputs.project(
      raw,
      'r',
      12000,
      undefined,
      undefined,
      undefined,
      'text',
      display
    )
    expect(projected.blocks[0]!.representation).toBe('full')
    expect(projected.blocks[0]!.text).toBe(display[0]!.text)
    expect(projected.blocks[0]!.contentHash).toBe(scriptOutputs.hash(value))
    expect(projected.prompt.length).toBeLessThanOrEqual(projected.allocatedChars)
    expect(JSON.stringify(raw)).toBe(original)
    expect(scriptOutputs.project(raw, 'r', 12000).prompt).toBe(
      scriptOutputs.project(raw, 'r', 12000, undefined, undefined, undefined, 'json', display)
        .prompt
    )
  }
})

test('INV-35 host encoding cannot override selected views, mismatched identities or hard budgets', () => {
  const value = { text: '"\\\n'.repeat(1000), status: 'ok' }
  const display = [
    { key: 'page', contentHash: scriptOutputs.hash(value), text: `VERBATIM\n${value.text}` },
  ]
  for (const view of [
    { mode: 'reference' },
    { mode: 'summary' },
    { paths: ['/status'] },
    { lines: [1, 2] },
    { maxItems: 1 },
    { edge: 'tail' },
  ]) {
    const raw = capture(value, { key: 'page', view })
    const result = scriptOutputs.project(
      raw,
      'r',
      20000,
      undefined,
      undefined,
      undefined,
      'text',
      display
    )
    expect(result.blocks[0]!.text).not.toBe(display[0]!.text)
  }
  const raw = capture(value, {
    key: 'page',
    required: true,
    view: { mode: 'full', maxChars: 4000 },
  })
  for (const overrides of [
    [{ ...display[0]!, key: 'other' }],
    [{ ...display[0]!, contentHash: 'wrong' }],
  ]) {
    const result = scriptOutputs.project(
      raw,
      'r',
      20000,
      undefined,
      undefined,
      undefined,
      'text',
      overrides
    )
    expect(result.blocks[0]!.representation).toBe('reference')
  }
  for (const maxChars of [0, 1000]) {
    const result = scriptOutputs.project(
      { ...raw, config: { maxChars } },
      'r',
      20000,
      undefined,
      undefined,
      undefined,
      'text',
      display
    )
    expect(result.prompt.length).toBeLessThanOrEqual(maxChars)
    expect(result.blocks.every((b) => b.representation !== 'full')).toBe(true)
  }
})

test('INV-35 removing delivered bodies preserves unmatched content, issues and encoding limits', () => {
  const collector = createOutputCollector(ScriptOutputLimits, validateOutputOptions, () => {})
  collector.output('FIRST_BODY'.repeat(200), { key: 'first', view: { mode: 'full' } })
  collector.output('SECOND_BODY'.repeat(100), { key: 'second', view: { mode: 'full' } })
  const raw = { ...collector.snapshot(), issues: ['OBSERVATION_FAILURE'] }
  for (const format of ['json', 'text'] as const) {
    const before = scriptOutputs.project(raw, 'r', 16000, undefined, undefined, undefined, format)
    expect(scriptOutputs.withoutBodies(before, [{ key: 'first', contentHash: 'wrong' }])).toBe(
      before
    )
    const after = scriptOutputs.withoutBodies(before, [
      { key: 'first', contentHash: scriptOutputs.hash('FIRST_BODY'.repeat(200)) },
    ])
    expect(after.blocks[0]!.representation).toBe('reference')
    expect(after.blocks[0]!.reason).toBe('body-in-history')
    expect(after.blocks[1]).toBe(before.blocks[1])
    expect(after.issues).toEqual(['OBSERVATION_FAILURE'])
    expect(after.prompt.length).toBeLessThan(before.prompt.length)
    expect(after.prompt.length).toBeLessThanOrEqual(after.allocatedChars)
  }
})
