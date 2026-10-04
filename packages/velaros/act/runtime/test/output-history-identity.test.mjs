import assert from 'node:assert/strict'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner, scriptOutputs } from '@velaros-ai/script'

import { ContextMemory } from '../../../dist/act/runtime/impl/ContextMemory.js'
import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'

import { historyEntries } from './support/model-turn.mjs'

const signal = new AbortController().signal

async function fixture(t) {
  const storage = localContextStorage({ path: ':memory:' })
  const requests = []
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    modules: [],
    model: {
      id: 'output-history-identity',
      limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4096 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
      stream(request) {
        requests.push(request)
        assert.fail('Projection must not invoke a model')
      },
    },
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('s')
  await session.context.append({ kind: 'user', body: 'Inspect synthetic material.' })
  const programs = new ProgramContext('s', session.context, storage)
  const recent = new RecentContext('s', session.context, storage)
  const memory = new ContextMemory('s', session.context, storage, session.view, programs, recent)
  const view = {
    id: 'output-history-identity',
    scope: { sessionId: 's', revision: 0 },
    goals: [],
    capsule: {},
    mandatory: [],
    evidence: [],
    gaps: [],
    readSet: [],
    progress: { step: 0, repeatedSteps: 0, stalled: false, evidence: [] },
  }
  return { storage, session, programs, recent, memory, requests, view }
}

async function archive(f, blocks, maxChars = 40000, issues = []) {
  const id = crypto.randomUUID()
  const source = await f.session.context.append({
    kind: 'audit',
    title: `script:${id}`,
    body: JSON.stringify({ source: 'output(synthetic)' }),
  })
  const result = await f.session.context.append({
    kind: 'audit',
    title: `script:${id}:result`,
    sources: [source.ref],
    body: JSON.stringify({
      mode: 'execute',
      output: {
        config: { maxChars },
        issues,
        blocks: blocks.map(({ value, options = {} }, index) => ({
          key: `block_${index}`,
          value,
          chars: JSON.stringify(value).length,
          options: {
            key: `block_${index}`,
            type: typeof value === 'string' ? 'text' : 'json',
            view: { mode: 'full' },
            ...options,
          },
        })),
      },
    }),
  })
  await f.programs.add(result.ref, source.ref, id, 'task')
  return result.ref
}

async function archiveRaw(f, stdout, short = true) {
  const uuid = crypto.randomUUID()
  const id = short ? uuid.slice(0, 8) : uuid
  const source = await f.session.context.append({
    kind: 'audit',
    title: `script:${id}`,
    body: JSON.stringify({ source: 'inspect synthetic files' }),
  })
  const result = await f.session.context.append({
    kind: 'audit',
    title: `script:${id}:result`,
    sources: [source.ref],
    body: JSON.stringify({ mode: 'execute', result: { process: { stdout, exitCode: 0 } } }),
  })
  await f.programs.add(result.ref, source.ref, id, 'task')
  return result.ref
}

async function project(f, chars, acknowledge = false) {
  const frame = await f.memory.project(f.view, undefined, [], signal, chars)
  if (acknowledge) await f.memory.acknowledge(JSON.parse(frame.body).frameId, signal)
  return frame
}

function current(frame, ref) {
  return JSON.parse(frame.body).partitions.recent.results.find((item) => item.ref === ref.id)
}

function retained(frame, ref) {
  return historyEntries(frame).find((item) => item.ref?.id === ref.id)
}

function envelope(text) {
  const newline = text.indexOf('\n')
  return { header: JSON.parse(text.slice(0, newline)), body: text.slice(newline + 1) }
}

function assertNoInternalProof(frame) {
  for (const text of [frame.prompt, JSON.stringify(frame.history)])
    assert(!text.includes('outputViews'), 'Internal display proof must not enter model text')
}

test('INV-69 reference-only raw results stay eligible for later body delivery', async (t) => {
  const f = await fixture(t)
  const body = 'READABLE_AFTER_CAPACITY_RECOVERS\n'.repeat(100)
  const ref = await archiveRaw(f, body)
  const first = await project(f, 1100, true)
  assert.equal(current(first, ref).bodyIncluded, false)
  const segment = await f.recent.segment(signal)
  assert(!segment.entries.some((entry) => entry.ref === ref.id))
  const next = await project(f, 30000, true)
  assert(retained(next, ref).text.includes(body.replaceAll('\n', '\\n')))
  assert.equal(current(next, ref).bodyInHistory, true)
})

