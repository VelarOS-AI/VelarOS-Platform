import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner, scriptOutputs } from '@velaros-ai/script'

import { ContextMemory } from '../../../dist/act/runtime/impl/ContextMemory.js'
import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'
import {
  allocateProgramResultBudgets,
  programCoveredOutputs,
  programOutputViews,
} from '../../../dist/act/runtime/utils/program-context.js'

import { done, runtimeFrame, turn } from './support/model-turn.mjs'

const stop = async function* (request) {
  yield* done(request)
}

test('saved programs and results accept short identities and exact historical identities', async (t) => {
  const f = await fixture(t)
  const programs = new ProgramContext('s', f.session.context, f.storage)
  for (const id of ['01234567', '12345678-1234-4321-8321-123456789abc']) {
    const body = JSON.stringify({ source: 'export default 1' })
    await f.storage.appendRecord('s', {
      ref: { sessionId: 's', id },
      kind: 'audit',
      title: `script:${id}`,
      objectId: await f.storage.put('s', body),
      chars: body.length,
      sources: [],
      createdAt: new Date().toISOString(),
    })
    assert.equal((await programs.readProgram(id)).text, body)
    const result = await f.session.context.append({
      kind: 'audit',
      title: `script:${id}:result`,
      body: 'saved result',
    })
    assert.equal((await programs.read(result.ref.id)).text, 'saved result')
    const falseSource = await f.session.context.append({
      kind: 'audit',
      title: `script:${id}`,
      body: 'another record',
    })
    await assert.rejects(programs.readProgram(falseSource.ref.id), { code: 'SCRIPT_REF' })
  }
})
async function fixture(t, stream = stop, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'program-context-'))
  const path = join(root, 'state.sqlite')
  const world = { value: 1, reads: 0, writes: 0, prepares: 0 }
  const frames = []
  const model = {
    id: 'program-test',
    limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4000 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
    async *stream(request) {
      frames.push(runtimeFrame(request))
      yield* stream(request, frames, world)
    },
  }
  const module = {
    binding: { moduleId: 'test:world', instanceId: 'world', generation: 1, schemaRevision: '1' },
    summary: 'test world',
    operations: {
      read: {
        summary: 'read current value',
        input: { type: 'null' },
        output: { type: 'integer' },
        effects: 'none',
        run: () => {
          world.reads++
          return world.value
        },
      },
      write: {
        summary: 'write value',
        input: { type: 'integer' },
        output: { type: 'integer' },
        effects: 'write',
        prepare: (value) => {
          world.prepares++
          return value
        },
        run: (value) => {
          world.writes++
          world.value = value
          return value
        },
      },
    },
  }
  const options = { runner: nodeSubprocessCodeRunner, model, modules: [module], ...extra }
  let storage = localContextStorage({ path })
  let runtime = await createRuntime({ ...options, storage })
  let session = await runtime.openSession('s')
  await session.context.append({
    kind: 'user',
    body: 'Maintain the counter and inspect current values.',
  })
  const f = {
    world,
    frames,
    model,
    get runtime() {
      return runtime
    },
    get session() {
      return session
    },
    get storage() {
      return storage
    },
    state: async () => {
      const saved = (await storage.load('s')).records.findLast(
        (r) => r.title === 'script:lease-state'
      )
      return saved
        ? JSON.parse(await storage.get('s', saved.objectId))
        : { completedTurns: 0, leases: [] }
    },
    restart: async () => {
      await runtime.close()
      storage = localContextStorage({ path })
      runtime = await createRuntime({ ...options, storage })
      session = await runtime.openSession('s')
    },
  }
  t.after(async () => {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  return f
}
async function submit(f) {
  const events = []
  for await (const event of f.session.submit('Continue')) events.push(event)
  return events
}
function success(events) {
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
}
function ok(result) {
  assert.equal(result.checked, true, JSON.stringify(result))
  assert.equal(result.result.failed, undefined, JSON.stringify(result))
}
const observe =
  "import {output} from 'velaros';import {read} from 'test:world';output({current:await read()});"
const write =
  "import {output} from 'velaros';import {write} from 'test:world';output({written:await write(2)});"

test('INV-58 result demand allocation reuses short shares within the unchanged pool', () => {
  for (const [demands, share] of [
    [[200, 14000, 300], 5000],
    [[12000, 12000, 12000], 4000],
    [[0, 0, 0], 4000],
    [[200, 14000, 300], 0],
    [[600, 200, 600], 300],
  ]) {
    const budgets = allocateProgramResultBudgets(demands, share)
    assert(budgets.every((chars, index) => chars >= 0 && chars <= demands[index]))
    assert(budgets.reduce((sum, chars) => sum + chars, 0) <= share * demands.length)
    if (demands.reduce((sum, chars) => sum + chars, 0) <= share * demands.length)
      assert.deepEqual(budgets, demands)
  }
  assert.deepEqual(allocateProgramResultBudgets([200, 14000, 300], 5000), [200, 14000, 300])
  assert.deepEqual(allocateProgramResultBudgets([12000, 12000, 12000], 4000), [4000, 4000, 4000])
})

test('INV-58 a preferred partial view cannot cover a different final partial view', () => {
  const capture = {
    config: { maxChars: 14000 },
    issues: [],
    blocks: [
      {
        key: 'a',
        value: `${'a'.repeat(24)}\n`.repeat(600),
        options: { key: 'a', type: 'code', view: { maxChars: 1800 } },
      },
      {
        key: 'b',
        value: 'b'.repeat(4500),
        options: { key: 'b', type: 'code', view: { maxChars: 9000 } },
      },
    ].map((block) => ({ ...block, chars: JSON.stringify(block.value).length })),
  }
  const preferred = scriptOutputs.project(
    capture,
    'r',
    14000,
    undefined,
    undefined,
    undefined,
    'text'
  )
  const previous = programOutputViews('s', 'r', 'source', preferred).filter(
    (view) => view.key === 'a'
  )
  const covered = programCoveredOutputs('s', 'r', 'source', preferred, previous)
  assert.equal(covered.length, 1)
  const reduced = scriptOutputs.withoutBodies(preferred, covered)
  for (const assigned of [500, 600]) {
    const final = scriptOutputs.project(
      capture,
      'r',
      assigned + preferred.prompt.length - reduced.prompt.length,
      undefined,
      undefined,
      undefined,
      'text'
    )
    assert.notEqual(
      final.blocks.find((block) => block.key === 'a').text,
      preferred.blocks.find((block) => block.key === 'a').text
    )
    const actualCovered = programCoveredOutputs('s', 'r', 'source', final, previous)
    assert.equal(actualCovered.length, 0, 'key/content hash alone cannot reuse a different range')
    const shown = scriptOutputs.withoutBodies(final, actualCovered, assigned)
    assert(!shown.blocks.some((block) => block.reason === 'body-in-history'))
    assert(shown.prompt.length <= assigned)
  }
})

test('INV-58 short result shares permit a complete batch of real recalled pages without increasing the frame budget', async (t) => {
  const f = await fixture(t)
  const signal = new AbortController().signal
  const programs = new ProgramContext('s', f.session.context, f.storage)
  const recent = new RecentContext('s', f.session.context, f.storage)
  const memory = new ContextMemory(
    's',
    f.session.context,
    f.storage,
    f.session.view,
    programs,
    recent
  )
  const view = {
    id: 'result-demand',
    scope: { sessionId: 's', revision: 0 },
    goals: [],
    capsule: {},
    mandatory: [],
    evidence: [],
    gaps: [],
    readSet: [],
    progress: { step: 0, repeatedSteps: 0, stalled: false, evidence: [] },
  }
  async function archive(values, maxChars, required = false) {
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
          config: maxChars === undefined ? {} : { maxChars },
          issues: [],
          blocks: values.map((value, index) => ({
            key: `block_${index}`,
            value,
            chars: JSON.stringify(value).length,
            options: {
              key: `block_${index}`,
              required,
              ...(maxChars === undefined ? {} : { view: { mode: 'full', maxChars: 12000 } }),
            },
          })),
        },
      }),
    })
    await programs.add(result.ref, source.ref, id, 'task')
    return result.ref
  }
  const values = ['quote"\\path\n界😀'.repeat(220), 'line\r\n'.repeat(600), 'plain'.repeat(720)]
  const original = await archive(values, 512, true)
  const pages = []
  for (const [index] of values.entries())
    pages.push(
      await memory.readMaterial(original, 0, 12000, signal, `/output/blocks/${index}/value`)
    )
  const carrier = await archive(pages, 30000, true)
  const ordinary = await archive(['default line\n'.repeat(4000)], undefined)
  const hidden = await archive(['explicitly hidden'], 0)
  for (let index = 0; index < 20; index++) await archive([{ ok: true, index }], 512)
  const frame = await programs.project(view, undefined, [], signal, 200000)
  const material = JSON.parse(frame.body)
  const shown = material.results.find((result) => result.ref === carrier.id)
  const coverage = frame.outputCoverage.find((result) => result.ref === carrier.id)
  const defaultResult = material.results.find((result) => result.ref === ordinary.id)
  assert(defaultResult.text.length <= frame.budget.excerptChars)
  assert(
    defaultResult.truncated,
    'default output must keep its original conservative per-result cap'
  )
  assert.equal(material.results.find((result) => result.ref === hidden.id).text, '')
  assert(coverage.projection.blocks.every((block) => block.representation === 'full'))
  for (const value of values) assert(shown.text.includes(value))
  assert(shown.text.length > frame.budget.resultBudgetChars)
  assert(
    material.results.reduce((sum, result) => sum + result.text.length, 0) <=
      frame.budget.resultBudgetChars * frame.budget.visibleResults
  )
  assert(!material.decision.missing.some((gap) => gap.ref === carrier.id))
  const actual = await memory.project(view, undefined, [], signal, 200000)
  assert.deepEqual(JSON.parse(actual.body).partitions.runtime.decision.missing, [])
  assert(actual.prompt.length <= 200000)
  assert.equal(f.frames.length, 0, 'projection and memory reads must not invoke a model')
  await memory.acknowledge(JSON.parse(actual.body).frameId, signal)
  const segment = await recent.segment(signal)
  const retained = await programs.project(view, undefined, [], signal, 200000, segment.entries)
  const repeated = JSON.parse(retained.body).results.find((result) => result.ref === carrier.id)
  assert.equal(repeated.bodyInHistory, true)
  for (const value of values) assert(!repeated.text.includes(value))
  const unknown = await programs.project(view, undefined, [], signal, 200000, [])
  const redisplayed = JSON.parse(unknown.body).results.find((result) => result.ref === carrier.id)
  for (const value of values) assert(redisplayed.text.includes(value))
  const mismatched = segment.entries.map((entry) => ({
    ...entry,
    outputViews: entry.outputViews?.map((view) => ({ ...view, fingerprint: 'different-view' })),
  }))
  const changed = await programs.project(view, undefined, [], signal, 200000, mismatched)
  const unproven = JSON.parse(changed.body).results.find((result) => result.ref === carrier.id)
  assert.equal(unproven.bodyInHistory, undefined)
  for (const value of values) assert(unproven.text.includes(value))
})

