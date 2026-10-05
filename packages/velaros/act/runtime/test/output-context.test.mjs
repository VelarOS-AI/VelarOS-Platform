import assert from 'node:assert/strict'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { modelRequestEncoder } from '@velaros-ai/kernel'
import { nodeSubprocessCodeRunner, scriptOutputs } from '@velaros-ai/script'

import { ContextMemory } from '../../../dist/act/runtime/impl/ContextMemory.js'
import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'
import {
  executionMaterial,
  projectMaterial,
  readMaterialField,
} from '../../../dist/act/runtime/utils/materials.js'
import { ContextMaintenanceState } from '../../../dist/act/system/impl/ContextMaintenanceState.js'

import { baseText, done, historyEntries, marker, turn } from './support/model-turn.mjs'

const signal = new AbortController().signal
async function fixture(t, source, modelOverride, options = {}) {
  const storage = localContextStorage({ path: ':memory:' })
  const requests = []
  let reads = 0
  let value = 1
  const model = modelOverride ?? {
    id: 'output-context',
    limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4000 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
    async *stream(request) {
      requests.push(request)
      yield* done(request)
    },
  }
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    model,
    modules: [
      {
        binding: {
          moduleId: 'test:world',
          instanceId: 'world',
          generation: 1,
          schemaRevision: '1',
        },
        summary: 'counter',
        operations: {
          read: {
            summary: 'read current value',
            input: { type: 'null' },
            output: { type: 'integer' },
            effects: 'none',
            run: () => {
              reads++
              return value
            },
          },
        },
      },
    ],
    ...options,
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('root')
  await session.context.append({ kind: 'user', body: 'Observe current state' })
  const initial = await session.observe({ source })
  const programs = new ProgramContext('root', session.context, storage)
  const maintenance = new ContextMaintenanceState('root', storage)
  async function run() {
    const events = []
    for await (const e of session.submit('Continue observing')) events.push(e)
    assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  }
  async function project(ref) {
    const view = (await session.view.inspect()).view
    return JSON.parse(
      (await programs.project(view, { sessionId: 'root', id: ref }, [], signal, 16000)).body
    )
  }
  const memory = new ContextMemory(
    'root',
    session.context,
    storage,
    session.view,
    programs,
    new RecentContext('root', session.context, storage)
  )
  return {
    note: () =>
      memory.update({ key: 'primary', baseRevision: 0, body: 'Primary original' }, signal),
    storage,
    session,
    programs,
    memory,
    maintenance,
    initial,
    requests,
    run,
    project,
    async display(ref, maxChars) {
      const record = await programs.read(ref, 0, 1)
      const archived = JSON.parse(await storage.get('root', record.record.objectId))
      return scriptOutputs.project(
        archived.output,
        ref,
        maxChars,
        undefined,
        undefined,
        undefined,
        'text'
      )
    },
    get reads() {
      return reads
    },
    set value(v) {
      value = v
    },
  }
}
const source = `import {output} from 'velaros';import {read} from 'test:world';
output.configure({maxChars:14000});
const state=await read();
output({state},{key:'state',purpose:'watch current state',priority:'high',view:{maxChars:2000}});
output(Array.from({length:40},(_,i)=>({i,text:'e'.repeat(100)})),{key:'logs',type:'list',view:{maxItems:20,edge:'tail',maxChars:6000}});`
const patch = (snapshot, observation) => ({
  baseRevision: snapshot.baseRevision,
  summary: 'Reduce logs while preserving current state',
  unresolved: [],
  observation,
})

test('INV-58 uncapped full demand delivers the whole required body in the next model request', async (t) => {
  const body = Array.from(
    { length: 140 },
    (_, i) => `declare function synthetic_${i}(value: "界😀"): "ok";`
  ).join('\n')
  const f = await fixture(t, "import {output} from 'velaros';output('current');", undefined, {
    limits: { projectionChars: 40000 },
  })
  const receipt = await f.session.execute(
    {
      source: `import {output} from 'velaros';import {read} from 'test:world';await read();output(${JSON.stringify(body)},{key:'contract',purpose:'Inspect synthetic declarations',required:true,type:'code',view:{mode:'full'}});`,
    },
    'task'
  )
  assert.equal(receipt.checked, true)
  assert.equal(receipt.result.failed, undefined)
  for (let i = 0; i < 5; i++)
    await f.session.execute(
      { source: `import {output} from 'velaros';output(${i},{key:'small-${i}'});` },
      'task'
    )
  const record = await f.programs.read(receipt.resultRef, 0, 1)
  const original = await f.storage.get('root', record.record.objectId)
  const archived = JSON.parse(original)
  const projected = await f.programs.project(
    (await f.session.view.inspect()).view,
    undefined,
    [],
    signal,
    40000
  )
  const material = JSON.parse(projected.body)
  const result = material.results.find((item) => item.ref === receipt.resultRef)
  assert.equal(projected.budget.visibleResults, 6)
  assert(body.length > projected.budget.excerptChars, 'full demand must exceed the default share')
  assert.equal(result.representation, 'full')
  assert.equal(result.bodyIncluded, true)
  assert(result.text.includes(body))
  assert.equal(result.outputProofs[0].contentHash, scriptOutputs.hash(body))
  assert.equal(result.outputProofs[0].key, 'contract')
  assert.equal(archived.output.blocks[0].value, body)
  await f.run()
  assert.equal(f.requests.length, 1, 'no recall turn is needed before completing')
  const request = f.requests[0]
  const wire = modelRequestEncoder
    .messages(request)
    .flatMap((item) => (typeof item.content === 'string' ? [item.content] : []))
    .join('\n')
  assert(wire.includes(body), 'all original body characters must reach provider messages')
  const frame = JSON.parse(request.materials.find((item) => item.origin === 'runtime-view').text)
  assert.equal(
    frame.partitions.runtime.decision.missing.some((item) => item.ref === receipt.resultRef),
    false
  )
  assert.equal(f.reads, 1, 'delivery does not repeat the authorized source operation')
  assert.equal(await f.storage.get('root', record.record.objectId), original)
})

