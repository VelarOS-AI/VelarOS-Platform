import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { createRuntime } from '../../../dist/act/runtime/index.js'
import { createProjectContextSource, createProjectKernel } from '../../../dist/project/index.js'

import { modelText } from './support/model-turn.mjs'
import { runtimeFrame } from './support/model-turn.mjs'
import { done, turn } from './support/model-turn.mjs'

const object = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
})
const intent = {
  kind: 'direct',
  target: { kind: 'resource', sourceId: 'project', resourceId: 'a.txt' },
  purpose: 'verify latest edit',
}
const observeCode = `import {read} from 'test:project';import {output} from 'velaros';output(await read());`
async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dual-core-project-'))
  await writeFile(join(root, 'a.txt'), 'version one\n')
  const project = await createProjectKernel({ root })
  const source = createProjectContextSource({ id: 'project', kernel: project })
  let writes = 0
  const module = {
    binding: {
      moduleId: 'test:project',
      instanceId: 'project',
      generation: 1,
      schemaRevision: '1',
    },
    summary: 'real project fixture',
    operations: {
      read: {
        summary: 'read real text and version',
        input: { type: 'null' },
        output: object({ text: { type: 'string' }, revision: { type: 'string' } }),
        effects: 'none',
        run: async () => {
          const r = await project.read({ path: 'a.txt' })
          return { text: r.content, revision: r.snapshot.revision }
        },
      },
      write: {
        summary: 'edit with expected revision',
        input: object({ revision: { type: 'string' }, text: { type: 'string' } }),
        output: { type: 'object' },
        effects: 'write',
        prepare: async (input) => {
          await project.read({ path: 'a.txt', baseRevision: input.revision })
          return input
        },
        run: async (input, call) => {
          const current = await project.read({ path: 'a.txt', baseRevision: input.revision })
          const tx = await project.prepareEdit({
            operations: [
              {
                operation: {
                  type: 'replace_content',
                  path: 'a.txt',
                  expectedContent: current.content,
                  content: input.text,
                },
              },
            ],
          })
          const result = await project.applyEdit({ transactionId: tx.transactionId })
          writes++
          call.recordEffect('committed')
          return { transactionId: result.transactionId, newRevisions: result.newRevisions }
        },
      },
      fail: {
        summary: 'fail without effect',
        input: { type: 'null' },
        output: { type: 'null' },
        effects: 'write',
        run: (_input, call) => {
          call.recordEffect('none')
          throw Error('expected failure')
        },
      },
      uncertain: {
        summary: 'unknown outcome',
        input: { type: 'null' },
        output: { type: 'null' },
        effects: 'write',
        run: () => {
          writes++
          throw Error('network response lost')
        },
      },
    },
  }
  const path = join(root, 'context.sqlite')
  const options = {
    storage: localContextStorage({ path }),
    runner: nodeSubprocessCodeRunner,
    modules: [module],
    context: { sources: [source] },
    ...extra,
  }
  if (extra.context) options.context = { ...options.context, sources: [source], ...extra.context }
  const runtime = await createRuntime(options)
  t.after(async () => {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    project,
    source,
    path,
    options,
    runtime,
    get writes() {
      return writes
    },
  }
}
async function taskSession(f) {
  const session = await f.runtime.openSession('s')
  await session.context.append({
    kind: 'user',
    body: 'Upgrade version one to version two and verify it.',
  })
  return session
}
function ok(result) {
  assert.equal(result.checked, true, JSON.stringify(result))
  assert.equal(result.result.failed, undefined, JSON.stringify(result))
}
const limits = {
  turns: 8,
  outputTokens: 2000,
  safetyTokens: 500,
  projectionChars: 30000,
  recoveryChars: 4000,
  timeoutMs: 20000,
}
function driver(turn) {
  return {
    id: 'deterministic-driver',
    limits: { contextTokens: 100000, inputTokens: 95000, outputTokens: 4000 },
    estimate: async (request) => ({
      tokens: Math.ceil(JSON.stringify(request).length / 3),
      precision: 'estimate',
      basis: 'test only',
    }),
    stream: turn,
  }
}