test('INV-6 stable observation refreshes; one execution result has exactly two successful visible rounds', async (t) => {
  const f = await fixture(t)
  await f.session.observe({ source: observe })
  ok(await f.session.execute({ source: write }))
  const ref = (await f.state()).leases[0].ref
  for (const value of [3, 4, 5]) {
    f.world.value = value
    success(await submit(f))
  }
  assert.equal(f.world.writes, 1)
  assert.equal(f.world.reads, 3)
  assert.deepEqual(
    f.frames.map((v) => v.results.map((r) => r.remainingTurns)),
    [[2], [1], []]
  )
  for (let i = 0; i < 3; i++)
    assert.match(f.frames[i].observation.text, new RegExp(`"current":\\s*${i + 3}`))
  assert(!JSON.stringify(f.frames[2]).includes('"written"'))
  const archived = await f.session.context.read({ sessionId: 's', id: ref })
  assert.match(archived.text, /'written'|"written"/)
  t.diagnostic(
    JSON.stringify({
      kind: 'script-context-lease-trace',
      worldWrites: f.world.writes,
      observationRuns: f.world.reads,
      archivedResultReadable: true,
      frames: f.frames.map((frame) => ({
        completedTurns: frame.programFrame.completedTurns,
        observation: JSON.parse(frame.observation.text).value,
        results: frame.results.map((result) => ({
          ref: result.ref,
          remainingTurns: result.remainingTurns,
        })),
      })),
    })
  )
})