test('INV-58 uncapped full demand keeps capacity and explicit caps authoritative in real requests', async (t) => {
  const body = 'whole original\n'.repeat(600)
  for (const [label, projectionChars, view, config] of [
    ['insufficient frame capacity', 12000, { mode: 'full' }, undefined],
    ['numeric block cap', 40000, { mode: 'full', maxChars: 500 }, undefined],
    ['explicit total zero', 40000, { mode: 'full' }, 0],
  ])
    await t.test(label, async (t) => {
      const f = await fixture(t, "import {output} from 'velaros';output('current');", undefined, {
        limits: { projectionChars },
      })
      const receipt = await f.session.execute(
        {
          source: `import {output} from 'velaros';${config === undefined ? '' : `output.configure({maxChars:${config}});`}output(${JSON.stringify(body)},{key:'body',purpose:'Inspect synthetic complete body',required:true,type:'code',view:${JSON.stringify(view)}});`,
        },
        'task'
      )
      assert.equal(receipt.checked, true)
      assert.equal(receipt.result.failed, undefined)
      for (let i = 0; i < 5; i++)
        await f.session.execute(
          { source: `import {output} from 'velaros';output(${i},{key:'small-${i}'});` },
          'task'
        )
      const record = await f.programs.read(receipt.resultRef, 0, 1)
      const original = await f.storage.get('root', record.record.objectId)
      const archived = JSON.parse(original)
      const events = []
      for await (const event of f.session.submit('Continue observing')) events.push(event)
      assert.equal(events.at(-1).status, 'failed')
      assert(
        events.some((event) => event.type === 'verification' && event.reason === 'CONTEXT_REQUIRED')
      )
      assert(f.requests.length > 0, 'the bounded projection must reach a real model request')
      for (const request of f.requests) {
        const frame = JSON.parse(
          request.materials.find((item) => item.origin === 'runtime-view').text
        )
        const result = frame.partitions.recent.results.find(
          (item) => item.ref === receipt.resultRef
        )
        const history = historyEntries(request).find((item) => item.ref?.id === receipt.resultRef)
        assert.equal(result.truncated, true)
        assert.notEqual(result.representation, 'full')
        assert.equal(
          history?.outputProofs?.some(
            (item) => item.ref === receipt.resultRef && item.key === 'body'
          ) ?? false,
          false,
          'a delivered reference card must not carry a full-value proof'
        )
        assert(
          frame.partitions.runtime.decision.missing.some(
            (item) => item.ref === receipt.resultRef && item.key === 'body'
          )
        )
        const wire = modelRequestEncoder
          .messages(request)
          .flatMap((item) => (typeof item.content === 'string' ? [item.content] : []))
          .join('\n')
        assert(!wire.includes(body), 'insufficient display must not claim full delivery')
        // 外层卡片说明当前编码已经送达；逐块元数据和 required 缺口才说明原值是否完整。
        const deliveredText = result.bodyInHistory ? history.text : result.text
        assert.equal(typeof deliveredText, 'string')
        assert(wire.includes(deliveredText), 'the inspected carrier must be in provider messages')
        if (deliveredText) {
          const [headerText, blockText] = deliveredText.split('\n')
          const header = JSON.parse(headerText)
          const block = JSON.parse(blockText)
          assert(deliveredText.length <= header.displayChars)
          assert.equal(block.key, 'body')
          assert.equal(block.rawRef, receipt.resultRef)
          assert.equal(block.contentHash, scriptOutputs.hash(body))
          assert.equal(block.representation, 'reference')
          assert.equal(block.bodyIncluded, false)
        }
        if (config === 0) assert.equal(result.text, '')
      }
      assert.equal(archived.output.blocks[0].value, body)
      assert.equal(archived.output.blocks[0].options.view.maxChars, view.maxChars)
      assert.equal(await f.storage.get('root', record.record.objectId), original)
      const recalled = await f.session.execute({
        source: `import {memory} from 'velaros:system';import {output} from 'velaros';const page=await memory.read({ref:${JSON.stringify(receipt.resultRef)},pointer:'/output/blocks/0/value',offset:0,limit:20000});output(page);`,
      })
      const recallRecord = await f.programs.read(recalled.resultRef, 0, 1)
      const recallArchive = JSON.parse(await f.storage.get('root', recallRecord.record.objectId))
      assert.equal(recallArchive.result.failed, undefined)
      assert.equal(recallArchive.output.blocks[0].value.text, body)
    })
})

test('INV-58 ordinary JSON text fit reaches sealed provider messages with matching required proof', async (t) => {
  const value = {
    state: 1,
    lines: Array.from({ length: 450 }, (_, i) => `\trow ${i}: "界😀" \\path\r`).join('\n'),
  }
  for (const cap of [16000, 9000]) {
    const f = await fixture(
      t,
      `import {output} from 'velaros';import {read} from 'test:world';output.configure({maxChars:${cap}});const state=await read();output({...${JSON.stringify(value)},state},{key:'data',purpose:'inspect synthetic multiline JSON',required:true,view:{mode:'full'}});`
    )
    const events = []
    for await (const event of f.session.submit('Continue observing')) events.push(event)
    assert.equal(
      events.at(-1).status,
      cap === 16000 ? 'completed' : 'failed',
      JSON.stringify({ cap, events })
    )
    if (cap === 9000)
      assert(
        events.some((event) => event.type === 'verification' && event.reason === 'CONTEXT_REQUIRED')
      )
    const request = f.requests[0]
    const frame = JSON.parse(request.materials.find((item) => item.origin === 'runtime-view').text)
    const observed = frame.partitions.observation
    const record = await f.programs.read(observed.resultRef, 0, 1)
    const archived = JSON.parse(await f.storage.get('root', record.record.objectId))
    assert.deepEqual(archived.output.blocks[0].value, value)
    const actual = scriptOutputs.project(
      archived.output,
      observed.resultRef,
      cap,
      undefined,
      undefined,
      undefined,
      'text'
    )
    const json = scriptOutputs.project(archived.output, observed.resultRef, cap)
    const block = actual.blocks.find((item) => item.key === 'data')
    assert.equal(observed.text, actual.prompt)
    assert.equal(observed.presentation.format, 'text')
    assert.equal(observed.presentation.allocatedChars, cap)
    assert.equal(observed.blocks[0].contentHash, scriptOutputs.hash(value))
    assert.equal(json.blocks[0].representation, 'reference')
    assert.equal(block.representation, cap === 16000 ? 'full' : 'reference')
    assert.equal(observed.bodyIncluded, cap === 16000)
    assert.equal(observed.truncated, cap !== 16000)
    assert.equal(
      frame.partitions.runtime.decision.missing.some((item) => item.key === 'data'),
      cap !== 16000
    )
    const messages = modelRequestEncoder.messages(request)
    const wire = messages
      .flatMap((item) => (typeof item.content === 'string' ? [item.content] : []))
      .join('\n')
    assert(
      wire.includes(actual.prompt),
      'the complete actual text encoding reaches provider messages'
    )
    if (cap === 16000) {
      assert.deepEqual(JSON.parse(block.text), value)
      assert(
        wire.includes(JSON.stringify(value, null, 2)),
        'outer request serialization preserves every body character'
      )
      const fullJson = scriptOutputs.project(
        { ...archived.output, config: { maxChars: 200000 } },
        observed.resultRef,
        200000
      )
      assert(fullJson.prompt.length > cap)
    } else assert(!wire.includes(JSON.stringify(value, null, 2)))
    assert.equal(
      f.reads,
      f.requests.length,
      'each business round captures once through its authorized operation'
    )
  }
})

test('INV-58 plain output retains bounded code evidence inside large arrays instead of only a receipt shell', () => {
  const original = {
    executionId: 'inspect-source',
    mode: 'execute',
    checked: true,
    result: {
      value: {
        default: [
          {
            sections: [
              {
                path: 'source.ts',
                line: 1,
                text: `const readableEvidence = 42;\n${'const filler = true;\n'.repeat(1500)}`,
              },
            ],
            issues: [],
          },
          { callers: [], count: 0 },
        ],
      },
    },
    metrics: { durationMs: 10, capabilityCalls: 2 },
  }
  const text = JSON.stringify(original)
  const projected = projectMaterial(text, { sessionId: 's', id: 'raw' }, 12000)
  const shown = JSON.parse(projected.text)
  assert.equal(shown.executionId, 'inspect-source')
  assert.equal(shown.checked, true)
  assert.deepEqual(shown.metrics, original.metrics)
  assert.match(projected.text, /const readableEvidence = 42/)
  assert(projected.omitted.some((pointer) => pointer.startsWith('/result/value/default')))
  assert(projected.text.length <= 12000)
  assert.equal(projected.representation, 'excerpt')
  assert.equal(JSON.stringify(original), text)
  assert.equal(projected.size.chars, text.length)
})

test('INV-58 projected fragments preserve JSON validity, source pointers and hard budgets including escaped Unicode', () => {
  const text = JSON.stringify({
    'a/b~c': [{ text: '😀"\\\n'.repeat(12000), count: 9 }],
    state: 'ready',
  })
  for (const limit of [0, 1, 200, 512, 1024, 4096, 12000]) {
    const projected = projectMaterial(text, { sessionId: 's', id: 'raw' }, limit)
    assert(projected.text.length <= limit)
    if (projected.text) assert.doesNotThrow(() => JSON.parse(projected.text))
    assert(projected.omitted.length > 0)
  }
  const projected = projectMaterial(text, { sessionId: 's', id: 'raw' }, 12000)
  assert(projected.omitted.some((pointer) => pointer.startsWith('/a~1b~0c/0/text')))
  assert.match(projected.text, /"state":"ready"/)
  const full = projectMaterial('{"small":true}', { sessionId: 's', id: 'small' }, 1000)
  assert.equal(full.text, '{"small":true}')
  assert.equal(full.representation, 'full')
})

test('INV-58 a root reference card never claims to include execution output', () => {
  const text = JSON.stringify({ result: { stdout: 'diagnostic '.repeat(60) }, checked: true })
  const projected = projectMaterial(text, { sessionId: 's', id: 'a1b2c3d4' }, 416)
  assert.equal(JSON.parse(projected.text).reason, 'view-budget')
  assert.equal(projected.representation, 'reference')
  assert.equal(projected.bodyIncluded, false)
  assert.deepEqual(projected.omitted, ['/'])
  assert(projected.text.length <= 416)
})