test('INV-69 retained raw output returns its budget to fresh results for both reference formats', async (t) => {
  for (const short of [true, false]) {
    const f = await fixture(t)
    const refs = []
    for (let index = 0; index < 3; index++)
      refs.push(await archiveRaw(f, `older-${index}:${'x'.repeat(6500)}`, short))
    const first = await project(f, 100000, true)
    for (const ref of refs) assert.equal(current(first, ref).bodyInHistory, true)
    const body = Array.from(
      { length: 100 },
      (_, i) => `line ${i}: const freshEvidence = '${'y'.repeat(30)}'`
    ).join('\n')
    const fresh = await archiveRaw(f, body, short)
    const next = await project(f, 24000)
    for (const ref of refs) {
      assert.equal(retained(next, ref).text, retained(first, ref).text)
      assert.equal(current(next, ref).bodyInHistory, true)
    }
    assert(retained(next, fresh).text.includes('line 99: const freshEvidence'))
    assert.equal(current(next, fresh).bodyInHistory, true)
    assertNoInternalProof(next)
  }
})

test('INV-69 equal multi-block bodies survive budget changes only once in retained history', async (t) => {
  const f = await fixture(t)
  const values = ['FIRST_PLAIN_BODY 界😀\n'.repeat(25), 'SECOND_PLAIN_BODY \\"\n'.repeat(25)]
  const ref = await archive(f, [
    ...values.map((value) => ({ value })),
    {
      value: 'BOUNDED_THIRD_BODY '.repeat(300),
      options: { view: { mode: 'full', maxChars: 800 } },
    },
  ])
  const first = await project(f, 600000, true)
  const frozen = retained(first, ref)
  for (const value of values) assert(frozen.text.includes(value))
  const second = await project(f, 150000)
  const shown = current(second, ref)
  assert.equal(retained(second, ref).text, frozen.text, 'Frozen history must remain byte-identical')
  if (shown.text?.includes(values[0])) {
    const oldEnvelope = envelope(frozen.text)
    const newEnvelope = envelope(shown.text)
    assert.notEqual(oldEnvelope.header.displayChars, newEnvelope.header.displayChars)
    assert.equal(
      oldEnvelope.body,
      newEnvelope.body,
      'The output body is unchanged; only allocation metadata differs'
    )
    t.diagnostic(
      JSON.stringify({
        oldDisplayChars: oldEnvelope.header.displayChars,
        newDisplayChars: newEnvelope.header.displayChars,
        bodyChars: oldEnvelope.body.length,
      })
    )
  }
  for (const value of values)
    assert(
      !shown.text?.includes(value),
      'Same original block body must not repeat in the current frame'
    )
  assertNoInternalProof(second)
  assert.equal(f.requests.length, 0)
})

test('INV-69 a verified memory page retained in history does not repeat for a new frame allocation', async (t) => {
  const f = await fixture(t)
  const value = 'VERIFIED_PAGE_BODY "界😀"\n'.repeat(35)
  const original = await archive(f, [{ value, options: { required: true } }], 512)
  await project(f, 600000, true)
  const page = await f.memory.readMaterial(original, 0, 12000, signal, '/output/blocks/0/value')
  assert.equal(page.text, value)
  assert(page.delivery?.receipt, 'Use a real host-issued read delivery')
  const carrier = await archive(f, [
    { value: page },
    { value: 'Reference-only companion', options: { view: { mode: 'reference' } } },
  ])
  const first = await project(f, 600000, true)
  const frozen = retained(first, carrier)
  assert(frozen.text.includes(value))
  assert(frozen.text.includes('"encoding":"memory-page"'))
  const second = await project(f, 150000)
  const shown = current(second, carrier)
  assert.equal(retained(second, carrier).text, frozen.text)
  if (shown.text?.includes(value)) {
    const oldEnvelope = envelope(frozen.text)
    const newEnvelope = envelope(shown.text)
    assert.notEqual(oldEnvelope.header.displayChars, newEnvelope.header.displayChars)
    assert.equal(oldEnvelope.body, newEnvelope.body)
    t.diagnostic(
      JSON.stringify({
        oldDisplayChars: oldEnvelope.header.displayChars,
        newDisplayChars: newEnvelope.header.displayChars,
        bodyChars: oldEnvelope.body.length,
      })
    )
  }
  assert(
    !shown.text?.includes(value),
    'The already delivered page must not repeat with only a changed allocation header'
  )
  assertNoInternalProof(second)
  assert.equal(f.requests.length, 0)
})