test('INV-10 renewal resets duration without producer replay; archived reads do not renew', async (t) => {
  const f = await fixture(t)
  ok(await f.session.execute({ source: write }))
  const ref = (await f.state()).leases[0].ref
  success(await submit(f))
  success(await submit(f))
  assert.equal((await f.state()).leases.length, 0)
  ok(
    await f.session.execute(
      {
        source: `import {output} from 'velaros';import {memory as results} from 'velaros:system';output(await results.retain({ref:${JSON.stringify(ref)},turns:2}));`,
      },
      1
    )
  )
  assert.equal(f.world.writes, 1)
  assert.equal(
    (await f.state()).leases.find((x) => x.ref === ref).expiresAfter -
      (await f.state()).completedTurns,
    2
  )
  await f.session.observe({
    source: `import {output} from 'velaros';import {memory as results} from 'velaros:system';output((await results.read({ref:${JSON.stringify(ref)}})).text);`,
  })
  success(await submit(f))
  success(await submit(f))
  success(await submit(f))
  assert.equal(f.world.writes, 1)
  assert.equal((await f.state()).leases.length, 0)
  assert.match(f.frames.at(-1).observation.text, /written/)
})

test('observation denies a write before prepare and gives the model a repairable error', async (t) => {
  const f = await fixture(t)
  await f.session.observe({ source: write })
  success(await submit(f))
  assert.equal(f.world.prepares, 0)
  assert.equal(f.world.writes, 0)
  assert.match(f.frames[0].observation.text, /禁止调用/)
  await f.session.observe({ source: observe })
  success(await submit(f))
  assert.match(f.frames[1].observation.text, /current/)
})