test('projected pointer sizes drive exact recall loops for escaped strings and JSON values', () => {
  const values = [
    '\t"source\\path"\r\n界😀\u0301'.repeat(1800),
    Array.from({ length: 400 }, (_, i) => ({ i, text: '"\\\n😀' })),
  ]
  for (const value of values) {
    const archived = JSON.stringify({ 'source/~': value, status: 'ready' })
    const projected = projectMaterial(archived, { sessionId: 's', id: 'ref' }, 800)
    const shown = JSON.parse(projected.text)['source/~']
    assert(shown.read.pointer)
    const expected = typeof value === 'string' ? value : JSON.stringify(value)
    assert.equal(shown.chars, expected.length)
    let text = ''
    let offset = 0
    while (offset < shown.chars) {
      const page = readMaterialField(
        archived,
        shown.read.pointer,
        offset,
        Math.min(257, shown.chars - offset)
      )
      assert(page.text.length > 0)
      assert.equal(page.totalChars, shown.chars)
      text += page.text
      offset += page.text.length
    }
    assert.equal(text, expected)
    assert.equal(projected.size.chars, archived.length)
    assert(projected.text.length <= 800)
  }
  const rootArchive = JSON.stringify(values[0])
  const rootShown = JSON.parse(
    projectMaterial(rootArchive, { sessionId: 's', id: 'ref' }, 800).text
  )
  assert.equal(rootShown.chars, rootArchive.length)
  assert.equal(rootShown.read.pointer, undefined)
})

test('raw execution material preserves diagnostics, selects actual archive paths, and leaves intact previews stable', () => {
  const notice = { call: 'export', action: 'truncated', detail: 'legacy limit' }
  const rawValue = { source: 'const originalEvidence = true;\n'.repeat(2000) }
  const archived = {
    result: { value: 'legacy excerpt', notices: [notice], logs: ['diagnostic'] },
    rawValue,
  }
  const before = JSON.stringify(archived)
  const material = JSON.parse(executionMaterial(archived))
  assert.deepEqual(material.result, { notices: [notice], logs: ['diagnostic'] })
  assert.deepEqual(material.rawValue, rawValue)
  const shown = projectMaterial(JSON.stringify(material), { sessionId: 's', id: 'raw' }, 12000)
  assert(shown.text.includes('const originalEvidence = true;'))
  assert(shown.omitted.includes('/rawValue/source'))
  assert(shown.text.length <= 12000)
  assert.equal(JSON.stringify(archived), before)
  const missing = { result: archived.result }
  assert.deepEqual(JSON.parse(executionMaterial(missing)), missing)
  const complete = { result: { value: { ok: true } }, rawValue: { ok: true } }
  assert.deepEqual(JSON.parse(executionMaterial(complete)), { result: complete.result })
})

test('INV-58 ordinary execute output reaches the next real model request and the full value remains recallable', async (t) => {
  const f = await fixture(t, "import {output} from 'velaros';output(1)")
  const result = await f.session.execute({
    source: `import {output} from 'velaros';output([{path:'source.ts',text:'const nextTurnEvidence = 7;\\n'+'const filler = true;\\n'.repeat(1500)}]);`,
  })
  assert.equal(result.checked, true)
  await f.run()
  const entry = historyEntries(f.requests[0]).find(
    (e) => e.origin === 'runtime-execution' && e.ref.id === result.resultRef
  )
  assert(entry)
  assert.match(entry.text, /const nextTurnEvidence = 7/)
  const raw = await f.programs.read(result.resultRef, 0, 1)
  const record = JSON.parse(await f.storage.get('root', raw.record.objectId))
  assert.equal(record.output.blocks[0].value[0].text.split('\n').length, 1502)
})

test('INV-58 oversized ordinary execution projects its raw archive instead of a clipped legacy preview', async (t) => {
  const f = await fixture(t, "import {output} from 'velaros';output(1)")
  const result = await f.session.execute({
    source: `import {output} from 'velaros';output({success:true,exitCode:0,stdout:Array.from({length:1500},(_,i)=>'const oversizedEvidence'+i+' = "original source";').join('\\n'),stderr:''});`,
  })
  assert.equal(result.checked, true)
  assert.equal(
    typeof result.result.value,
    'string',
    'fixture must exercise the legacy preview limit'
  )
  await f.run()
  const entry = historyEntries(f.requests[0]).find(
    (item) => item.origin === 'runtime-execution' && item.ref.id === result.resultRef
  )
  assert(entry)
  assert.doesNotThrow(() => JSON.parse(entry.text))
  assert(
    entry.text.includes('const oversizedEvidence0 ='),
    'original source must reach the next request'
  )
  assert(
    entry.text.includes('/output/blocks/0/value/stdout'),
    'excerpt must point to its actual archived field'
  )
  assert(!entry.text.includes('const oversizedEvidence1499 ='), 'display remains bounded')
  const raw = await f.programs.read(result.resultRef, 0, 1)
  const archived = JSON.parse(await f.storage.get('root', raw.record.objectId))
  assert.equal(archived.output.blocks[0].value.stdout.split('\n').length, 1500)
  assert(
    archived.output.blocks[0].value.stdout.endsWith(
      'const oversizedEvidence1499 = "original source";'
    )
  )
  await f.run()
  const repeated = historyEntries(f.requests[1]).find((item) => item.ref?.id === result.resultRef)
  assert.equal(repeated.text, entry.text)
})

test('INV-58 managed code fills its assigned budget before entering stable model history', async (t) => {
  const f = await fixture(t, "import {output} from 'velaros';output(1)")
  const lines = Array.from({ length: 800 }, (_, i) => `\tconst value${i} = "source\\path😀";`)
  const value = lines.join('\n')
  const result = await f.session.execute({
    source: `import {output} from 'velaros';output.configure({maxChars:12000});output(${JSON.stringify(value)},{type:'code',view:{maxChars:36000}});`,
  })
  assert.equal(result.checked, true)
  await f.run()
  const entry = historyEntries(f.requests[0]).find(
    (item) => item.origin === 'runtime-execution' && item.ref.id === result.resultRef
  )
  assert(entry)
  assert(entry.text.includes(lines[210]), 'code that fits the existing budget must reach the model')
  assert(!entry.text.includes(lines.at(-1)), 'output remains bounded')
  await f.run()
  const repeated = historyEntries(f.requests[1]).find((item) => item.ref?.id === result.resultRef)
  assert.equal(repeated.text, entry.text, 'delivered history must remain byte stable')
  const raw = await f.programs.read(result.resultRef, 0, 1)
  const archived = JSON.parse(await f.storage.get('root', raw.record.objectId))
  assert.equal(archived.output.blocks[0].value, value, 'full original remains recallable')
})

test('INV-58 batch display reclaims spare space once and keeps delivered history stable', async (t) => {
  const f = await fixture(t, "import {output} from 'velaros';output(1)")
  const lines = Array.from({ length: 800 }, (_, i) => `\tconst value${i} = "source\\path😀";`)
  const result = await f.session.execute({
    source: `import {output} from 'velaros';output(${JSON.stringify(lines.join('\n'))},{key:'code',type:'code'});output('finished',{key:'status'});`,
  })
  assert.equal(result.checked, true)
  await f.run()
  const entry = historyEntries(f.requests[0]).find((item) => item.ref?.id === result.resultRef)
  assert(entry)
  assert(entry.text.includes(lines[210]), 'available batch space must expose additional code')
  assert(entry.text.includes('finished'), 'the other block must remain visible')
  assert(!entry.text.includes(lines.at(-1)), 'the original display budget still applies')
  await f.run()
  const repeated = historyEntries(f.requests[1]).find((item) => item.ref?.id === result.resultRef)
  assert.equal(repeated.text, entry.text, 'delivered history must remain byte stable')
  const raw = await f.programs.read(result.resultRef, 0, 1)
  const archived = JSON.parse(await f.storage.get('root', raw.record.objectId))
  assert.equal(archived.output.blocks[0].value, lines.join('\n'))
})