test('INV-69 growing output ranges preserve new body while removing only the unchanged companion block', async (t) => {
  const f = await fixture(t)
  const stable = 'UNCHANGED_COMPANION\n'.repeat(12)
  const growing = Array.from({ length: 450 }, (_, i) => `GROWING_RANGE_${i} value 界😀`).join('\n')
  const ref = await archive(f, [
    { value: stable },
    { value: growing, options: { view: { mode: 'auto' } } },
  ])
  const first = await project(f, 10000, true)
  const frozen = retained(first, ref)
  assert(frozen.text.includes(stable))
  assert(frozen.text.includes('GROWING_RANGE_0'))
  assert(!frozen.text.includes('GROWING_RANGE_449'))
  const second = await project(f, 600000)
  const shown = current(second, ref)
  assert.equal(retained(second, ref).text, frozen.text)
  assert(shown.text.includes(growing), 'Earlier excerpt cannot cover newly displayed characters')
  assert(!shown.text.includes(stable), 'Only the already delivered companion body may be removed')
  assertNoInternalProof(second)
})

test('INV-69 a narrow unchanged selection is deduplicated without treating it as complete original content', async (t) => {
  const f = await fixture(t)
  const value = Array.from({ length: 180 }, (_, i) => `SELECTED_LINE_${i} 界😀`).join('\n')
  const ref = await archive(f, [
    { value, options: { required: true, view: { mode: 'auto', maxChars: 650 } } },
    { value: 'Keep this reference', options: { view: { mode: 'reference' } } },
  ])
  const first = await project(f, 600000, true)
  const frozen = retained(first, ref)
  assert(frozen.text.includes('SELECTED_LINE_0'))
  assert(!frozen.text.includes('SELECTED_LINE_179'))
  const second = await project(f, 25000)
  const shown = current(second, ref)
  assert.equal(retained(second, ref).text, frozen.text)
  assert(
    JSON.parse(second.body).partitions.runtime.decision.missing.some((gap) => gap.ref === ref.id)
  )
  assert(
    !shown.text?.includes('SELECTED_LINE_0'),
    'Same selected range does not need another body delivery'
  )
  assert(
    !second.prompt.includes('SELECTED_LINE_179'),
    'Deduplication must not invent the omitted tail'
  )
  assertNoInternalProof(second)
})

test('INV-69 a changed summary remains visible beside the actual earlier summary', async (t) => {
  const f = await fixture(t)
  const value = { status: 'ready', count: 3 }
  const ref = await archive(f, [{ value, options: { view: { mode: 'summary' } } }])
  const state = await f.storage.load('s')
  const taskRevision = scriptOutputs.hash([
    state.task?.goals ?? [],
    state.task?.startedSequence ?? 0,
  ])
  const summary = async (text) =>
    f.session.context.append({
      kind: 'audit',
      title: 'script:output-summaries',
      body: JSON.stringify([
        { key: 'block_0', contentHash: scriptOutputs.hash(value), taskRevision, text },
      ]),
    })
  await summary('EARLIER_SUMMARY: state is ready.')
  const first = await project(f, 600000, true)
  const frozen = retained(first, ref)
  assert(frozen.text.includes('EARLIER_SUMMARY'))
  assert(frozen.text.includes('"representation":"summary"'))
  await summary('UPDATED_SUMMARY: count is three; inspect readiness.')
  const second = await project(f, 150000)
  const shown = current(second, ref)
  assert.equal(retained(second, ref).text, frozen.text)
  assert(
    shown.text.includes('UPDATED_SUMMARY'),
    'Same raw value identity cannot hide changed interpretation'
  )
  assert(shown.text.includes('"representation":"summary"'))
  assertNoInternalProof(second)
})

test('INV-69 identical body bytes under another result identity receive their own history delivery', async (t) => {
  const f = await fixture(t)
  const value = 'SAME_BYTES_DIFFERENT_RESULT\n'.repeat(25)
  const firstRef = await archive(f, [{ value }])
  const first = await project(f, 600000, true)
  const frozen = retained(first, firstRef)
  const secondRef = await archive(f, [{ value }])
  const second = await project(f, 150000)
  assert.equal(retained(second, firstRef).text, frozen.text)
  assert(
    retained(second, secondRef).text.includes(value),
    'A different result must actually deliver its own body'
  )
  assert.notEqual(secondRef.id, firstRef.id)
  assertNoInternalProof(second)
})

test('INV-69 history excluded from the current request cannot suppress a previously delivered body', async (t) => {
  const f = await fixture(t)
  const value = 'RETAIN_WHEN_HISTORY_IS_ABSENT\n'.repeat(30)
  const ref = await archive(f, [
    { value },
    { value: 'Reference companion', options: { view: { mode: 'reference' } } },
  ])
  const first = await project(f, 600000, true)
  assert(retained(first, ref).text.includes(value))
  const memory = new ContextMemory(
    's',
    f.session.context,
    f.storage,
    f.session.view,
    f.programs,
    f.recent,
    { recentRecords: 0 }
  )
  const second = await memory.project(f.view, undefined, [], signal, 150000)
  assert(!retained(second, ref))
  assert(
    current(second, ref).text.includes(value),
    'Old frozen proof is not evidence in a history-free request'
  )
  assert.equal(current(second, ref).bodyInHistory, undefined)
  assertNoInternalProof(second)
})

