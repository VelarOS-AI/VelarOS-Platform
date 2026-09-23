import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { createRuntime, createShellCapabilityModule } from '../../../dist/act/runtime/index.js'
import { createLocalShellHost } from '../../../dist/shell/local.js'

import { runtimeFrame } from './support/model-turn.mjs'
import { done, turn } from './support/model-turn.mjs'

const stop = async function* (request) {
  yield* done(request)
}
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
  await assert.rejects(
    f.session.observe({
      source: `import {execute} from 'velaros:script';await execute({source:${JSON.stringify(write)}});`,
    }),
    { code: 'OBSERVATION_CHECK' }
  )
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
  assert.equal(f.frames[1].results[0].remainingTurns, 2)
})

test(
  'real observation command supports arbitrary Node logic, confines writes and exposes partial protection',
  { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'observe-shell-'))
    const file = join(root, 'value.txt')
    await writeFile(file, 'readable')
    const host = createLocalShellHost({ cwd: root })
    const shell = {
      resolveCwd: async () => root,
      commandPolicy: () => ({ scopeLabel: 'test', riskScope: 'test' }),
      runObservationCommand: host.runObservationCommand.bind(host),
      runCommand: host.runCommand.bind(host),
      listBackgroundTasks: host.listBackgroundTasks.bind(host),
      refreshShellEnvironment: host.refreshShellEnvironment.bind(host),
      terminateBackgroundTask: host.terminateBackgroundTask.bind(host),
    }
    const module = createShellCapabilityModule({
      instanceId: 'shell-test',
      shell,
      approval: {
        awaitConfirmation: async () => {
          throw Error('unexpected approval')
        },
      },
    })
    const f = await fixture(t, stop, { modules: [module] })
    t.after(async () => {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    })
    const cmd = (source) =>
      `${JSON.stringify(process.execPath)} -e '${source.replaceAll("'", "'\\''")}'`
    const code = (command) =>
      `import {output} from 'velaros';import {run} from 'velaros:shell';output(await run({command:${JSON.stringify(command)}}));`
    await f.session.observe({
      source: code(
        cmd(`console.log(require('fs').readFileSync(${JSON.stringify(file)},'utf8').toUpperCase())`)
      ),
    })
    success(await submit(f))
    const result = JSON.parse(f.frames[0].observation.text).value.default
    assert.match(result.stdout, /READABLE/)
    assert.equal(result.confinement.enforcement, 'partial')
    assert.match(result.note, /不能保证/)
    assert(
      f.frames[0].observation.safety.some(
        (item) => item.operation === 'velaros:shell.run' && item.effect === 'unknown'
      )
    )
    const forbidden = join(root, 'forbidden.txt')
    const child = `require('fs').writeFileSync(${JSON.stringify(forbidden)},'unsafe')`
    await f.session.observe({
      source: code(
        cmd(
          `require('child_process').execFileSync(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(child)}])`
        )
      ),
    })
    success(await submit(f))
    assert(!existsSync(forbidden))
    assert.notEqual(JSON.parse(f.frames[1].observation.text).value.default.exitCode, 0)
    ok(await f.session.execute({ source: code(cmd(child)) }))
    assert.equal(await readFile(forbidden, 'utf8'), 'unsafe')
  }
)

test('an unavailable observation command backend never falls back to ordinary execution', async (t) => {
  let executed = 0
  const shell = {
    resolveCwd: async () => '/test',
    runCommand: async () => {
      executed++
      return { stdout: 'unsafe' }
    },
  }
  const module = createShellCapabilityModule({
    instanceId: 'missing-observer',
    shell,
    approval: {},
  })
  const f = await fixture(t, stop, { modules: [module] })
  await f.session.observe({
    source: "import {run} from 'velaros:shell';await run({command:'echo data'});",
  })
  success(await submit(f))
  assert.equal(executed, 0)
  assert.match(f.frames[0].observation.text, /宿主没有提供受限/)
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
  const f = await fixture(t, stop, { modules: [module] })
  ok(await f.session.execute({ source: "import {write} from 'test:uncertain';await write();" }, 1))
  assert.equal((await submit(f)).at(-1).status, 'needs_reconcile')
  assert.equal((await f.state()).leases.length, 0)
  assert.equal((await submit(f)).at(-1).status, 'needs_reconcile')
  assert.equal(f.frames[1].results.length, 0)
  assert(
    f.frames[1].mandatory.some(
      (item) => item.effect === 'unknown' && item.operation === 'test:uncertain.write'
    )
  )
  assert.equal(calls, 1)
})

test('compiler budget recovery reduces excerpts without rerunning observation or consuming an extra round', async (t) => {
  const f = await fixture(t)
  f.model.estimate = async (request) => ({
    tokens: request.materials.reduce((n, x) => n + x.text.length, 0) > 12000 ? 200001 : 1000,
    precision: 'exact',
    basis: 'bounded test window',
  })
  await f.session.observe({ source: observe })
  ok(
    await f.session.execute({ source: "import {output} from 'velaros';output('x'.repeat(30000));" })
  )
  success(await submit(f))
  assert.equal(f.frames.length, 1)
  assert.equal(f.world.reads, 1)
  assert(f.frames[0].results[0].truncated)
  assert(f.frames[0].results[0].text.length < 12000)
  assert.equal((await f.state()).completedTurns, 1)
})

test('caught observation denials remain visible independently of model-selected output', async (t) => {
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