test('observation cannot renew leases or nest the system execution entry', async (t) => {
  const f = await fixture(t)
  ok(await f.session.execute({ source: write }))
  const ref = (await f.state()).leases[0].ref
  await f.session.observe({
    source: `import {memory as results} from 'velaros:system';await results.retain({ref:${JSON.stringify(ref)},turns:32});`,
  })
  success(await submit(f))
  assert.match(f.frames[0].observation.text, /不允许调用/)
  assert.equal((await f.state()).leases[0].expiresAfter, 2)
  await f.session.observe({
    source: `import {execute} from 'velaros:script';await execute({source:${JSON.stringify(write)}});`,
  })
  success(await submit(f))
  assert.match(f.frames.at(-1).observation.text, /velaros:script|PERMISSION/)
  assert.equal(f.world.writes, 1)
})

test('failed or truncated model transport neither consumes result lease nor dispatches returned calls', async (t) => {
  for (const reason of ['error', 'length']) {
    const f = await fixture(t, async function* (request) {
      yield turn(request, { execute: { source: write } })
      if (reason === 'error') throw Error('connection reset')
      yield { type: 'finish', reason: 'length' }
    })
    ok(await f.session.execute({ source: write }))
    const events = await submit(f)
    assert.equal(events.at(-1).status, 'failed')
    assert.equal(f.world.writes, 1)
    assert.equal((await f.state()).completedTurns, 0)
    assert.equal((await f.state()).leases[0].expiresAfter, 2)
  }
})

