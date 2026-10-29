import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NativeTurnDecoder } from '../../../dist/act/runtime/impl/NativeTurnDecoder.js'
import { ScriptTurnDecoder } from '../../../dist/act/runtime/impl/ScriptTurnDecoder.js'
import { nativeProtocolRules } from '../../../dist/act/runtime/utils/native-protocol.js'
import { protocolConfig } from '../../../dist/act/runtime/utils/script-protocol.js'

const marker = '@@sParity'
const encode = (records) =>
  records
    .map(({ kind, code = '', options = {}, name, text, completion, message = '' }) =>
      kind === 'done'
        ? `${marker} done(${completion === undefined ? '' : JSON.stringify(completion)})\n${message}`
        : `${marker} ${kind}(${JSON.stringify(kind === 'blobs' ? name : options)})\n${kind === 'blobs' ? text : code}\n${marker}\n`
    )
    .join('')
const decode = (mode, records, config = {}, inputs = {}) => {
  const decoder =
    mode === 'text'
      ? new ScriptTurnDecoder(marker, config, inputs, () => true)
      : new NativeTurnDecoder(config, inputs)
  if (mode === 'text') {
    const wire = encode(records)
    // 刻意切开 Unicode、反斜线与控制头，验证真实增量边界。
    for (let at = 0; at < wire.length; at += 3) decoder.push(wire.slice(at, at + 3))
  } else
    for (const [
      index,
      { kind, code = '', options = {}, name, text, completion, message },
    ] of records.entries()) {
      const input =
        kind === 'blobs'
          ? { name, text }
          : kind === 'done'
            ? {
                ...(completion === undefined ? {} : { completion }),
                ...(message === undefined ? {} : { message }),
              }
            : { code, options }
      decoder.acceptTool({
        id: `call-${index}`,
        name: kind === 'execute' ? 'exec' : kind,
        input: JSON.parse(JSON.stringify(input)),
      })
    }
  const result = decoder.finish()
  return {
    message: result.message,
    done: result.done,
    completion: result.completion,
    submission: result.submission ?? { observe: undefined, executions: [] },
  }
}
const raw = '中文 👋\r\n`template ${x}` "double" \'single\' \\path\\x\n\\n\n'

for (const mode of ['tools', 'text']) {
  for (const idle of [true, false]) {
    test(`${mode}: ordinary text survives without a control and ${idle ? 'requests validation' : 'waits for background work'}`, () => {
      const decoder =
        mode === 'tools'
          ? new NativeTurnDecoder({}, {}, () => idle)
          : new ScriptTurnDecoder(marker, {}, {}, () => idle)
      const text = '[报告](file:///tmp/report.xlsx)\n这是普通回复。'
      decoder.push(text)
      const result = decoder.finish()
      assert.equal(result.message, text)
      assert.equal(result.done, idle)
      assert.equal(result.completion, undefined)
      assert.equal(result.submission, undefined)
    })
  }
  test(`${mode}: an empty idle response is still invalid`, () => {
    const decoder =
      mode === 'tools' ? new NativeTurnDecoder() : new ScriptTurnDecoder(marker, {}, {}, () => true)
    decoder.push('  ')
    assert.throws(() => decoder.finish(), { code: 'SCRIPT_PROTOCOL' })
  })
}

test('native text does not legitimize an orphan blob call', () => {
  const decoder = new NativeTurnDecoder()
  decoder.push('Here is the output')
  decoder.acceptTool({ id: 'orphan', name: 'blobs', input: { name: 'content', text: 'data' } })
  assert.throws(() => decoder.finish(), { code: 'SCRIPT_PROTOCOL' })
})
const source = `import {input,blobs} from 'velaros:program'; console.log(input,blobs);\n// ${raw}`
const valid = [
  [
    {
      kind: 'execute',
      code: '',
      options: { control: { kind: 'read', executionId: 'known-job', cursor: 0, limit: 1000 } },
    },
  ],
  [{ kind: 'execute', code: '', options: { control: { kind: 'stop', executionId: 'known-job' } } }],
  [{ kind: 'execute', code: source, options: { async: true, timeoutMs: 4800000 } }],
  [{ kind: 'execute', code: '', options: { sourceRef: 'saved', timeoutMs: 5000 } }],
  [
    {
      kind: 'execute',
      code: JSON.stringify({ source }),
      options: { format: 'program', timeoutMs: 4800000 },
    },
  ],
  [{ kind: 'execute', code: source }],
  [
    { kind: 'blobs', name: 'literal', text: raw },
    { kind: 'observe', code: source, options: { inputRef: 'host:data', refresh: true } },
    {
      kind: 'execute',
      code: source,
      options: {
        async: true,
        retain: 'task',
        input: { key: raw },
        modules: { './nested.js': 'export default 4' },
      },
    },
  ],
  [
    { kind: 'observe', options: { clear: true } },
    {
      kind: 'execute',
      options: {
        sourceRef: 'saved',
        edits: [{ oldText: 'a', newText: 'b', module: './nested.js' }],
        retain: 2,
      },
    },
  ],
  [{ kind: 'observe', options: { edits: [{ oldText: 'a', newText: 'b' }] } }],
  [
    {
      kind: 'observe',
      options: {
        snapshot: { provider: 'domain', plan: 'current', input: { tag: raw } },
        refresh: true,
      },
    },
  ],
  [
    {
      kind: 'execute',
      options: { format: 'program', retain: 3 },
      code: JSON.stringify({ source, input: [1, true, null, raw] }),
    },
  ],
  [{ kind: 'done', completion: '检查通过', message: '完成\n验证结果' }],
  [
    { kind: 'execute', code: source },
    { kind: 'done', message: 'Done' },
  ],
]