test('INV-58 explicit batch display uses available frame space and preserves delivered history', async (t) => {
  const f = await fixture(t, "import {output} from 'velaros';output(1)")
  const result = await f.session.execute({
    source: `import {output} from 'velaros';import {read} from 'test:world';await read();
output.configure({maxChars:70000});
for(let i=0;i<8;i++){
 output({success:true,exitCode:0},{key:'source_'+i+'_status',required:true});
 output('begin_'+i+'\\r\\n'+('source 😀 \\"quoted\\" \\\\path\\r\\n').repeat(45+i*12)+'end_'+i,
  {key:'source_'+i,type:'code',view:{mode:'full',maxChars:30000}});
}`,
  })
  assert.equal(result.checked, true)
  const raw = await f.programs.read(result.resultRef, 0, 1)
  const original = await f.storage.get('root', raw.record.objectId)
  const archived = JSON.parse(original)
  const view = (await f.session.view.inspect()).view
  const frame = JSON.parse((await f.programs.project(view, undefined, [], signal, 700000)).body)
  const visible = frame.results.find((item) => item.ref === result.resultRef)
  const displayed = await f.display(result.resultRef, 70000)
  assert.equal(visible.outputFormat, 'text')
  assert.equal(visible.text, displayed.prompt)
  assert.equal(displayed.blocks.length, 16)
  assert(displayed.blocks.every((block) => block.representation === 'full'))
  assert(visible.text.length > 12000)
  assert(visible.text.length <= 70000)
  assert(visible.source.length <= 12000, 'source previews keep their conservative cap')
  assert(!frame.decision.missing.some((item) => item.ref === result.resultRef))
  for (const block of archived.output.blocks)
    if (typeof block.value === 'string')
      assert.equal(displayed.blocks.find((item) => item.key === block.key).text, block.value)
  await f.run()
  const request = f.requests[0]
  const entry = historyEntries(request).find((item) => item.ref?.id === result.resultRef)
  assert(entry)
  const active = JSON.parse(
    request.materials.find((item) => item.origin === 'runtime-view').text
  ).partitions.recent.results.find((item) => item.ref === result.resultRef)
  assert.equal(active.bodyInHistory, true)
  assert.equal(active.bodyIncluded, true)
  assert.equal(active.truncated, undefined)
  assert.equal(active.text, undefined, 'delivered history is not repeated in the current frame')
  const actual = await f.display(result.resultRef, 70000)
  assert.equal(actual.format, 'text')
  assert.equal(entry.text, actual.prompt)
  assert(actual.blocks.every((block) => block.representation === 'full'))
  for (const block of archived.output.blocks)
    if (typeof block.value === 'string')
      assert.equal(actual.blocks.find((item) => item.key === block.key).text, block.value)
  const encoded = JSON.stringify(request)
  for (let i = 0; i < 8; i++)
    assert(encoded.includes(`end_${i}`), 'all generated evidence reaches the real request')
  await f.run()
  const repeated = historyEntries(f.requests[1]).find((item) => item.ref?.id === result.resultRef)
  assert.deepEqual(repeated, entry, 'the historical representation remains unchanged')
  assert.equal(f.reads, 1, 'projection and history never repeat the source operation')
  assert.equal(await f.storage.get('root', raw.record.objectId), original)
})

test('INV-58 output requests share finite frame capacity while defaults and zero remain conservative', async (t) => {
  const f = await fixture(t, "import {output} from 'velaros';output(1)")
  const outputs = []
  for (const config of ['{maxChars:200000}', null, '{maxChars:0}']) {
    const result = await f.session.execute({
      source: `import {output} from 'velaros';${config ? `output.configure(${config});` : ''}
output('must remain',{key:'status',required:true});
output('source 😀 \\"quoted\\" \\\\path\\r\\n'.repeat(5000),{key:'large',type:'code'});`,
    })
    assert.equal(result.checked, true)
    outputs.push(result.resultRef)
  }
  const view = (await f.session.view.inspect()).view
  for (const maxChars of [24000, 120000, 600000]) {
    const projected = await f.programs.project(view, undefined, [], signal, maxChars)
    const frame = JSON.parse(projected.body)
    assert.equal(frame.results.length, 3)
    const share = Math.floor(maxChars / frame.results.length / 2)
    const pool = share * frame.results.length
    for (const [index, ref] of outputs.entries()) {
      const item = frame.results.find((result) => result.ref === ref)
      const cap =
        index === 0
          ? (JSON.parse(item.text.split('\n')[0]).displayChars ?? 200000)
          : index === 1
            ? Math.min(12000, share)
            : 0
      if (index === 0) {
        assert(
          cap >= Math.min(share, 200000),
          'an explicit request receives its share up to its requested ceiling'
        )
        assert(
          cap <= Math.min(200000, pool),
          'borrowing cannot exceed the finite result pool or request'
        )
      }
      assert(item.text.length <= cap)
      assert(item.source.length <= Math.min(12000, share))
      if (index === 2) {
        assert.equal(item.text, '')
        assert(frame.decision.missing.some((missing) => missing.ref === ref))
        continue
      }
      const display = await f.display(ref, cap)
      assert.equal(item.outputFormat, 'text')
      assert.equal(scriptOutputs.hash(item.text), scriptOutputs.hash(display.prompt))
      const displayChars = JSON.parse(item.text.split('\n')[0]).displayChars
      if (displayChars !== undefined) assert.equal(displayChars, cap)
      assert.equal(display.blocks.find((block) => block.key === 'status').representation, 'full')
      const large = display.blocks.find((block) => block.key === 'large')
      assert.equal(large.rawRef, ref)
      assert.equal(large.pointer, '/output/blocks/1/value')
      if (large.representation === 'excerpt') {
        assert.equal(large.selection.chars.unit, 'utf16')
        assert.equal(large.selection.chars.shown, large.text.length)
      } else assert.equal(large.representation, 'full')
      if (maxChars === 600000 && index === 0) assert(item.text.length > 12000)
    }
    assert(frame.results.reduce((sum, result) => sum + result.text.length, 0) <= pool)
  }
})

test('INV-58 explicit display keeps full and reference policies and required gaps under smaller frames', async (t) => {
  const f = await fixture(t, "import {output} from 'velaros';output(1)")
  const result = await f.session.execute({
    source: `import {output} from 'velaros';output.configure({maxChars:36000});
output('bounded 😀\\r\\n'.repeat(1600),{key:'required',type:'code',required:true,view:{mode:'full'}});
output('private to archive',{key:'reference',view:{mode:'reference'}});`,
  })
  assert.equal(result.checked, true)
  const view = (await f.session.view.inspect()).view
  for (const [maxChars, expected] of [
    [24000, 'reference'],
    [400000, 'full'],
  ]) {
    const frame = JSON.parse((await f.programs.project(view, undefined, [], signal, maxChars)).body)
    const item = frame.results.find((entry) => entry.ref === result.resultRef)
    const display = await f.display(result.resultRef, Math.min(36000, maxChars / 2))
    assert.equal(item.outputFormat, 'text')
    assert.equal(item.text, display.prompt)
    assert(item.text.length <= Math.min(36000, maxChars / 2))
    assert.equal(display.blocks.find((block) => block.key === 'required').representation, expected)
    assert.equal(
      display.blocks.find((block) => block.key === 'reference').representation,
      'reference'
    )
    assert.equal(
      frame.decision.missing.some((missing) => missing.ref === result.resultRef),
      expected !== 'full'
    )
  }
})