test('A13: a noncooperative model estimator cannot hold the session beyond its deadline', async (t) => {
  const model = driver(async function* () {
    yield { type: 'error', message: 'must not send' }
    assert.fail('must not send')
  })
  model.estimate = () => new Promise(() => {})
  const f = await fixture(t, { model, limits: { ...limits, timeoutMs: 50 } })
  const s = await f.runtime.openSession('s')
  const events = []
  for await (const event of s.submit('Inspect only')) events.push(event)
  assert.equal(events.at(-1).status, 'cancelled')
  assert.equal(f.writes, 0)
  assert.equal((await s.view.inspect()).lease, null)
})

test('v1 to v2: stable observation refreshes after a real write and SQLite restart', async (t) => {
  const frames = []
  const f = await fixture(t, {
    model: driver(async function* (request) {
      frames.push(runtimeFrame(request))
      yield* done(request)
    }),
  })
  const session = await taskSession(f)
  const observer = await session.observe({ source: observeCode })
  const result = await session.execute({
    source: `import {read,write} from 'test:project';const old=await read();await write({revision:old.revision,text:'version two\\n'});`,
  })
  ok(result)
  for await (const event of session.submit('Verify v2')) {
    assert.equal(typeof event.type, 'string')
  }
  assert.equal(f.writes, 1)
  assert.match(frames[0].observation.text, /version two/)
  assert.equal(frames[0].observation.sourceRef, observer.sourceRef)
  await f.runtime.close()
  const restarted = await createRuntime({
    ...f.options,
    storage: localContextStorage({ path: f.path }),
  })
  try {
    const restored = await restarted.openSession('s')
    for await (const event of restored.submit('Check again')) {
      assert.equal(typeof event.type, 'string')
    }
    assert.match(frames[1].observation.text, /version two/)
    assert.equal(f.writes, 1)
  } finally {
    await restarted.close()
  }
})

test('Phase 2: main model receives the compiled v2 view with independent verification state', async (t) => {
  let calls = 0
  let lastRequest
  const model = driver(async function* (request) {
    calls++
    lastRequest = request
    assert.equal(typeof modelText(request), 'string')
    if (calls === 1) {
      yield turn(request, {
        execute: {
          source: `import {read,write} from 'test:project';const old=await read();await write({revision:old.revision,text:'version two\\n'});`,
        },
      })
      yield { type: 'usage', inputTokens: 100, outputTokens: 50 }
      yield { type: 'finish', reason: 'stop' }
      return
    }
    const view = runtimeFrame(request)
    assert.match(view.observation.text, /version two/)
    yield* done(request, 'Changed; no independent verifier configured.')
  })
  const f = await fixture(t, { model, limits })
  const session = await f.runtime.openSession('s')
  await session.observe({ source: observeCode })
  const events = []
  for await (const event of session.submit('Update and inspect')) events.push(event)
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  assert.equal(events.find((x) => x.type === 'verification').verified, false)
  assert.equal(f.writes, 1)
  assert.equal(calls, 2)
  const usage = (await session.view.inspect()).usage
  assert.equal(usage.mainCalls, 2)
  assert.equal(usage.contextCalls, 0)
  assert.equal(usage.unmeasuredCalls, 1)
  assert(lastRequest.compiledPrompt.includes('runtime-view'))
})

test('A06: changed decision evidence blocks a stale write with no new effects', async (t) => {
  const f = await fixture(t)
  const s = await taskSession(f)
  await s.view.begin((await s.context.inspect()).protected[0])
  await s.view.startStep('read-evidence')
  await s.view.request(intent)
  await s.view.settle([])
  await s.view.build({ maxChars: 30000 })
  await s.view.end()
  await writeFile(join(f.root, 'a.txt'), 'external newer content\n')
  const result = await s.execute({
    source: `import {read,write} from 'test:project';const fresh=await read();await write({revision:fresh.revision,text:'should not overwrite'});`,
  })
  assert(result.result?.failed)
  assert.equal(f.writes, 0)
  assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'external newer content\n')
  assert(
    (await s.view.inspect()).mandatory.some((x) => x.code === 'STALE_VIEW' && x.effect === 'none')
  )
})

test('A14/A24: caught errors and partial progress remain in the next view without ViewIntent', async (t) => {
  const f = await fixture(t)
  const s = await taskSession(f)
  const result = await s.execute({
    source: `import {read,write,fail} from 'test:project';const x=await read();await write({revision:x.revision,text:'committed\\n'});try{await fail();}catch{};`,
  })
  ok(result)
  const view = (await s.view.inspect()).view
  assert(
    view.mandatory.some((x) => x.operation === 'test:project.write' && x.effect === 'committed')
  )
  assert(view.mandatory.some((x) => x.operation === 'test:project.fail' && x.outcome === 'failed'))
  assert.equal(f.writes, 1)
  assert.equal(view.goals.length, 1)
})