test('execution timeout uses the same bounded scheduling contract in both transports', () => {
  for (const mode of ['tools', 'text']) {
    const result = decode(mode, [
      { kind: 'execute', code: source, options: { timeoutMs: 4800000 } },
    ])
    assert.equal(result.submission.executions[0].program.timeoutMs, 4800000)
    for (const timeoutMs of [0, -1, 1.5, 86400001, '5000', true, null])
      assert.throws(() => decode(mode, [{ kind: 'execute', code: source, options: { timeoutMs } }]))
    assert.throws(() =>
      decode(mode, [{ kind: 'observe', code: source, options: { timeoutMs: 5000 } }])
    )
    assert.throws(() =>
      decode(mode, [
        {
          kind: 'execute',
          code: JSON.stringify({ source, timeoutMs: 5000 }),
          options: { format: 'program' },
        },
      ])
    )
  }
})
for (const [index, records] of valid.entries())
  test(`both transports bind identical programs and completion (${index})`, () => {
    assert.deepEqual(
      decode('tools', records, {}, { data: { value: raw } }),
      decode('text', records, {}, { data: { value: raw } })
    )
  })
const invalid = [
  [{ kind: 'execute', code: 'console.log(1)', options: { inputRef: 'host:missing' } }],
  [{ kind: 'execute', code: source, options: { sourceRef: 'saved' } }],
  [{ kind: 'execute', code: source, options: { retain: 0 } }],
  [{ kind: 'execute', code: source, options: { async: 'yes' } }],
  [{ kind: 'observe', code: source, options: { async: false } }],
  [{ kind: 'observe', code: source, options: { clear: true } }],
  [
    { kind: 'observe', code: source },
    { kind: 'observe', code: source },
  ],
  [
    { kind: 'blobs', name: 'same', text: raw },
    { kind: 'blobs', name: 'same', text: 'other' },
    { kind: 'execute', code: source },
  ],
  [
    { kind: 'blobs', name: 'same', text: raw },
    { kind: 'execute', code: source, options: { blobs: { same: 'other' } } },
  ],
  [{ kind: 'done', completion: '' }],
  [{ kind: 'done' }, { kind: 'execute', code: source }],
  [{ kind: 'execute', code: source, options: { input: {}, inputRef: 'host:data' } }],
]
for (const [index, records] of invalid.entries())
  test(`both transports reject the whole invalid response (${index})`, () => {
    for (const mode of ['tools', 'text'])
      assert.throws(() => decode(mode, records, {}, { data: {} }), { code: 'SCRIPT_PROTOCOL' })
  })