test('INV-69 equal page text with different ranges cannot prove full original delivery', async (t) => {
  const f = await fixture(t)
  const value = '0123456789'.repeat(1000)
  const original = await archive(f, [
    { value, options: { required: true } },
    { value: 'INITIAL_ANCHOR' },
  ])
  const first = await project(f, 6000, true)
  assert(retained(first, original)?.bodyIncluded)
  assert(JSON.parse(first.body).partitions.runtime.decision.missing.length)
  const firstPage = await f.memory.readMaterial(original, 0, 100, signal, '/output/blocks/0/value')
  const secondPage = await f.memory.readMaterial(
    original,
    100,
    100,
    signal,
    '/output/blocks/0/value'
  )
  assert.equal(firstPage.text, secondPage.text)
  assert.notEqual(firstPage.offset, secondPage.offset)
  assert(firstPage.delivery?.receipt && secondPage.delivery?.receipt)
  const carrier = await archive(f, [{ value: firstPage }, { value: secondPage }])
  const after = await project(f, 600000)
  assert(retained(after, carrier).text.includes('"offset":0'))
  assert(retained(after, carrier).text.includes('"offset":100'))
  assert(
    current(after, original).text.includes(value),
    'Two incomplete equal-text pages do not cover the whole source'
  )
  assertNoInternalProof(after)
})

test('INV-69 a newly available full block cannot be hidden by an older reference-only display', async (t) => {
  const f = await fixture(t)
  const stable = 'OLDER_DELIVERED_BLOCK\n'.repeat(10)
  const added = 'NEWLY_AVAILABLE_BODY\n'.repeat(160)
  const ref = await archive(f, [{ value: stable }, { value: added }])
  const first = await project(f, 3000, true)
  const frozen = retained(first, ref)
  assert(frozen.text.includes(stable))
  assert(!frozen.text.includes('NEWLY_AVAILABLE_BODY'))
  const second = await project(f, 150000)
  const shown = current(second, ref)
  assert.equal(retained(second, ref).text, frozen.text)
  assert(shown.text.includes(added), 'Newly delivered block body must remain in the request')
  assert(!shown.text.includes(stable), 'The older companion can be deduplicated independently')
  assertNoInternalProof(second)
})

test('INV-69 legacy frozen history without per-block delivery evidence remains conservative', async (t) => {
  const f = await fixture(t)
  const value = 'LEGACY_BODY_WITHOUT_VIEW_PROOF\n'.repeat(20)
  const ref = await archive(f, [
    { value },
    { value: 'Legacy reference', options: { view: { mode: 'reference' } } },
  ])
  const first = await project(f, 600000, true)
  const frozen = retained(first, ref)
  const segment = await f.recent.segment(signal)
  const entry = segment.entries.find((item) => item.ref === ref.id)
  assert(entry.outputViews?.length)
  const legacyEntry = { ...entry }
  delete legacyEntry.outputViews
  await f.recent.commit(
    { ...segment, entries: segment.entries.map((item) => (item === entry ? legacyEntry : item)) },
    signal
  )
  const second = await project(f, 30000)
  assert.equal(retained(second, ref).text, frozen.text)
  assert(
    current(second, ref).text.includes(value),
    'An older artifact cannot acquire an invented per-block proof'
  )
  assertNoInternalProof(second)
})

test('INV-69 body deduplication preserves collection diagnostics and reference metadata', async (t) => {
  const f = await fixture(t)
  const value = 'DELIVERED_BODY_WITH_DIAGNOSTIC\n'.repeat(20)
  const ref = await archive(
    f,
    [{ value }, { value: 'Unshown attachment', options: { view: { mode: 'reference' } } }],
    40000,
    ['SYNTHETIC_CAPTURE_BOUNDARY']
  )
  const first = await project(f, 600000, true)
  const frozen = retained(first, ref)
  assert(frozen.text.includes(value))
  const second = await project(f, 150000)
  const shown = current(second, ref)
  assert(!shown.text.includes(value))
  assert(shown.text.includes('SYNTHETIC_CAPTURE_BOUNDARY'))
  assert(shown.text.includes('"pointer":"/output/blocks/1/value"'))
  assert(shown.text.includes('"reason":"source-policy"'))
  assertNoInternalProof(second)
})
