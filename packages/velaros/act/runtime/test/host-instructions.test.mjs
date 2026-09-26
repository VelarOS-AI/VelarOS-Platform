import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createRuntime } from '../../../dist/act/runtime/index.js'
import { frameEnvironment } from '../../../dist/act/runtime/utils/environment.js'

import { done } from './support/model-turn.mjs'

const driver = (stream) => ({
  id: 'instructions-test',
  limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
  estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
  stream,
})
async function fixture(t, options) {
  const dataDir = await mkdtemp(join(tmpdir(), 'runtime-instructions-'))
  const runtime = await createRuntime({
    dataDir,
    agents: false,
    search: false,
    memory: false,
    context: { maintenance: false },
    ...options,
  })
  t.after(async () => {
    await runtime.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return { runtime, dataDir, session: await runtime.openSession('main') }
}

test('INV-43 trusted host instructions reach actual requests and traces; reopen uses current product settings', async (t) => {
  const frames = []
  const model = driver(async function* (request) {
    frames.push(request)
    yield* done(request)
  })
  const f = await fixture(t, { model, instructions: 'host-language-first' })
  const events = []
  for await (const event of f.session.submit('user-text-only')) events.push(event)
  assert.match(frames[0].instructions, /host-language-first/)
  assert.match(frames[0].compiledPrompt, /当前帧标记/)
  const turn = events.find((event) => event.type === 'turn')
  const trace = await f.session.trace(turn.turnId)
  assert.match(trace.request.body, /host-language-first/)
  await f.runtime.close()
  const reopened = await createRuntime({
    dataDir: f.dataDir,
    model,
    instructions: 'host-language-second',
    agents: false,
    search: false,
    memory: false,
    context: { maintenance: false },
  })
  try {
    const session = await reopened.openSession('main')
    for await (const event of session.submit('next user text')) assert.notEqual(event.type, 'error')
    assert.match(frames.at(-1).instructions, /host-language-second/)
    assert.doesNotMatch(frames.at(-1).instructions, /host-language-first/)
  } finally {
    await reopened.close()
  }
})

test('host instructions are budgeted before the provider is called', async (t) => {
  let calls = 0
  const estimates = []
  const model = {
    ...driver(async function* (request) {
      calls++
      yield* done(request)
    }),
    estimate: async (request) => {
      estimates.push(request.instructions)
      return {
        tokens: request.instructions.includes('large-host-setting') ? 200000 : 1000,
        precision: 'exact',
        basis: 'instruction-sensitive',
      }
    },
  }
  const f = await fixture(t, { model, instructions: 'large-host-setting' })
  const events = []
  for await (const event of f.session.submit('small user input')) events.push(event)
  assert.equal(calls, 0)
  assert(estimates.some((text) => text.includes('large-host-setting')))
  assert.equal(events.at(-1).status, 'context_blocked')
})

test('repair requests retain host instructions without accepting malformed responses', async (t) => {
  const frames = []
  const f = await fixture(t, {
    instructions: 'host-repair-setting',
    model: driver(async function* (request) {
      frames.push(request)
      if (frames.length === 1) {
        yield { type: 'text', text: 'missing frame control' }
        yield { type: 'finish', reason: 'stop' }
      } else yield* done(request)
    }),
  })
  const events = []
  for await (const event of f.session.submit('answer')) events.push(event)
  assert.equal(events.at(-1).status, 'completed')
  assert(events.some((event) => event.type === 'rejected'))
  assert(frames.length >= 2)
  assert(frames.every((frame) => frame.instructions.includes('host-repair-setting')))
})

test('invalid host instruction configuration is rejected before runtime activation', async () => {
  await assert.rejects(createRuntime({ instructions: { text: 'invalid' } }), /instructions/)
})

test('resident modules put their full contract into the instructions so the model can skip describe', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-resident-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const frames = []
  const model = driver(async function* (request) {
    frames.push(request)
    yield* done(request)
  })
  const f = await fixture(t, {
    model,
    workspace,
    residentModules: ['velaros:project', 'velaros:not-mounted'],
  })
  for await (const event of f.session.submit('read the readme'))
    assert.notEqual(event.type, 'error')
  const declarations = f.runtime.describe('velaros:project').declarations
  assert.match(frames[0].instructions, /常驻模块 velaros:project 的声明/)
  assert.ok(frames[0].instructions.includes(declarations))
  assert.doesNotMatch(frames[0].instructions, /velaros:not-mounted/)
})

test('INV-57 the instructions list every other importable module with its one-line summary', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-importable-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const frames = []
  const model = driver(async function* (request) {
    frames.push(request)
    yield* done(request)
  })
  const f = await fixture(t, {
    model,
    workspace,
    project: { code: true, images: true },
    residentModules: ['velaros:project'],
  })
  for await (const event of f.session.submit('where is greet defined'))
    assert.notEqual(event.type, 'error')
  const index = /本会话还能直接 import 这些模块[^\n]*/u.exec(frames[0].instructions)?.[0]
  assert.ok(index, frames[0].instructions)
  // 一句简介取自模块声明开头那段说明的第一句
  assert.match(
    index,
    /velaros:code（问代码，而不是自己读文件猜：定义在哪、谁在用它、改了波及谁、这个文件报什么错）/
  )
  assert.match(index, /velaros:images（看图：把 PNG、JPEG、GIF、WebP 交到你眼前）/)
  // 常驻的已经整份附在文末，velaros:system 的成员从 velaros:system 导入，都不再列
  assert.doesNotMatch(index, /velaros:project|velaros:modules|velaros:system/)
  // 模块目录的卡片也是这句简介，不是模块名本身
  assert.equal(
    f.runtime.describe('velaros:images').summary,
    '看图：把 PNG、JPEG、GIF、WebP 交到你眼前。'
  )
})