test('invalid observation update prevents paired execution and keeps the prior valid source', async (t) => {
  const f = await fixture(t, async function* (request, frames) {
    assert.equal(request.response.type, 'text')
    if (frames.length === 1) {
      yield turn(request, { observe: { source: 'const = ;' }, execute: { source: write } })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  const installed = await f.session.observe({ source: observe })
  success(await submit(f))
  assert.equal(f.world.writes, 0)
  assert.equal((await f.state()).observation, installed.sourceRef)
  assert.match(f.frames[1].results[0].text, /OBSERVATION_CHECK/)
})

test('observation and remaining leases survive a restart; foreign result refs are rejected', async (t) => {
  const f = await fixture(t)
  await f.session.observe({ source: observe })
  ok(await f.session.execute({ source: write }))
  success(await submit(f))
  const ref = (await f.state()).leases[0].ref
  await f.restart()
  success(await submit(f))
  assert.equal(f.frames[1].results[0].remainingTurns, 1)
  assert.equal(f.world.writes, 1)
  const other = await f.runtime.openSession('other')
  await other.context.append({ kind: 'user', body: 'other task' })
  const result = await other.execute({
    source: `import {memory as results} from 'velaros:system';await results.read({ref:${JSON.stringify(ref)}});`,
  })
  assert(result.result.failed)
})

test('script diff and output diff are independent; failed delivery does not advance the baseline', async (t) => {
  let failed = false
  const f = await fixture(t, async function* (request) {
    if (failed) throw Error('no delivery')
    yield* done(request)
  })
  await f.session.observe({ source: observe })
  success(await submit(f))
  success(await submit(f))
  assert.equal(f.frames[1].progress.script.changed, false)
  assert.equal(f.frames[1].progress.observation.changed, false)
  f.world.value = 9
  failed = true
  await submit(f)
  assert.equal((await f.state()).completedTurns, 2)
  failed = false
  success(await submit(f))
  assert.equal(f.frames[3].progress.script.changed, false)
  assert.equal(f.frames[3].progress.observation.changed, true)
  assert.match(f.frames[3].progress.observation.patch, /\+.*9/)
  await f.session.observe({ source: `${observe}\n// Keep watching current value.` })
  success(await submit(f))
  assert.equal(f.frames[4].progress.script.changed, true)
  assert.equal(f.frames[4].progress.observation.changed, false)
  await f.session.observe({
    source: `${observe}\n// Keep watching current value.`,
    modules: { 'extra.js': 'export default 1;' },
  })
  success(await submit(f))
  assert.equal(f.frames[5].progress.script.changed, true)
  assert.equal(f.frames[5].progress.observation.changed, false)
  assert.match(f.frames[5].progress.script.patch, /extra.js/)
})

test('oversized observation and leased result carry truncation flags and a readable tail', async (t) => {
  const f = await fixture(t)
  const source = "import {output} from 'velaros';output('x'.repeat(30000)+'THE_END');"
  await f.session.observe({ source })
  ok(await f.session.execute({ source }))
  success(await submit(f))
  const frame = f.frames[0]
  assert(frame.observation.truncated)
  assert(frame.results[0].truncated)
  assert(!frame.results[0].text.includes('THE_END'))
  const body = await f.session.context.read(
    { sessionId: 's', id: frame.results[0].ref },
    { offset: frame.results[0].totalChars - 100, limit: 100 }
  )
  assert.match(body.text, /THE_END/)
})

test('ordered observe then execute sees the committed value next round, with one world write', async (t) => {
  const f = await fixture(t, async function* (request, frames) {
    if (frames.length === 1) {
      yield turn(request, { observe: { source: observe }, execute: { source: write } })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  success(await submit(f))
  assert.equal(f.world.writes, 1)
  assert.equal(f.world.reads, 1)
  assert.equal(JSON.parse(f.frames[1].observation.text).value.default.current, 2)
  assert.equal(f.frames[1].results[0].remainingTurns, 'segment')
})

test('an unknown world outcome survives expiration of its ordinary result body', async (t) => {
  let calls = 0
  const module = {
    binding: { moduleId: 'test:uncertain', instanceId: 'one', generation: 1, schemaRevision: '1' },
    summary: 'uncertain',
    operations: {
      write: {
        summary: 'dispatch with unknown outcome',
        input: { type: 'null' },
        output: { type: 'null' },
        effects: 'write',
        run: (_input, ctx) => {
          calls++
          ctx.recordEffect('unknown')
          return null
        },
      },
    },
  }
  const f = await fixture(
    t,
    async function* (request, frames) {
      if (frames.length === 1) {
        yield turn(request, {
          execute: { source: "import {output} from 'velaros';output('next');" },
        })
        yield { type: 'finish', reason: 'stop' }
      } else yield* done(request)
    },
    { modules: [module] }
  )
  ok(await f.session.execute({ source: "import {write} from 'test:uncertain';await write();" }, 1))
  assert.equal((await submit(f)).at(-1).status, 'completed')
  // 第二回合时这次写入的正文租约已经过期，效果不明的事实仍在
  assert(!JSON.stringify(f.frames[1].results).includes('test:uncertain'))
  assert(
    f.frames[1].mandatory.some(
      (item) => item.effect === 'unknown' && item.operation === 'test:uncertain.write'
    )
  )
  assert.equal(calls, 1)
})

test('compiler budget recovery counts history and reduces excerpts without rerunning observation or consuming an extra work round', async (t) => {
  const f = await fixture(t)
  const requests = []
  const stream = f.model.stream
  f.model.stream = async function* (request) {
    requests.push(request)
    yield* stream(request)
  }
  f.model.estimate = async (request) => ({
    tokens:
      request.materials.reduce((n, x) => n + x.text.length, 0) +
        request.history.reduce(
          (n, x) => n + (typeof x.content === 'string' ? x.content.length : 0),
          0
        ) >
      12000
        ? 200001
        : 1000,
    precision: 'exact',
    basis: 'bounded test window',
  })
  await f.session.observe({ source: observe })
  ok(
    await f.session.execute({ source: "import {output} from 'velaros';output('x'.repeat(30000));" })
  )
  success(await submit(f))
  // 自动整理使用独立工具会话；这里验证根会话没有重复业务回合。
  const work = requests.filter((request) => runtimeFrame(request).scope.sessionId === 's')
  assert.equal(work.length, 1)
  assert.equal(f.world.reads, 1)
  const frame = runtimeFrame(work[0])
  assert(frame.results[0].truncated)
  assert((frame.results[0].text ?? '').length < 12000)
  assert.equal((await f.state()).completedTurns, 1)
})

test('INV-61 caught observation denials remain visible independently of model-selected output', async (t) => {
  const f = await fixture(t)
  await f.session.observe({
    source:
      "import {output} from 'velaros';import {write} from 'test:world';try {await write(5)}catch {}output('apparently fine');",
  })
  success(await submit(f))
  assert.equal(f.world.writes, 0)
  assert(f.frames[0].observation.safety.some((item) => item.code === 'OBSERVATION_EFFECT_DENIED'))
})

test('oversized observation updates preserve the installed version and cancellation preserves leases', async (t) => {
  const f = await fixture(t)
  const original = await f.session.observe({ source: observe })
  await assert.rejects(f.session.observe({ source: ' '.repeat(60001) }), { code: 'TOO_LARGE' })
  assert.equal((await f.state()).observation, original.sourceRef)
  ok(await f.session.execute({ source: write }))
  const controller = new AbortController()
  f.model.stream = async function* (request) {
    controller.abort()
    yield* done(request)
  }
  const events = []
  for await (const event of f.session.submit('cancel', controller.signal)) events.push(event)
  assert.equal(events.at(-1).status, 'cancelled')
  assert.equal((await f.state()).completedTurns, 0)
  assert.equal(f.world.writes, 1)
})