test('A15: lost outcome is persisted and a new script cannot replay it', async (t) => {
  const f = await fixture(t)
  const s = await taskSession(f)
  await s.execute({ source: `import {uncertain} from 'test:project';await uncertain();` })
  assert.equal((await s.view.inspect()).status, 'needs-reconcile')
  await assert.rejects(
    s.execute({ source: `import {uncertain} from 'test:project';await uncertain();` }),
    /核对/
  )
  assert.equal(f.writes, 1)
})

test('A01/A28: project source resolves symbols, preserves UTF-16 and rejects binary or out-of-root targets', async (t) => {
  const f = await fixture(t)
  const signal = new AbortController().signal
  const scope = { sessionId: 's', revision: 1 }
  await writeFile(
    join(f.root, 'sample.ts'),
    'export function selected() { return 42; }\nexport function unrelated() { return 7; }\n'
  )
  const target = {
    kind: 'resource',
    sourceId: 'project',
    resourceId: 'sample.ts',
    selector: { kind: 'symbol', name: 'selected' },
  }
  const read = await f.source.read(
    scope,
    target,
    'definition',
    { kind: 'after-step' },
    10000,
    signal
  )
  assert(read.text.includes('return 42'))
  assert(!read.text.includes('unrelated'))
  assert.equal(read.complete, true)
  await writeFile(
    join(f.root, 'utf16.txt'),
    Buffer.concat([Buffer.from([255, 254]), Buffer.from('汉字\n', 'utf16le')])
  )
  assert.equal(
    (
      await f.source.read(
        scope,
        { ...target, resourceId: 'utf16.txt', selector: undefined },
        'full',
        { kind: 'after-step' },
        10000,
        signal
      )
    ).text,
    '汉字\n'
  )
  await writeFile(join(f.root, 'binary.bin'), Buffer.from([0, 1, 2, 0, 4, 5]))
  await assert.rejects(
    f.source.read(
      scope,
      { ...target, resourceId: 'binary.bin', selector: undefined },
      'full',
      { kind: 'after-step' },
      10000,
      signal
    ),
    { code: 'UNSUPPORTED_MEDIA' }
  )
  assert.equal(
    await f.source.authorize(scope, { ...target, resourceId: '../../outside' }, signal),
    false
  )
  await symlink(tmpdir(), join(f.root, 'outside-link'))
  assert.equal(
    await f.source.authorize(scope, { ...target, resourceId: 'outside-link/anything' }, signal),
    false
  )
})

test('Phase 4: domain reconciliation appends durable proof without reissuing an unknown write', async (t) => {
  const f = await fixture(t)
  const s = await taskSession(f)
  await s.execute({ source: `import {uncertain} from 'test:project';await uncertain();` })
  f.options.modules[0].operations.uncertain.reconcile = async () => ({
    outcome: 'succeeded',
    effect: 'committed',
    evidence: 'remote idempotency record confirms one write',
  })
  await f.runtime.close()
  const runtime = await createRuntime({
    ...f.options,
    storage: localContextStorage({ path: f.path }),
  })
  try {
    const resumed = await runtime.openSession('s')
    await resumed.reconcile()
    assert.equal((await resumed.view.inspect()).status, 'context-pending')
    assert((await resumed.view.inspect()).mandatory.some((x) => x.code === 'RECONCILED'))
    ok(await resumed.execute({ source: observeCode }))
    assert.equal(f.writes, 1)
  } finally {
    await runtime.close()
  }
})