test('resident modules must be a list of module names', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'runtime-resident-invalid-'))
  try {
    await assert.rejects(
      createRuntime({ dataDir, residentModules: 'velaros:project', agents: false, search: false }),
      { code: 'VALIDATION' }
    )
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('every frame carries the local clock and host environment entries in runtime.environment', async (t) => {
  const frames = []
  const f = await fixture(t, {
    model: driver(async function* (request) {
      frames.push(request)
      yield* done(request)
    }),
    environment: () => ({ os: 'macOS 26.3.1 (arm64)', time: 'host-cannot-override' }),
  })
  for await (const event of f.session.submit('what time is it'))
    assert.notEqual(event.type, 'error')
  const environment = JSON.parse(frames[0].materials[0].text).partitions.runtime.environment
  assert.equal(environment.os, 'macOS 26.3.1 (arm64)')
  assert.match(environment.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  assert(Math.abs(Date.parse(environment.time) - Date.now()) < 60_000)
  assert.match(environment.localTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z][a-z]+day$/)
  assert.equal(environment.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone)
  assert.match(frames[0].instructions, /runtime\.environment/)
})

test('a failing host environment drops only its own entries and the run goes on', async (t) => {
  const frames = []
  const f = await fixture(t, {
    model: driver(async function* (request) {
      frames.push(request)
      yield* done(request)
    }),
    environment: () => {
      throw new Error('probe failed')
    },
  })
  const events = []
  for await (const event of f.session.submit('answer')) events.push(event)
  assert.equal(events.at(-1).status, 'completed')
  const environment = JSON.parse(frames[0].materials[0].text).partitions.runtime.environment
  assert.deepEqual(Object.keys(environment).sort(), ['localTime', 'time', 'timezone'])
})

test('environment must be a function returning host entries', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'runtime-environment-invalid-'))
  try {
    await assert.rejects(
      createRuntime({ dataDir, environment: { os: 'macOS' }, agents: false, search: false }),
      { code: 'VALIDATION' }
    )
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('the frame clock writes the zone offset and weekday of the host time zone', () => {
  const zone = process.env.TZ
  const instant = new Date('2026-09-24T18:11:57Z')
  try {
    for (const [tz, time, localTime] of [
      ['Asia/Shanghai', '2026-09-25T02:11:57+08:00', '2026-09-25 02:11:57 Friday'],
      ['America/New_York', '2026-09-24T14:11:57-04:00', '2026-09-24 14:11:57 Thursday'],
      ['Asia/Kolkata', '2026-09-24T23:41:57+05:30', '2026-09-24 23:41:57 Thursday'],
    ]) {
      process.env.TZ = tz
      // ICU 可能给出同一时区的规范别名（Asia/Kolkata → Asia/Calcutta），时区名以它为准
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      assert.deepEqual(frameEnvironment(undefined, instant), { time, localTime, timezone })
    }
  } finally {
    if (typeof zone === 'string') process.env.TZ = zone
    else delete process.env.TZ
  }
})