test('INV-58 explicit block requests use the finite result share and preserve actual delivered history', async (t) => {
  const f = await fixture(t, "import {output} from 'velaros';output(1)")
  const values = [
    { success: true, stdout: `FIRST_BEGIN${'alpha '.repeat(2200)}FIRST_END`, stderr: '' },
    {
      success: false,
      exitCode: 7,
      stdout: `SECOND_BEGIN${'beta '.repeat(550)}SECOND_END`,
      stderr: 'diagnostic retained',
    },
    { success: true, stdout: `THIRD_BEGIN${'gamma '.repeat(350)}THIRD_END`, stderr: '' },
  ]
  const result = await f.session.execute({
    source: `import {output} from 'velaros';import {read} from 'test:world';await read();
${values.map((value, index) => `output(${JSON.stringify(value)},{key:'part_${index}',required:true,view:{mode:'full',maxChars:20000}});`).join('\n')}`,
  })
  assert.equal(result.checked, true)
  assert.equal(result.result.failed, undefined)
  const view = (await f.session.view.inspect()).view
  const frame = JSON.parse((await f.programs.project(view, undefined, [], signal, 400000)).body)
  const item = frame.results.find((entry) => entry.ref === result.resultRef)
  assert.equal(
    item.representation,
    'full',
    'explicit per-block requests must use the existing finite share'
  )
  assert.equal(
    frame.decision.missing.some((entry) => entry.ref === result.resultRef),
    false
  )
  assert(item.text.length > 12000)
  assert(item.text.length < 24000, 'this case fits the existing history-entry boundary')
  assert(item.source.length <= 12000, 'source previews retain their separate bound')
  await f.run()
  const delivered = historyEntries(f.requests[0]).find(
    (entry) => entry.ref?.id === result.resultRef
  )
  assert(delivered)
  for (const value of values)
    assert(delivered.text.includes(value.stdout), 'the model receives every original body')
  assert(delivered.text.includes('diagnostic retained'))
  const runtime = JSON.parse(
    f.requests[0].materials.find((entry) => entry.origin === 'runtime-view').text
  )
  assert.equal(runtime.partitions.runtime.decision.missing.length, 0)
  await f.run()
  assert.deepEqual(
    historyEntries(f.requests[1]).find((entry) => entry.ref?.id === result.resultRef),
    delivered
  )
  assert.equal(f.reads, 1)
  await f.programs.release(result.resultRef, signal)
  await f.run()
  const released = historyEntries(f.requests[2]).find((entry) => entry.ref?.id === result.resultRef)
  assert.equal(released.bodyIncluded, false)
  const raw = await f.programs.read(result.resultRef, 0, 1)
  assert.deepEqual(
    JSON.parse(await f.storage.get('root', raw.record.objectId)).output.blocks.map(
      (block) => block.value
    ),
    values
  )
})

test('INV-58 explicit block output beyond history capacity reaches the current frame without stale full proof', async (t) => {
  const f = await fixture(t, "import {output} from 'velaros';output(1)")
  const body = `LARGE_BEGIN${'bounded '.repeat(4000)}LARGE_END`
  const result = await f.session.execute({
    source: `import {output} from 'velaros';output(${JSON.stringify(body)},{key:'large',required:true,view:{mode:'full',maxChars:40000}});`,
  })
  assert.equal(result.checked, true)
  assert.equal(result.result.failed, undefined)
  const view = (await f.session.view.inspect()).view
  for (const [maxChars, full] of [
    [20000, false],
    [500000, true],
    [20000, false],
  ]) {
    const frame = JSON.parse((await f.programs.project(view, undefined, [], signal, maxChars)).body)
    const item = frame.results.find((entry) => entry.ref === result.resultRef)
    assert.equal(item.representation === 'full', full)
    assert.equal(
      frame.decision.missing.some((entry) => entry.ref === result.resultRef),
      !full
    )
    assert(
      item.text.length <= Math.floor(maxChars / 2),
      'the finite result share remains authoritative'
    )
  }
  await f.run()
  const request = f.requests[0]
  const history = historyEntries(request).find((entry) => entry.ref?.id === result.resultRef)
  assert.equal(history.bodyIncluded, false, 'the 24000-character history cap remains unchanged')
  const runtime = JSON.parse(
    request.materials.find((entry) => entry.origin === 'runtime-view').text
  )
  const displayed = runtime.partitions.recent.results.find(
    (entry) => entry.ref === result.resultRef
  )
  assert.equal(displayed.bodyInHistory, undefined)
  assert.equal(displayed.bodyIncluded, true)
  assert(displayed.text.includes(body), 'the frame fallback actually reaches the model')
  assert(request.compiledPrompt.includes(body))
  assert.equal(runtime.partitions.runtime.decision.missing.length, 0)
})

test('INV-58 explicit block requests remain bounded across multiple leases and explicit total zero', async (t) => {
  const f = await fixture(t, "import {output} from 'velaros';output(1)")
  const refs = []
  for (const config of [null, '{maxChars:0}', '{maxChars:1000}']) {
    const result = await f.session.execute({
      source: `import {output} from 'velaros';${config ? `output.configure(${config});` : ''}output('bound '.repeat(2500),{key:'body',required:true,view:{mode:'full',maxChars:20000}});`,
    })
    assert.equal(result.checked, true)
    refs.push(result.resultRef)
  }
  const view = (await f.session.view.inspect()).view
  for (const maxChars of [18000, 700000, 18000]) {
    const frame = JSON.parse((await f.programs.project(view, undefined, [], signal, maxChars)).body)
    const share = Math.floor(maxChars / refs.length / 2)
    for (const [index, ref] of refs.entries()) {
      const item = frame.results.find((entry) => entry.ref === ref)
      const cap = index === 0 ? share : index === 1 ? 0 : Math.min(1000, share)
      assert(item.text.length <= cap)
      assert.equal(
        frame.decision.missing.some((entry) => entry.ref === ref),
        index !== 0 || maxChars === 18000
      )
      if (index === 1) assert.equal(item.text, '')
    }
    assert(frame.results.reduce((total, item) => total + item.text.length, 0) <= maxChars / 2)
  }
})

test('INV-58 frozen partial history cannot hide a later full or larger excerpt, including required and optional blocks', async (t) => {
  for (const [required, mode] of [
    [true, 'full'],
    [false, 'auto'],
    [true, 'auto'],
  ]) {
    const f = await fixture(t, "import {output} from 'velaros';output(1)")
    const body = `GROWTH_START\n${Array.from({ length: 1800 }, (_, index) => `line ${index} body\n`).join('')}GROWTH_END`
    const result = await f.session.execute({
      source: `import {output} from 'velaros';output('small',{key:'small',required:true,view:{mode:'full',maxChars:1000}});output(${JSON.stringify(body)},{key:'growing',type:'code',required:${required},view:{mode:${JSON.stringify(mode)},maxChars:40000}});`,
    })
    assert.equal(result.checked, true)
    const view = (await f.session.view.inspect()).view
    const first = await f.memory.project(view, undefined, [], signal, 24000)
    const firstFrame = JSON.parse(first.body)
    const originalHistory = historyEntries(first).find(
      (entry) => entry.ref?.id === result.resultRef
    )
    assert(originalHistory?.bodyIncluded)
    assert(!originalHistory.text.includes(body))
    await f.memory.acknowledge(firstFrame.frameId, signal)
    for (const maxChars of [36000, 600000, 24000]) {
      const projected = await f.memory.project(view, undefined, [], signal, maxChars)
      const frame = JSON.parse(projected.body)
      const current = frame.partitions.recent.results.find(
        (entry) => entry.ref === result.resultRef
      )
      assert.deepEqual(
        historyEntries(projected).find((entry) => entry.ref?.id === result.resultRef),
        originalHistory,
        'the accepted partial history remains byte-for-byte unchanged'
      )
      if (maxChars === 600000) {
        assert(
          current.text?.includes(body),
          'newly complete content must reach the current frame when frozen history remains partial'
        )
        assert.equal(current.bodyInHistory, undefined)
        assert.equal(
          frame.partitions.runtime.decision.missing.some((entry) => entry.ref === result.resultRef),
          false
        )
      } else if (mode === 'auto' && maxChars === 36000) {
        assert(
          current.text.length > originalHistory.text.length,
          'a larger excerpt must not be hidden by its older excerpt'
        )
      } else if (maxChars === 24000) {
        assert.equal(
          current.bodyInHistory,
          true,
          'an identical encoded presentation still deduplicates'
        )
        assert.equal(
          frame.partitions.runtime.decision.missing.some((entry) => entry.ref === result.resultRef),
          required
        )
        assert.equal(current.truncated, true)
        assert.equal(current.representation, 'excerpt')
      }
      assert(!JSON.stringify(frame).includes('outputFingerprint'))
    }
  }
})

