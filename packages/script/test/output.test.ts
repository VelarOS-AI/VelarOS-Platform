import { expect, test } from 'bun:test'

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

test('invalid display declarations identify expected and actual types in host and isolated execution', async () => {
  for (const [value, type, expected] of [
    [['source'], 'code', '要求字符串，实际为数组'],
    [{ value: 1 }, 'text', '要求字符串，实际为object'],
    ['source', 'list', '要求数组，实际为string'],
  ] as const) {
    expect(() => capture(value, { type })).toThrow(expected)
    const result = await run(`output(${JSON.stringify(value)},{type:${JSON.stringify(type)}})`)
    if (!result.checked) throw Error(JSON.stringify(result))
    expect(result.result.failed?.message).toContain(expected)
    expect(result.output?.blocks).toHaveLength(0)
  }
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
  expect(block.selection).toEqual({ from: 95, shown: 5, total: 100 })
  expect(block.representation).toBe('excerpt')
  expect(result.prompt.length).toBeLessThanOrEqual(1800)
  expect((raw.blocks[0]!.value as unknown[]).length).toBe(100)
})

test('code selects lines and long indivisible lines become references, never broken text', () => {
  const raw = capture('one\ntwo\nthree\nfour', {
    key: 'code',
    type: 'code',
    view: { lines: [2, 3] },
  })
  const block = scriptOutputs.project(raw, 'ref', 2000).blocks[0]!
  expect(block.text).toBe('two\nthree')
  expect(block.selection).toEqual({ lines: [2, 3], totalLines: 4, missing: false })
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
  expect(block.selection).toEqual({ paths: ['/user/id', '/a~1b', '/absent'], missing: ['/absent'] })
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
    `最多 ${limits.keyChars} 个字符），整理工具凭它调整展示`,
    `purpose 说明持续观察它的原因（最多 ${limits.purposeChars} 个字符）`,
    `代码的语言标签，最多 ${limits.languageChars} 个字符`,
    `缺省 ${limits.displayChars} 个字符，包括输出目录与省略说明`,
    `output.configure({maxChars}) 放大（最多 ${limits.maxDisplayChars}，`,
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
})
