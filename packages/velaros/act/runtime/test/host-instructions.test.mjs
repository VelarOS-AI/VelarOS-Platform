import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { scriptPackageCompiler } from '@velaros-ai/script'

import { createRuntime } from '../../../dist/act/runtime/index.js'
import { frameEnvironment } from '../../../dist/act/runtime/utils/environment.js'
import { runtimeInstructions } from '../../../dist/act/runtime/utils/model-instructions.js'

import { done, modelText, turn } from './support/model-turn.mjs'

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

test('domain guidance follows granted capabilities in actual noncoding and project requests', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-domain-guidance-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  for (const project of [false, true]) {
    let instructions
    const f = await fixture(t, {
      workspace,
      project,
      model: driver(async function* (request) {
        instructions = request.instructions
        yield* done(request)
      }),
    })
    for await (const event of f.session.submit('请把“今天晴天”翻译成英文。'))
      assert.notEqual(event.type, 'error')
    // 程序增量修改协议也合法使用 oldText；这里只检查领域编辑策略。
    assert.equal(instructions.includes('编辑锚点取自真实读取的原文'), project)
    assert.equal(instructions.includes('受影响调用方'), project)
    assert.doesNotMatch(instructions, /实际 PATH|const \{ stdout, \.\.\.status \}/)
    assert.match(instructions, /(?:完整|总)费用/)
    assert.match(instructions, /unit 为 items/)
    assert.match(instructions, /from > 0/)
    assert.match(instructions, /from \+ shown < total/)
  }
  for (const modules of [
    [],
    ['velaros:files'],
    ['velaros:shell'],
    ['velaros:project', 'velaros:shell'],
  ]) {
    const instructions = runtimeInstructions({ modules, maintain: false, observe: false })
    assert.equal(
      instructions.includes('oldText'),
      modules.includes('velaros:files') || modules.includes('velaros:project')
    )
    assert.equal(instructions.includes('实际 PATH'), modules.includes('velaros:shell'))
    assert.equal(
      instructions.includes('const { stdout, ...status }'),
      modules.includes('velaros:shell')
    )
    assert(!instructions.includes('截断后用 memory.read'))
  }
})

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
  assert.ok(frames[0].instructions.includes('[报告](file:///workspace/report%20final.pdf)'))
  assert.ok(frames[0].instructions.includes('[文档](https://example.com/docs)'))
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
    residentModules: [{ module: 'velaros:project' }, { module: 'velaros:not-mounted' }],
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
    residentModules: [{ module: 'velaros:project' }],
  })
  for await (const event of f.session.submit('where is greet defined'))
    assert.notEqual(event.type, 'error')
  const index = /本会话还能直接 import 这些模块[^\n]*/u.exec(frames[0].instructions)?.[0]
  assert.ok(index, frames[0].instructions)
  // 一句简介取自模块声明开头那段说明的第一句
  assert.match(
    index,
    /velaros:code（问代码，而不是自己读文件猜：定义在哪、谁在用它、改了波及谁、这个文件报什么错，exports: /
  )
  assert.match(index, /velaros:images（看图：把 PNG、JPEG、GIF、WebP 交到你眼前，exports: /)
  assert.match(index, /contentRevision: [a-f0-9]{64}/)
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