test('INV-58 legacy history without presentation fingerprints keeps current content and full required proof', async (t) => {
  const f = await fixture(t, "import {output} from 'velaros';output(1)")
  const body = 'original complete evidence '.repeat(550)
  const result = await f.session.execute({
    source: `import {output} from 'velaros';output(${JSON.stringify(body)},{key:'body',required:true,view:{mode:'full',maxChars:20000}});`,
  })
  const view = (await f.session.view.inspect()).view
  const first = await f.memory.project(view, undefined, [], signal, 600000)
  await f.memory.acknowledge(JSON.parse(first.body).frameId, signal)
  const recent = new RecentContext('root', f.session.context, f.storage)
  const segment = await recent.segment(signal)
  const entry = segment.entries.find((item) => item.ref === result.resultRef)
  assert(entry.outputFingerprint)
  assert(entry.outputProofs.length)
  await recent.commit(
    {
      ...segment,
      entries: segment.entries.map((item) => {
        const legacy = { ...item }
        delete legacy.outputFingerprint
        delete legacy.outputViews
        return legacy
      }),
    },
    signal
  )
  for (const maxChars of [600000, 10000]) {
    const projected = await f.memory.project(view, undefined, [], signal, maxChars)
    const frame = JSON.parse(projected.body)
    const current = frame.partitions.recent.results.find((item) => item.ref === result.resultRef)
    assert.equal(
      current.bodyInHistory,
      undefined,
      'missing legacy fingerprint never asserts entire presentation equivalence'
    )
    assert.equal(
      frame.partitions.runtime.decision.missing.length,
      0,
      'the actual retained full history still proves required delivery when current budget shrinks'
    )
    assert.deepEqual(historyEntries(projected), historyEntries(first))
    if (maxChars === 600000) assert(current.text.includes(body))
    assert(!JSON.stringify(frame).includes('outputFingerprint'))
  }
})

test('INV-58 complete raw material in actual history covers a smaller projection but partial history does not', async (t) => {
  for (const firstChars of [600000, 4000]) {
    const f = await fixture(t, "import {output} from 'velaros';output(1)")
    const body = 'raw evidence '.repeat(350)
    const result = await f.session.execute({
      source: `import {output} from 'velaros';output(${JSON.stringify(body)});`,
    })
    const view = (await f.session.view.inspect()).view
    const first = await f.memory.project(view, undefined, [], signal, firstChars)
    await f.memory.acknowledge(JSON.parse(first.body).frameId, signal)
    const recent = new RecentContext('root', f.session.context, f.storage)
    const segment = await recent.segment(signal)
    const entry = segment.entries.find((item) => item.ref === result.resultRef)
    assert.equal(Boolean(entry.fullMaterial), firstChars === 600000)
    const next = await f.memory.project(
      view,
      undefined,
      [],
      signal,
      firstChars === 600000 ? 4000 : 600000
    )
    const frame = JSON.parse(next.body)
    const current = frame.partitions.recent.results.find((item) => item.ref === result.resultRef)
    assert.deepEqual(historyEntries(next), historyEntries(first))
    if (firstChars === 600000) {
      assert.equal(
        current.bodyInHistory,
        true,
        'complete retained raw material covers a narrower current projection'
      )
      assert.equal(current.text, undefined)
      for (const fullMaterial of [undefined, 'different-source-or-content']) {
        await recent.commit(
          {
            ...segment,
            entries: segment.entries.map((item) =>
              item.ref === entry.ref ? { ...item, fullMaterial } : item
            ),
          },
          signal
        )
        const unknown = JSON.parse((await f.memory.project(view, undefined, [], signal, 4000)).body)
        assert.equal(
          unknown.partitions.recent.results.find((item) => item.ref === result.resultRef)
            .bodyInHistory,
          undefined
        )
      }
    } else {
      assert.equal(current.bodyInHistory, undefined)
      assert(current.text.includes(body))
    }
    assert(!JSON.stringify(frame).includes('materialCoverage'))
    assert(!JSON.stringify(frame).includes('fullMaterial'))
  }
})

test('INV-58 trace budgets identify only the actual selected frame and stay outside provider text', async (t) => {
  const f = await fixture(t, "import {output} from 'velaros';output(1)")
  await f.session.context.append({
    kind: 'audit',
    title: 'context:frame:unselected-planning-frame',
    body: JSON.stringify({ frameId: 'unselected-planning-frame', budget: { maxChars: 1 } }),
  })
  await f.run()
  const request = f.requests[0]
  const material = JSON.parse(
    request.materials.find((entry) => entry.origin === 'runtime-view').text
  )
  const snapshot = await f.storage.load('root')
  const requestRecord = snapshot.records.findLast((entry) => entry.title === 'model-request')
  const selected = snapshot.records.find(
    (entry) => entry.title === `context:frame:${material.frameId}`
  )
  const audit = JSON.parse(await f.storage.get('root', selected.objectId))
  assert.equal(
    audit.budget.program.resultBudgetChars,
    Math.max(
      1,
      Math.floor(
        audit.budget.program.maxChars / Math.max(1, audit.budget.program.visibleResults) / 2
      )
    )
  )
  assert.equal(
    audit.budget.program.excerptChars,
    Math.min(12000, audit.budget.program.resultBudgetChars)
  )
  assert(audit.budget.program.maxChars <= audit.budget.maxChars)
  assert(audit.budget.historyEntryChars <= 24000)
  await f.session.context.append({
    kind: 'audit',
    title: selected.title,
    body: JSON.stringify({ frameId: material.frameId, budget: { maxChars: -1 } }),
  })
  const trace = await f.session.trace(requestRecord.ref.id)
  const frames = trace.records.filter((entry) => entry.title.startsWith('context:frame:'))
  assert.equal(frames.length, 1)
  assert.equal(
    frames[0].ref.id,
    selected.ref.id,
    'neither unselected planning frames nor later records replace the actual request frame'
  )
  assert.deepEqual(JSON.parse(frames[0].body).budget, audit.budget)
  assert(!JSON.stringify(request).includes('resultBudgetChars'))
  assert(!JSON.stringify(request).includes('historyEntryChars'))
})

test('INV-58 managed structured text reaches the next request without rereading the source', async (t) => {
  const f = await fixture(t, "import {output} from 'velaros';output(1)")
  const lines = Array.from({ length: 600 }, (_, i) => `const structuredEvidence${i} = "value";`)
  const value = { success: true, exitCode: 0, stdout: lines.join('\n'), stderr: '' }
  const result = await f.session.execute({
    source: `import {output} from 'velaros';import {read} from 'test:world';await read();output(${JSON.stringify(value)},{key:'command',view:{maxChars:15000}});`,
  })
  assert.equal(result.checked, true)
  await f.run()
  const entry = historyEntries(f.requests[0]).find(
    (item) => item.origin === 'runtime-execution' && item.ref.id === result.resultRef
  )
  assert(entry)
  const shown = JSON.parse(entry.text.slice(entry.text.indexOf('\n{\n') + 1))
  assert.equal(shown.success, true)
  assert.equal(shown.exitCode, 0)
  assert.equal(shown.stdout.representation, 'excerpt')
  assert(shown.stdout.text.includes(lines[100]))
  assert(!shown.stdout.text.includes(lines.at(-1)))
  assert.equal(shown.stdout.pointer, '/output/blocks/0/value/stdout')
  assert.equal(shown.stdout.rawRef, result.resultRef)
  const raw = await f.programs.read(result.resultRef, 0, 1)
  const archived = JSON.parse(await f.storage.get('root', raw.record.objectId))
  assert.deepEqual(archived.output.blocks[0].value, value)
  assert.equal(f.reads, 1)
  const offset = value.stdout.lastIndexOf(lines.at(-1))
  const recalled = await f.session.execute({
    source: `import {output} from 'velaros';import {memory} from 'velaros:system';const page=await memory.read(${JSON.stringify({ ref: shown.stdout.rawRef, pointer: shown.stdout.pointer, offset, limit: 4000 })});output(page.text,{key:'tail',type:'code'});`,
  })
  assert.equal(recalled.checked, true)
  assert.equal(recalled.result.failed, undefined)
  await f.run()
  const repeated = historyEntries(f.requests[1]).find((item) => item.ref?.id === result.resultRef)
  assert.equal(repeated.text, entry.text)
  const recalledEntry = historyEntries(f.requests[1]).find(
    (item) => item.ref?.id === recalled.resultRef
  )
  assert(
    recalledEntry.text.includes(lines.at(-1)),
    'the exact missing tail reaches the next model request'
  )
  assert.equal(f.reads, 1, 'field recall must not rerun the source operation')
  assert.deepEqual(JSON.parse(await f.storage.get('root', raw.record.objectId)), archived)
})