test('transport selection validates explicit values and allowed controls are enforced', () => {
  assert.equal(protocolConfig({ transport: 'text' }).transport, 'text')
  assert.equal(protocolConfig({ transport: 'tools' }).transport, 'tools')
  assert.throws(() => protocolConfig({ transport: 'guess' }), { code: 'SCRIPT_PROTOCOL' })
  for (const mode of ['tools', 'text'])
    assert.throws(
      () => decode(mode, [{ kind: 'observe', code: source }], { allowed: ['execute', 'done'] }),
      { code: 'SCRIPT_PROTOCOL' }
    )
  const decoder = new NativeTurnDecoder({ allowed: ['observe', 'done'] })
  assert.deepEqual(
    decoder.response.tools.map(({ name }) => name),
    ['observe', 'done']
  )
})
test('plain replies enter completion validation, tool identities stay unique, and reset drops rejected work', () => {
  const decoder = new NativeTurnDecoder()
  decoder.push('Only progress')
  assert.deepEqual(decoder.finish(), {
    message: 'Only progress',
    done: true,
    completion: undefined,
    submission: undefined,
    events: [],
  })
  decoder.reset()
  decoder.acceptTool({ id: 'one', name: 'exec', input: { code: source } })
  assert.throws(() => decoder.acceptTool({ id: 'one', name: 'exec', input: { code: source } }), {
    code: 'SCRIPT_PROTOCOL',
  })
  decoder.reset()
  decoder.acceptTool({
    id: 'final',
    name: 'done',
    input: { message: 'Verified', completion: 'tests passed' },
  })
  assert.equal(decoder.finish().message, 'Verified')
})

