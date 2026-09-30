import assert from 'node:assert/strict'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ContextMemory } from '../../../dist/act/runtime/impl/ContextMemory.js'
import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'
import { executionMaterial, projectMaterial } from '../../../dist/act/runtime/utils/materials.js'
import { ContextMaintenanceState } from '../../../dist/act/system/impl/ContextMaintenanceState.js'

import { done, historyEntries, marker, turn } from './support/model-turn.mjs'

const signal = new AbortController().signal
async function fixture(t, source, modelOverride) {
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
    maintenance,
    initial,
    requests,
    run,
    project,
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
  const blocks = JSON.parse(frame.observation.text).blocks
  assert.deepEqual(
    JSON.parse(blocks.find((b) => b.key === 'logs').text).map((x) => x.i),
    [38, 39]
  )
  f.value = 2
  await f.run()
  assert.equal(f.reads, 2)
  const next = JSON.parse(f.requests.at(-1).materials[0].text).partitions.observation
  assert.equal(next.collectedSourceRef, next.presentationSourceRef)
  assert.equal(
    JSON.parse(JSON.parse(next.text).blocks.find((b) => b.key === 'state').text).state,
    2
  )
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
  assert.equal(
    JSON.parse(rendered.observation.text).blocks.find((b) => b.key === 'state').representation,
    'summary'
  )
  f.value = 2
  await f.run()
  const next = JSON.parse(f.requests.at(-1).materials[0].text).partitions.observation
  assert.equal(
    JSON.parse(next.text).blocks.find((b) => b.key === 'state').reason,
    'summary-unavailable'
  )
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
  assert.equal(JSON.parse(view.text).blocks[0].text, '[]')
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
      assert.match(candidate.history[0].content, /candidate/)
      throw Object.assign(Error('input budget'), { code: 'CONTEXT_BUDGET' })
    },
  })
  const note = await f.note()
  const snap = await state.snapshot(10000, signal)
  await assert.rejects(
    state.apply(snap, { ...patch(snap), notes: [{ ref: note.ref, summary: 'candidate' }] }, signal),
    { code: 'CONTEXT_BUDGET' }
  )
  assert.equal(previews, 1)
  assert.equal(f.reads, 1)
  assert(
    !(await f.storage.load('root')).records.some((r) => r.title === 'context:projection-policy')
  )
})