test('INV-22 emergency source edit rerenders archived observation without another read, and next normal round refreshes', async (t) => {
  const f = await fixture(t, source)
  await f.run()
  assert.equal(f.reads, 1)
  const snap = await f.maintenance.snapshot(10000, signal)
  const ref = snap.observation.resultRef
  await f.maintenance.apply(
    snap,
    patch(snap, {
      sourceRef: snap.observationRef,
      config: { maxChars: 3000 },
      outputs: [{ key: 'logs', view: { maxItems: 2, edge: 'tail', maxChars: 800 } }],
    }),
    signal
  )
  assert.equal(f.reads, 1)
  const frame = await f.project(ref)
  assert.notEqual(frame.observation.sourceRef, f.initial.sourceRef)
  assert.equal(frame.observation.collectedSourceRef, f.initial.sourceRef)
  assert.equal(frame.observation.resultRef, ref)
  assert.equal(frame.observation.adjustment.executed, false)
  assert.equal(frame.observation.presentation.requestedChars, 3000)
  assert.match(frame.observation.source, /"maxItems":2/)
  assert.equal(frame.observation.presentation.format, 'text')
  assert.deepEqual(frame.observation.blocks.find((b) => b.key === 'logs').selection, {
    from: 38,
    shown: 2,
    total: 40,
    unit: 'items',
  })
  assert(
    frame.observation.text.includes(
      JSON.stringify(
        [38, 39].map((i) => ({ i, text: 'e'.repeat(100) })),
        null,
        2
      )
    )
  )
  f.value = 2
  await f.run()
  assert.equal(f.reads, 2)
  const next = JSON.parse(f.requests.at(-1).materials[0].text).partitions.observation
  assert.equal(next.collectedSourceRef, next.presentationSourceRef)
  assert.equal(next.blocks.find((b) => b.key === 'state').representation, 'full')
  assert(next.text.includes(JSON.stringify({ state: 2 }, null, 2)))
})

test('INV-23 late invalid metadata keeps source and all other changes unpublished', async (t) => {
  const f = await fixture(t, source)
  await f.run()
  const note = await f.note()
  const snap = await f.maintenance.snapshot(10000, signal)
  await assert.rejects(
    f.maintenance.apply(
      snap,
      {
        ...patch(snap, {
          sourceRef: snap.observationRef,
          outputs: [{ key: 'missing', view: { maxChars: 20 } }],
        }),
        notes: [{ ref: note.ref, summary: 'must not be visible' }],
      },
      signal
    ),
    /不存在/
  )
  assert.equal((await f.programs.state()).observation, f.initial.sourceRef)
  assert(
    !(await f.storage.load('root')).records.some((r) => r.title === 'context:projection-policy')
  )
  assert.equal(f.reads, 1)
})

test('summary binds original content and user goal generation; stale or forged summaries cannot pass', async (t) => {
  const f = await fixture(t, source)
  await f.run()
  const snap = await f.maintenance.snapshot(10000, signal)
  const state = snap.observation.blocks.find((b) => b.key === 'state')
  const summary = {
    key: 'state',
    resultRef: snap.observation.resultRef,
    contentHash: state.contentHash,
    text: 'Current state is one.',
  }
  await assert.rejects(
    f.maintenance.apply(
      snap,
      patch(snap, {
        sourceRef: snap.observationRef,
        summaries: [{ ...summary, contentHash: 'forged' }],
      }),
      signal
    ),
    /不匹配/
  )
  await f.maintenance.apply(
    snap,
    patch(snap, {
      sourceRef: snap.observationRef,
      outputs: [{ key: 'state', view: { mode: 'summary' } }],
      summaries: [summary],
    }),
    signal
  )
  const rendered = await f.project(snap.observation.resultRef)
  assert.equal(rendered.observation.blocks.find((b) => b.key === 'state').representation, 'summary')
  f.value = 2
  await f.run()
  const next = JSON.parse(f.requests.at(-1).materials[0].text).partitions.observation
  assert.equal(next.blocks.find((b) => b.key === 'state').reason, 'summary-unavailable')
})

test('failure preserves completed blocks and reports missing outputs separately from empty successful values', async (t) => {
  const f = await fixture(
    t,
    `import {output} from 'velaros';output([],{key:'empty',type:'list'});throw Error('read unavailable');output(3,{key:'later'});`
  )
  await f.run()
  const view = JSON.parse(f.requests[0].materials[0].text).partitions.observation
  assert.equal(view.collection, 'partial')
  assert.match(view.failure.message, /read unavailable/)
  assert.deepEqual(view.missingOutputs, [{ key: 'later', status: 'not-produced' }])
  assert.equal(view.presentation.format, 'text')
  const displayed = await f.display(view.resultRef, 12000)
  assert.equal(displayed.blocks[0].text, '[]')
  assert.equal(view.text, displayed.prompt)
})

test('duplicate managed keys surface a repairable observation failure rather than breaking context assembly', async (t) => {
  const f = await fixture(
    t,
    `import {output} from 'velaros';output(1,{key:'x'});try{output(2,{key:'x'})}catch{}`
  )
  await f.run()
  const view = JSON.parse(f.requests[0].materials[0].text).partitions.observation
  assert.equal(view.collection, 'partial')
  assert.match(view.collectionIssues.join(), /重复/)
})

test('large once-only output remains fully recallable while its declared view stays bounded', async (t) => {
  const f = await fixture(t, source)
  const result = await f.session.execute({
    source: `import {output} from 'velaros';output({large:'x'.repeat(90000),state:7},{key:'large',type:'json',view:{paths:['/state'],maxChars:1000}});`,
  })
  assert.equal(result.checked, true)
  assert.equal(result.result.failed, undefined)
  await f.run()
  const frame = JSON.parse(f.requests[0].materials[0].text)
  const raw = await f.programs.read(result.resultRef, 0, 1)
  const record = JSON.parse(await f.storage.get('root', raw.record.objectId))
  assert.equal(record.output.blocks[0].value.large.length, 90000)
  assert(!f.requests[0].compiledPrompt.includes('x'.repeat(5000)))
  assert.equal(frame.partitions.recent.results[0].remainingTurns, 2)
})

test('native image is delivered, and emergency reference policy detaches it without another observation', async (t) => {
  const data =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWAAAAABJRU5ErkJggg=='
  const f = await fixture(
    t,
    `import {output} from 'velaros';output({type:'image-data',mediaType:'image/png',data:${JSON.stringify(data)},label:'pixel'},{key:'image',type:'image'});`
  )
  await f.run()
  assert.equal(f.requests[0].images.length, 1)
  assert(!JSON.parse(f.requests[0].materials[0].text).partitions.observation.text.includes(data))
  const snap = await f.maintenance.snapshot(12000, signal)
  await f.maintenance.apply(
    snap,
    patch(snap, {
      sourceRef: snap.observationRef,
      outputs: [{ key: 'image', view: { mode: 'reference' } }],
    }),
    signal
  )
  const raw = await f.session.context.read(
    { sessionId: 'root', id: snap.observation.resultRef },
    { limit: 60000 }
  )
  const saved = JSON.parse(raw.text)
  const imageRecord = await f.session.context.read(saved.attachments[0], { limit: 60000 })
  const frame = await f.programs.project(
    (await f.session.view.inspect()).view,
    { sessionId: 'root', id: snap.observation.resultRef },
    [JSON.parse(imageRecord.text)],
    signal,
    16000
  )
  assert.equal(frame.images.length, 0)
  const body = JSON.parse(frame.body)
  assert.equal(body.observation.nativeImages[0].attached, false)
  assert.equal(body.observation.presentationChanges[0].key, 'image')
})