test('INV-88 real Node sessions observe, execute, pair mixed receipts and switch transports', async (t) => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createRuntime, createNodeExecutionEnvironment } =
    await import('../../../dist/act/runtime/index.js')
  const { createLocalShellHost } = await import('../../../dist/execution/local.js')
  const { modelText } = await import('./support/model-turn.mjs')
  const root = await mkdtemp(join(tmpdir(), 'protocol-parity-'))
  const cwd = join(root, 'work')
  await mkdir(cwd)
  const host = createLocalShellHost({ cwd })
  t.after(async () => {
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const node = createNodeExecutionEnvironment({ cwd, directory: join(root, 'runs'), host })
  for (const transport of ['text', 'tools', 'text']) {
    await writeFile(join(cwd, 'state.txt'), 'before-change')
    let round = 0
    const model = {
      id: 'parity',
      nativeTools: true,
      limits: { contextTokens: 128000, inputTokens: 100000, outputTokens: 4000 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
      async *stream(request) {
        assert.equal(request.response.type, transport === 'text' ? 'text' : 'tools')
        round++
        let records
        if (round === 1)
          records = [
            {
              kind: 'observe',
              code: "import {readFile} from 'node:fs/promises'; console.log('observed:'+await readFile('state.txt','utf8'))",
            },
          ]
        else if (round === 2) {
          assert.match(modelText(request), /observed:before-change/)
          records = [
            { kind: 'blobs', name: 'next', text: 'after-change' },
            {
              kind: 'execute',
              code: "import {writeFile} from 'node:fs/promises'; import {blobs} from 'velaros:program'; await writeFile('state.txt',blobs.next); console.log('updated')",
            },
          ]
        } else {
          assert.equal(round, 3)
          assert.match(modelText(request), /observed:after-change/)
          if (transport === 'tools') {
            const exchange = request.history.findLast((item) =>
              item.toolExchange?.calls.some((call) => call.name === 'exec')
            ).toolExchange
            assert.equal(exchange.results[0].name, 'blobs')
            assert.equal(exchange.results[1].name, 'exec')
            assert(exchange.results[1].output.resultRef)
          }
          records = [{ kind: 'done', message: 'Verified' }]
        }
        if (transport === 'text') {
          const frame = request.compiledPrompt.match(/当前帧标记：(@@\w+)。/)[1]
          yield { type: 'text', text: encode(records).replaceAll(marker, frame) }
        } else
          for (const [index, record] of records.entries()) {
            const { kind, code = '', options = {}, name, text, message } = record
            yield {
              type: 'tool-call',
              value: {
                id: `${round}-${index}`,
                name: kind === 'execute' ? 'exec' : kind,
                input:
                  kind === 'blobs'
                    ? { name, text }
                    : kind === 'done'
                      ? { message }
                      : { code, options },
              },
            }
          }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const runtime = await createRuntime({
      workspace: cwd,
      dataDir: join(root, 'state'),
      node,
      model,
      protocol: { transport },
      project: false,
      memory: false,
      search: false,
      agents: false,
      context: { maintenance: false },
    })
    try {
      const session = await runtime.openSession('same-session')
      const events = []
      for await (const event of session.submit('Track state and change it')) events.push(event)
      assert.equal(
        events.filter((event) => event.type === 'error').length,
        0,
        JSON.stringify(events)
      )
      assert.equal(events.at(-1).status, 'completed')
      assert.equal(await readFile(join(cwd, 'state.txt'), 'utf8'), 'after-change')
    } finally {
      await runtime.close()
    }
  }
})

test('explicit tools rejects unsupported drivers and omitted transport falls back to text', async (t) => {
  const { localContextStorage } = await import('@velaros-ai/context/node')
  const { nodeSubprocessCodeRunner } = await import('@velaros-ai/script')
  const { createRuntime } = await import('../../../dist/act/runtime/index.js')
  for (const transport of [undefined, 'tools']) {
    const runtime = await createRuntime({
      storage: localContextStorage({ path: ':memory:' }),
      runner: nodeSubprocessCodeRunner,
      project: false,
      memory: false,
      search: false,
      agents: false,
      context: { maintenance: false },
      ...(transport ? { protocol: { transport } } : {}),
      model: {
        id: 'text-only',
        nativeTools: false,
        limits: { contextTokens: 128000, inputTokens: 100000, outputTokens: 4000 },
        estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
        async *stream(request) {
          assert.equal(request.response.type, 'text')
          const tag = request.compiledPrompt.match(/当前帧标记：(@@\w+)。/)[1]
          yield { type: 'text', text: `${tag} done()\nVerified` }
          yield { type: 'finish', reason: 'stop' }
        },
      },
    })
    t.after(() => runtime.close())
    if (transport) await assert.rejects(runtime.openSession('s'), { code: 'UNAVAILABLE' })
    else {
      const session = await runtime.openSession('s')
      const events = await Array.fromAsync(session.submit('Answer'))
      assert.equal(events.at(-1).status, 'completed')
    }
  }
})

test('native observation and execution expose only their own options', () => {
  const decoder = new NativeTurnDecoder()
  const options = (name) => {
    const schema = decoder.response.tools.find((tool) => tool.name === name).schema
    return schema.definitions[schema.properties.options.$ref.split('/').at(-1)].properties
  }
  const observation = options('observe')
  const execution = options('exec')
  assert.equal(observation.async, undefined)
  assert.equal(observation.retain, undefined)
  assert.equal(observation.clear.const, true)
  assert(observation.snapshot && observation.refresh)
  assert(execution.async && execution.retain)
  for (const key of ['snapshot', 'refresh', 'clear']) assert.equal(execution[key], undefined)
})

test('native raw-text guidance produces self-contained executable calls for scoped names', () => {
  for (const kind of ['execute', 'observe']) {
    const options = { allowed: [kind], names: { [kind]: 'work' } }
    const rules = nativeProtocolRules(options)
    const example = JSON.parse(rules.match(/原文示例：(\{[^\n]+\})。/u)[1])
    example.options.blobs.content = raw
    const decoder = new NativeTurnDecoder(options)
    decoder.acceptTool({ id: 'raw-text', name: 'work', input: example })
    const submission = decoder.finish().submission
    const program = kind === 'execute' ? submission.executions[0].program : submission.observe
    assert.equal(program.blobs.content, raw)
    assert.match(program.source, /import \{blobs\} from "velaros:program"/)
  }
})

test('a standalone blob rejection tells the model how to resubmit the full input', () => {
  const decoder = new NativeTurnDecoder({ names: { execute: 'run', blobs: 'literal' } })
  decoder.acceptTool({ id: 'raw', name: 'literal', input: { name: 'content', text: raw } })
  assert.throws(
    () => decoder.finish(),
    (error) => {
      assert.equal(error.code, 'SCRIPT_PROTOCOL')
      assert.match(error.message, /options\.blobs/)
      assert.match(error.message, /同一响应/)
      assert.match(error.message, /run/)
      return true
    }
  )
  decoder.reset()
  decoder.acceptTool({
    id: 'fixed',
    name: 'run',
    input: { code: source, options: { blobs: { content: raw } } },
  })
  assert.equal(decoder.finish().submission.executions[0].program.blobs.content, raw)
})

test('native observation examples are valid calls and respect scoped tool names', () => {
  const options = { allowed: ['observe', 'done'], names: { observe: 'watch', done: 'finish' } }
  const rules = nativeProtocolRules(options)
  assert.doesNotMatch(rules, /控制头|空段|闭合|@@|options\.async|options\.retain|blobs 用|\bexec\b/)
  assert.match(rules, /options\.blobs/)
  assert.match(rules, /watch.*整体替换当前观察/)
  const examples = [...rules.matchAll(/参数[：:]\s*(\{[^\n]+\})[；。]/gu)].map((match) =>
    JSON.parse(match[1])
  )
  assert.equal(examples.length, 3)
  for (const [index, input] of examples.entries()) {
    const decoder = new NativeTurnDecoder(options)
    decoder.acceptTool({ id: `example-${index}`, name: 'watch', input })
    const result = decoder.finish()
    assert.notEqual(result.submission.observe, undefined)
    if (input.options.clear) assert.equal(result.submission.observe, null)
    else if (input.options.edits)
      assert.deepEqual(result.submission.observe.edits, input.options.edits)
    else assert.equal(result.submission.observe.refresh, true)
  }
  const invalid = new NativeTurnDecoder(options)
  invalid.acceptTool({
    id: 'invalid-clear',
    name: 'watch',
    input: { code: 'console.log(1)', options: { clear: true } },
  })
  assert.throws(
    () => invalid.finish(),
    (error) => {
      assert.equal(error.code, 'SCRIPT_PROTOCOL')
      assert.match(error.message, /clear:true.*空源码/)
      assert.doesNotMatch(error.message, /控制头|空段|闭合|@@/)
      return true
    }
  )
})

test('actual requests carry only their selected transport syntax with scoped names', async (t) => {
  const { mkdir, mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createRuntime } = await import('../../../dist/act/runtime/index.js')
  const root = await mkdtemp(join(tmpdir(), 'protocol-prompts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const instructions = new Map()
  for (const transport of ['tools', 'text']) {
    const runtime = await createRuntime({
      workspace,
      dataDir: join(root, transport),
      project: false,
      agents: false,
      search: false,
      memory: false,
      context: { maintenance: false },
      protocol: {
        transport,
        names: { execute: 'run', observe: 'watch', blobs: 'literal', done: 'finish' },
      },
      model: {
        id: 'protocol-instruction-fixture',
        nativeTools: true,
        limits: { contextTokens: 128000, inputTokens: 100000, outputTokens: 4000 },
        estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
        async *stream(request) {
          instructions.set(transport, request.instructions)
          assert.match(request.instructions, /完整响应全部校验后才执行/)
          if (transport === 'tools') {
            assert.equal(request.response.type, 'tools')
            const tool = request.response.tools.find((item) => item.name === 'watch')
            assert.match(tool.description, /整体替换.*只读观察/)
            assert.match(
              request.instructions,
              /watch 退订参数：\{"code":"","options":\{"clear":true\}\}/
            )
            assert.match(request.instructions, /options\.sourceRef/)
            assert.match(request.instructions, /literal 用 name\/text/)
            assert.doesNotMatch(
              request.instructions + request.compiledPrompt,
              /控制头|源码段|空段|闭合标记|当前帧标记|@@s/
            )
            yield {
              type: 'tool-call',
              value: { id: 'done', name: 'finish', input: { message: 'Checked' } },
            }
          } else {
            assert.equal(request.response.type, 'text')
            assert.match(request.instructions, /空段 watch\(\{clear:true\}\) 退订/)
            assert.match(request.instructions, /literal\("名称"\) 段保留原文/)
            assert.match(request.instructions, /blobs\["名称"\] 读原文/)
            assert.doesNotMatch(
              request.instructions,
              /JSON Schema|工具 Schema|options\.sourceRef|"code":""/
            )
            const tag = request.compiledPrompt.match(/当前帧标记：(@@\w+)。/)[1]
            assert(request.compiledPrompt.includes(`${tag} run()`))
            yield { type: 'text', text: `${tag} finish()\nChecked` }
          }
          yield { type: 'finish', reason: 'stop' }
        },
      },
    })
    try {
      const session = await runtime.openSession('s')
      const events = await Array.fromAsync(session.submit('Explain the supported protocol.'))
      assert.equal(events.at(-1).status, 'completed')
      assert.equal(events.filter((event) => event.type === 'error').length, 0)
    } finally {
      await runtime.close()
    }
  }
  assert.notEqual(instructions.get('tools'), instructions.get('text'))
})

for (const mode of ['tools', 'text']) {
  test(`${mode} execution control cannot carry arbitrary source or an unsupported operation`, () => {
    for (const record of [
      {
        kind: 'execute',
        code: 'console.log("injected")',
        options: { control: { kind: 'read', executionId: 'job' } },
      },
      { kind: 'execute', code: '', options: { control: { kind: 'eval', executionId: 'job' } } },
      {
        kind: 'execute',
        code: '',
        options: {
          control: { kind: 'read', executionId: 'job' },
          modules: { './extra.js': 'console.log("injected")' },
        },
      },
      {
        kind: 'execute',
        code: '',
        options: { control: { kind: 'stop', executionId: 'job' }, async: true },
      },
      { kind: 'observe', code: '', options: { control: { kind: 'read', executionId: 'job' } } },
    ])
      assert.throws(() => decode(mode, [record]))
  })
}