test('A15: actual process death after a world write recovers from the prepared journal without replay', async (t) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const f = await fixture(t)
  const target = join(f.root, 'external-count.txt')
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [new URL('./crash-dispatch.fixture.mjs', import.meta.url).pathname, f.path, target],
      { timeout: 10000 }
    ),
    (error) => error.code === 91
  )
  assert.equal(await readFile(target, 'utf8'), '1')
  await f.runtime.close()
  const module = {
    binding: { moduleId: 'test:crash', instanceId: 'one', generation: 1, schemaRevision: '1' },
    summary: 'recovery',
    operations: {
      send: {
        summary: 'sent operation',
        input: { type: 'null' },
        output: { type: 'null' },
        effects: 'write',
        run: () => {
          throw Error('must not replay')
        },
        reconcile: async () => ({
          outcome: 'succeeded',
          effect: 'committed',
          evidence: `external count is ${await readFile(target, 'utf8')}`,
        }),
      },
    },
  }
  const resumed = await createRuntime({
    ...f.options,
    storage: localContextStorage({ path: f.path }),
    modules: [module],
  })
  try {
    const s = await resumed.openSession('crashed')
    const task = await s.view.inspect()
    assert.equal(task.status, 'executing')
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, task.lease.expiresAt - Date.now() + 5))
    )
    await s.reconcile()
    assert.equal((await s.view.inspect()).status, 'context-pending')
    assert.equal((await s.view.inspect()).mandatory[0].code, 'RECONCILED')
    ok(
      await s.execute({
        source: `import {output} from 'velaros';output('continue after reconciliation');`,
      })
    )
    assert.equal(await readFile(target, 'utf8'), '1')
  } finally {
    await resumed.close()
  }
})

test('A03/A20: a 5MB artifact reference survives runtime closure and storage reopen', async (t) => {
  const f = await fixture(t)
  const s = await taskSession(f)
  const ref = await (async () => {
    const user = (await s.context.inspect()).protected[0]
    await s.view.begin(user)
    await s.view.startStep('large-artifact')
    const ref = await s.view.putArtifact('a'.repeat(5 * 1024 * 1024))
    await s.view.settle([])
    await s.view.build({ maxChars: 12000 })
    return ref
  })()
  await f.runtime.close()
  const resumed = await createRuntime({
    ...f.options,
    storage: localContextStorage({ path: f.path }),
  })
  try {
    const session = await resumed.openSession('s')
    assert.equal(
      (await session.view.readArtifact(ref, { offset: 5 * 1024 * 1024 - 10, limit: 10 })).text,
      'aaaaaaaaaa'
    )
    assert.equal((await session.view.inspect()).artifacts[0].id, ref.id)
  } finally {
    await resumed.close()
  }
})

test('A24: malformed model response fails before acceptance, script dispatch or lease consumption', async (t) => {
  let calls = 0
  const model = driver(async function* (request) {
    calls++
    yield turn(request, { execute: { source: 123 } })
    yield { type: 'finish', reason: 'stop' }
  })
  const f = await fixture(t, { model, limits })
  const s = await f.runtime.openSession('s')
  const events = []
  for await (const e of s.submit('Fix invalid syntax safely')) events.push(e)
  assert.equal(events.at(-1).status, 'failed', JSON.stringify(events))
  assert.equal(f.writes, 0)
  assert.equal(calls, 3)
  const records = (await f.options.storage.load('s')).records
  assert(!records.some((x) => x.kind === 'assistant' || x.title.startsWith('script:control:')))
})

test('A16: cancellation keeps its terminal state when an already dispatched operation finishes late', async (t) => {
  let started
  let release
  const dispatched = new Promise((resolve) => {
    started = resolve
  })
  const late = {
    binding: { moduleId: 'test:late', instanceId: 'one', generation: 1, schemaRevision: '1' },
    summary: 'late effect',
    operations: {
      write: {
        summary: 'wait then commit',
        input: { type: 'null' },
        output: { type: 'null' },
        effects: 'write',
        run: async (_input, call) => {
          started()
          await new Promise((resolve) => {
            release = resolve
          })
          call.recordEffect('committed')
          return null
        },
      },
    },
  }
  const model = driver(async function* (request) {
    yield turn(request, { execute: { source: "import {write} from 'test:late';await write();" } })
    yield { type: 'finish', reason: 'stop' }
  })
  const f = await fixture(t, { model, limits, modules: [late] })
  const s = await f.runtime.openSession('s')
  const controller = new AbortController()
  const events = []
  const running = (async () => {
    for await (const e of s.submit('Do one write', controller.signal)) events.push(e)
  })()
  await dispatched
  controller.abort()
  await running
  assert.equal((await s.view.inspect()).status, 'cancelled')
  release()
  await new Promise((resolve) => setTimeout(resolve, 30))
  await s.reconcile()
  assert.equal((await s.view.inspect()).status, 'cancelled')
  assert(
    (await s.view.inspect()).mandatory.some(
      (x) => x.operation === 'test:late.write' && x.effect === 'committed'
    )
  )
})