test('source or user changes invalidate an in-flight output patch', async (t) => {
  const f = await fixture(t, source)
  await f.run()
  const snap = await f.maintenance.snapshot(10000, signal)
  await f.session.observe({ source: source.replace('maxItems:20', 'maxItems:10') })
  await assert.rejects(
    f.maintenance.apply(
      snap,
      patch(snap, { sourceRef: snap.observationRef, config: { maxChars: 2000 } }),
      signal
    ),
    { code: 'CONTEXT_CONFLICT' }
  )
  const next = await f.maintenance.snapshot(10000, signal)
  await f.session.context.append({ kind: 'user', body: 'Keep all error details' })
  await assert.rejects(
    f.maintenance.apply(
      next,
      patch(next, { sourceRef: next.observationRef, config: { maxChars: 1000 } }),
      signal
    ),
    { code: 'CONTEXT_CONFLICT' }
  )
})

test('the actual independent maintenance tool publishes output policy before the next main request without observer replay', async (t) => {
  let reads = 0
  let toolCalls = 0
  let mainCalls = 0
  const limits = { contextTokens: 100000, inputTokens: 90000, outputTokens: 8192 }
  const estimate = async () => ({ tokens: 1000, precision: 'exact', basis: 'test' })
  const main = {
    id: 'main',
    limits,
    estimate,
    async *stream(request) {
      mainCalls++
      const frame = JSON.parse(request.materials[0].text)
      const observation = frame.partitions.observation
      assert.equal(observation.presentation.requestedChars, 1500)
      if (mainCalls === 1)
        assert.notEqual(observation.collectedSourceRef, observation.presentationSourceRef)
      else {
        assert.equal(observation.collectedSourceRef, observation.presentationSourceRef)
        assert.equal(frame.partitions.runtime.progress.script.changed, false)
      }
      yield* done(request)
    },
  }
  const maintenance = {
    id: 'maintenance',
    limits,
    estimate,
    async *stream(request) {
      toolCalls++
      const snap = JSON.parse(
        JSON.parse(request.materials[0].text).partitions.task.goals[0].text
      ).snapshot
      const proposed = patch(snap, {
        sourceRef: snap.observationRef,
        config: { maxChars: 1500 },
        outputs: [{ key: 'state', view: { maxChars: 500 } }],
      })
      const response = turn(request, {
        execute: {
          source: `import {output} from 'velaros';import {submit} from 'velaros:context-materials';output(await submit(${JSON.stringify(proposed)}));`,
        },
      })
      yield { ...response, text: `${response.text}\n${marker(request)} done` }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const storage = localContextStorage({ path: ':memory:' })
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    model: main,
    context: { sources: [], maintenance: { model: maintenance } },
    modules: [
      {
        binding: {
          moduleId: 'test:world',
          instanceId: 'world',
          generation: 1,
          schemaRevision: '1',
        },
        summary: 'counter',
        operations: {
          read: {
            summary: 'read',
            input: { type: 'null' },
            output: { type: 'integer' },
            effects: 'none',
            run: () => {
              reads++
              return 1
            },
          },
        },
      },
    ],
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('root')
  await session.context.append({ kind: 'user', body: 'work' })
  await session.observe({
    source: `import {output} from 'velaros';import {read} from 'test:world';output(await read(),{key:'state',view:{maxChars:2000}});`,
  })
  const scheduled = await session.execute({
    source: `import {memory as context} from 'velaros:system';await context.organize({focus:'next investigate'});`,
  })
  assert(!scheduled.result.failed)
  const events = []
  for await (const event of session.submit('Observe the current value')) events.push(event)
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  assert.deepEqual({ reads, toolCalls, mainCalls }, { reads: 1, toolCalls: 1, mainCalls: 1 })
  t.diagnostic(
    JSON.stringify({
      observationReads: reads,
      maintenanceCalls: toolCalls,
      mainCalls,
      policyInSource: true,
      replayed: false,
    })
  )
  for await (const event of session.submit('Check again')) {
    assert.equal(typeof event.type, 'string')
  }
  assert.deepEqual({ reads, toolCalls, mainCalls }, { reads: 2, toolCalls: 1, mainCalls: 2 })
})

test('a maintenance candidate cannot hide required content and all staged metadata stays unpublished', async (t) => {
  const f = await fixture(
    t,
    `import {output} from 'velaros';output({value:1},{key:'critical',required:true});`
  )
  await f.run()
  const note = await f.note()
  const snap = await f.maintenance.snapshot(10000, signal)
  await assert.rejects(
    f.maintenance.apply(
      snap,
      {
        ...patch(snap, {
          sourceRef: snap.observationRef,
          outputs: [{ key: 'critical', view: { mode: 'reference' } }],
        }),
        notes: [{ ref: note.ref, summary: 'candidate' }],
      },
      signal
    ),
    { code: 'CONTEXT_REQUIRED' }
  )
  assert.equal((await f.programs.state()).observation, snap.observationRef)
  assert(
    !(await f.storage.load('root')).records.some((r) => r.title === 'context:projection-policy')
  )
})

test('the parent model budget validator rejects a fully staged candidate before CAS publication', async (t) => {
  const f = await fixture(t, source)
  await f.run()
  let previews = 0
  const state = new ContextMaintenanceState('root', f.storage, {
    validateCandidate: async (candidate) => {
      previews++
      assert.match(baseText(candidate), /candidate/)
      throw Object.assign(Error('input budget'), { code: 'CONTEXT_BUDGET' })
    },
  })
  const note = await f.note()
  const snap = await state.snapshot(10000, signal)
  await assert.rejects(
    state.apply(snap, { ...patch(snap), notes: [{ ref: note.ref, summary: 'candidate' }] }, signal),
    { code: 'CONTEXT_BUDGET' }
  )
  assert.equal(previews, 2)
  assert.equal(f.reads, 1)
  assert(
    !(await f.storage.load('root')).records.some((r) => r.title === 'context:projection-policy')
  )
})

test('an oversized maintenance candidate uses the parent recovery projection before rejecting the patch', async (t) => {
  const f = await fixture(
    t,
    `import {output} from 'velaros';import {read} from 'test:world';
await read();
output({value:'required-state'},{key:'critical',required:true,view:{mode:'full'}});
`
  )
  await f.run()
  await f.session.execute({ source: "console.log('optional-detail-'.repeat(2000))" }, 'task')
  const candidates = []
  const state = new ContextMaintenanceState('root', f.storage, {
    recoveryChars: 3000,
    validateCandidate: async (candidate) => {
      const frame = JSON.parse(candidate.body)
      const content = JSON.stringify(
        modelRequestEncoder.messages({
          instructions: 'Parent instructions',
          history: candidate.history,
          compiledPrompt: candidate.prompt,
          response: { type: 'text' },
        })
      )
      candidates.push({ frame, chars: content.length })
      assert.match(content, /required-state/)
      assert.deepEqual(frame.partitions.runtime.decision.missing, [])
      assert.match(baseText(candidate), /candidate/)
      if (content.length > 16000)
        throw Object.assign(Error('input budget'), {
          code: 'CONTEXT_BUDGET',
          sizes: candidates.map((c) => c.chars),
        })
    },
  })
  const note = await f.note()
  const snap = await state.snapshot(64000, signal)
  const input = { ...patch(snap), notes: [{ ref: note.ref, summary: 'candidate' }] }
  await state.validate(snap, input, signal)
  assert.equal(candidates.length, 2, JSON.stringify(candidates.map((c) => c.chars)))
  assert(candidates[0].chars > 16000)
  assert(candidates[1].chars <= 16000)
  assert(
    !(await f.storage.load('root')).records.some((r) => r.title === 'context:projection-policy')
  )
  await state.apply(snap, input, signal)
  assert.equal(candidates.length, 4)
  assert.equal(f.reads, 1, 'candidate preparation must not execute the observation again')
  assert(
    (await f.storage.load('root')).records.some((r) => r.title === 'context:projection-policy')
  )
})