test('INV-67 selected resident operations deliver complete generated types and can execute on the first response', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-resident-export-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(join(workspace, 'sample.txt'), 'before\n')
  const frames = []
  const f = await fixture(t, {
    workspace,
    residentModules: [
      { module: 'velaros:project', exports: ['read'] },
      { module: 'velaros:project', exports: ['edit'] },
      { module: 'velaros:project', exports: ['edit'] },
      { module: 'velaros:not-mounted', exports: ['anything'] },
    ],
    model: driver(async function* (request) {
      frames.push(request)
      if (frames.length === 1) {
        yield turn(request, {
          execute: {
            source: `import {read,edit} from 'velaros:project';import {output} from 'velaros';
const change=await edit({steps:[{action:'replace',path:'sample.txt',oldText:'before',newText:'after'}]});
output(change);output(await read({files:[{path:'sample.txt'}]}));`,
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else yield* done(request)
    }),
  })
  const declarations = f.runtime.describe('velaros:project').declarations
  const events = []
  for await (const event of f.session.submit('Change before to after and read the result'))
    events.push(event)
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(frames.length, 2)
  assert.equal(await readFile(join(workspace, 'sample.txt'), 'utf8'), 'after\n')
  assert.match(modelText(frames[1]), /after/)
  const instructions = frames[0].instructions
  const selected = scriptPackageCompiler.sliceExports(declarations, 'velaros:project', [
    'read',
    'edit',
  ])
  assert.ok(instructions.includes(selected.declarations))
  assert.equal(instructions.split('常驻导出 velaros:project（read, edit） 的声明').length - 1, 1)
  assert.doesNotMatch(instructions, /export function (search|inspect|undo)|velaros:not-mounted/)
  assert.match(instructions, /本会话还能直接 import 这些模块[^\n]*velaros:project/)
  assert.equal(frames[1].instructions, instructions)
  const trace = await f.session.trace(events.find((event) => event.type === 'turn').turnId)
  assert.ok(trace.request.body.includes('常驻导出 velaros:project（read, edit）'))
})

test('INV-67 whole resident contracts cover selected duplicates and invalid exports fail before any model request', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-resident-whole-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const frames = []
  const f = await fixture(t, {
    workspace,
    residentModules: [
      { module: 'velaros:project', exports: ['edit'] },
      { module: 'velaros:project' },
      { module: 'velaros:project' },
    ],
    model: driver(async function* (request) {
      frames.push(request)
      yield* done(request)
    }),
  })
  for await (const event of f.session.submit('Ready')) assert.notEqual(event.type, 'error')
  assert.equal(frames[0].instructions.split('常驻模块 velaros:project 的声明').length - 1, 1)
  assert.doesNotMatch(frames[0].instructions, /常驻导出 velaros:project/)
  const invalid = await createRuntime({
    dataDir: join(f.dataDir, 'invalid'),
    workspace,
    agents: false,
    search: false,
    memory: false,
    residentModules: [
      { module: 'velaros:project' },
      { module: 'velaros:project', exports: ['nonexistent'] },
    ],
    model: driver(async function* (request) {
      yield* done(request)
    }),
  })
  try {
    await assert.rejects(invalid.openSession('invalid'), { code: 'VALIDATION' })
  } finally {
    await invalid.close()
  }
})

test('INV-67 invalid selected resident configuration is rejected before activation', async () => {
  for (const value of [
    null,
    3,
    {},
    'velaros:project',
    { module: '', exports: ['edit'] },
    { module: 'velaros:project', exports: [''] },
    { module: 'velaros:project', exports: 'edit' },
    { module: 'velaros:project', exports: [] },
    { module: 'velaros:project', exports: Array(65).fill('edit') },
  ]) {
    await assert.rejects(createRuntime({ residentModules: [value] }), { code: 'VALIDATION' })
  }
})

test('INV-67 selected resident declarations participate in the real request capacity gate', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-resident-budget-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  let calls = 0
  const estimates = []
  const f = await fixture(t, {
    workspace,
    residentModules: [{ module: 'velaros:project', exports: ['edit'] }],
    model: {
      ...driver(async function* (request) {
        calls++
        yield* done(request)
      }),
      estimate: async (request) => {
        estimates.push(request.instructions)
        return {
          tokens: request.instructions.includes('export function edit(') ? 200000 : 1000,
          precision: 'exact',
          basis: 'resident-sensitive',
        }
      },
    },
  })
  const events = []
  for await (const event of f.session.submit('small user input')) events.push(event)
  assert.equal(calls, 0)
  assert(estimates.some((text) => text.includes('export function edit(')))
  assert.equal(events.at(-1).status, 'context_blocked')
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

test('large capability indexes keep complete export names and expose omitted directory entries', () => {
  const modules = [
    'velaros:modules',
    'velaros:system-memory-local',
    ...Array.from({ length: 80 }, (_, id) => `velaros:domain-${id}`),
  ]
  const instructions = runtimeInstructions({
    modules,
    maintain: false,
    observe: false,
    summary: (module) => `${module} 用途说明。`,
    index: () => ({
      exports: ['read', 'write', 'completeExportName'],
      contentRevision: 'a'.repeat(64),
    }),
  })
  const note = instructions
    .split('\n')
    .find((line) => line.startsWith('本会话还能直接 import 这些模块'))
  const entries = [...note.matchAll(/velaros:domain-\d+（[^）]+）/gu)]
  assert(entries.length > 0 && entries.length < 80)
  assert(note.length < 4300, '索引配额包含完整条目；目录说明只有固定额外成本')
  for (const entry of entries) {
    assert(entry[0].includes('exports: read, write, completeExportName'))
    assert(entry[0].includes(`contentRevision: ${'a'.repeat(64)}`))
  }
  assert(note.includes(`另有 ${80 - entries.length} 个模块`))
  assert(note.includes('modules.list() 分页读取完整目录'))
})
