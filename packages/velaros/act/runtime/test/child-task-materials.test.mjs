import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { ContextLimits, createContextRuntime, createContextView } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'

import { ChildTaskMaterials } from '../../../dist/act/runtime/impl/ChildTaskMaterials.js'
import { createNodeExecutionEnvironment, createRuntime } from '../../../dist/act/runtime/index.js'
import { ActRuntimeTuning } from '../../../dist/act/runtime/utils/tuning.js'
import { createLocalShellHost } from '../../../dist/execution/local.js'

import { modelText } from './support/model-turn.mjs'

const model = (stream) => ({
  id: 'parent-material-fixture',
  nativeTools: true,
  limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4000 },
  estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
  stream,
})
const call = (code, id = 'execute') => ({
  type: 'tool-call',
  value: { id, name: 'exec', input: { code } },
})
const environment = (request) =>
  JSON.parse(request.materials.find((item) => item.origin === 'runtime-view').text).partitions
    .runtime.environment

async function storedTask(t, text = 'current requirement') {
  const root = await mkdtemp(join(tmpdir(), 'velaros-task-snapshot-'))
  const storage = localContextStorage({ path: ':memory:' })
  const context = createContextRuntime({ sessionId: 'parent', storage })
  const input = await context.ingest({ text })
  const view = createContextView({ sessionId: 'parent', storage, context, sources: [] })
  await view.begin(input.ref)
  const materials = new ChildTaskMaterials(storage, root)
  t.after(async () => {
    await materials.close()
    await storage.close()
    await rm(root, { recursive: true, force: true })
  })
  const job = {
    id: 'child',
    parentSessionId: 'parent',
    parentTaskId: (await view.inspect()).id,
    sessionId: 'child-session',
    profile: 'worker',
    status: 'running',
  }
  return { root, storage, context, input, view, materials, job }
}

test('large archived input is fully streamed through page and storage boundaries with exact Unicode and provenance', async (t) => {
  const text = `${'a'.repeat(ContextLimits.readChars - 1)}😀${'中'.repeat(
    ContextLimits.objectChars - ContextLimits.readChars - 2
  )}🧭\nfinal requirement`
  const f = await storedTask(t, text)
  const controller = new AbortController()
  const result = await f.materials.open(f.job, controller.signal)
  const goal = result.snapshot.goals[0]
  assert.equal(await readFile(goal.path, 'utf8'), text)
  assert.equal(goal.chars, text.length)
  assert.equal(goal.sha256, createHash('sha256').update(text).digest('hex'))
  assert.equal(goal.objectId, f.input.objectId)
  assert.deepEqual(goal.ref, f.input.ref)
  assert.equal(result.snapshot.parentTaskId, f.job.parentTaskId)
  await assert.rejects(f.materials.open(f.job, controller.signal), { code: 'CONFLICT' })
})

test('stale task identity cannot export a new task and leaves no files', async (t) => {
  const f = await storedTask(t)
  await assert.rejects(
    f.materials.open({ ...f.job, parentTaskId: 'earlier-task' }, new AbortController().signal),
    { code: 'CONFLICT' }
  )
  assert.deepEqual(await readdir(f.root), [])
})

test('parent input previews share a bounded budget, retain later corrections and point to full Unicode originals', async (t) => {
  const first = `${'初始约束 😀'.repeat(2400)} ORIGINAL_TAIL`
  const f = await storedTask(t, first)
  const correction = '使用新的 JSON 格式，保留业务 API。'
  const input = await f.context.ingest({ text: correction })
  await f.view.appendGoal(input.ref)
  const result = await f.materials.open(f.job, new AbortController().signal)
  assert.equal(typeof result.preview, 'string')
  assert(result.preview.length <= ActRuntimeTuning.parentTaskPreviewChars)
  assert(result.preview.includes('初始约束'))
  assert(result.preview.includes(correction))
  assert(result.preview.includes('原文未完'))
  assert(!result.preview.includes('ORIGINAL_TAIL'))
  assert(!result.preview.includes('\uFFFD'))
  assert.equal(Buffer.from(result.preview).toString('utf8'), result.preview)
  assert(result.preview.indexOf('初始约束') < result.preview.indexOf(correction))
  for (const source of result.snapshot.goals) assert(result.preview.includes(source.path))
  assert.equal(await readFile(result.snapshot.goals[0].path, 'utf8'), first)
  assert.equal(await readFile(result.snapshot.goals[1].path, 'utf8'), correction)
})

test('a preview ending inside a surrogate pair always retains whole characters', async (t) => {
  for (const prefix of ['', 'a']) {
    const f = await storedTask(t, prefix + '😀'.repeat(6000))
    const result = await f.materials.open(f.job, new AbortController().signal)
    assert(result.preview.length <= ActRuntimeTuning.parentTaskPreviewChars)
    assert(result.preview.includes('😀'))
    assert(result.preview.includes('原文未完'))
    assert.equal(Buffer.from(result.preview).toString('utf8'), result.preview)
  }
})

test('cancellation while reading and missing input objects clean up the partial snapshot', async (t) => {
  for (const failure of ['cancel', 'missing']) {
    const f = await storedTask(t)
    const controller = new AbortController()
    const get = f.storage.get.bind(f.storage)
    t.mock.method(f.storage, 'get', async (session, id) => {
      if (id === f.input.objectId) {
        if (failure === 'cancel') controller.abort()
        else return null
      }
      return get(session, id)
    })
    await assert.rejects(f.materials.open(f.job, controller.signal))
    assert.deepEqual(await readdir(f.root), [])
  }
})

test('task replacement during export rejects the stale snapshot and cleans its files', async (t) => {
  const f = await storedTask(t)
  const load = f.storage.load.bind(f.storage)
  let loads = 0
  t.mock.method(f.storage, 'load', async (session) => {
    const value = await load(session)
    if (++loads > 1 && value?.task) return { ...value, task: { ...value.task, id: 'replacement' } }
    return value
  })
  await assert.rejects(f.materials.open(f.job, new AbortController().signal), { code: 'CONFLICT' })
  assert.deepEqual(await readdir(f.root), [])
})

test('attachments cannot smuggle another session into the exported input', async (t) => {
  const f = await storedTask(t)
  const foreign = createContextRuntime({ sessionId: 'other', storage: f.storage })
  const secret = await foreign.append({ kind: 'note', body: 'other-session-secret' })
  const invalid = await f.context.append({
    kind: 'user',
    title: 'user:manifest',
    body: JSON.stringify({
      chars: 0,
      chunks: [],
      files: [{ ref: secret.ref, name: 'secret', mediaType: 'text/plain' }],
    }),
  })
  const state = await f.storage.load('parent')
  await f.storage.compareAndSwap('parent', state.version, {
    ...state,
    version: state.version + 1,
    task: { ...state.task, goals: [invalid.ref] },
  })
  await assert.rejects(f.materials.open(f.job, new AbortController().signal), {
    code: 'PERMISSION',
  })
  assert.deepEqual(await readdir(f.root), [])
})

test('Node child reads original parent inputs and attachments from ordinary files and refreshes them on resume', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'velaros-parent-materials-'))
  await mkdir(join(root, 'workspace'))
  const shell = createLocalShellHost({
    cwd: join(root, 'workspace'),
    processConfinement: { mode: 'workspace-write', workspaceRoot: join(root, 'workspace') },
  })
  const node = createNodeExecutionEnvironment({
    cwd: join(root, 'workspace'),
    directory: join(root, 'runs'),
    host: shell,
  })
  const storage = localContextStorage({ path: ':memory:' })
  const manifests = []
  const paths = []
  const initialRequests = []
  let mainCalls = 0
  let childCalls = 0
  let childSession
  const original = 'Implement the assigned work. Preserve the public API and verify Unicode 数据.'
  const correction = 'The output format must be JSON. Verify cancellation too.'
  const child = model(async function* (request) {
    if (++childCalls % 2 === 1) {
      const file = environment(request).parentTask
      assert.equal(environment(request).custom, childCalls === 1 ? 'inherited' : undefined)
      assert.equal(typeof file, 'string', 'the host must expose the original parent task file')
      paths.push(file)
      const manifest = JSON.parse(await readFile(file, 'utf8'))
      childSession = manifest.childSessionId
      manifests.push(manifest)
      assert.equal(manifest.goals.length, childCalls === 1 ? 1 : 2)
      initialRequests.push({ text: modelText(request), instructions: request.instructions })
      assert.equal(await readFile(manifest.goals[0].path, 'utf8'), original)
      assert.equal(await readFile(manifest.goals[0].attachments[0].path, 'utf8'), 'attached-data')
      if (childCalls > 1) assert.equal(await readFile(manifest.goals[1].path, 'utf8'), correction)
      assert(!JSON.stringify(request).includes('previous-task-secret'))
      yield call(
        `import {readFile} from 'node:fs/promises'; const task=JSON.parse(await readFile(${JSON.stringify(file)},'utf8')); console.log(await readFile(task.goals[0].path,'utf8')); console.log(await readFile(task.goals[0].attachments[0].path,'utf8'));`
      )
    } else {
      assert.match(modelText(request), /Preserve the public API/)
      assert.match(modelText(request), /attached-data/)
      yield {
        type: 'tool-call',
        value: {
          id: `child-done-${childCalls}`,
          name: 'done',
          input: { message: 'The assigned work is complete.' },
        },
      }
    }
    yield { type: 'finish', reason: 'stop' }
  })
  const runtime = await createRuntime({
    node,
    storage,
    project: false,
    search: false,
    memory: false,
    context: { maintenance: false },
    environment: () => {
      if (mainCalls >= 4) throw Error('environment unavailable')
      return { custom: 'inherited' }
    },
    agents: {
      concurrency: 1,
      maxChildren: 2,
      profiles: { worker: { model: child, modules: [], node: true } },
    },
    model: model(async function* () {
      mainCalls++
      if (mainCalls === 2)
        yield call(
          "import {start,wait} from 'velaros:agents'; const child=await start({task:'Implement only the parser.',profile:'worker'}); console.log(await wait({id:child.id}));"
        )
      else if (mainCalls === 4)
        yield call(
          `import {resume,wait} from 'velaros:agents'; const child=await resume({id:${JSON.stringify(childSession.split(':').at(-1))},input:'Update the parser for the new requirements.'}); console.log(await wait({id:child.id}));`
        )
      else if (mainCalls === 6)
        yield call(
          "import {start,wait} from 'velaros:agents'; const child=await start({task:'Read an attachment.',profile:'worker',materials:[{sessionId:'other',id:'forged'}]}); console.log(await wait({id:child.id}));"
        )
      else
        yield {
          type: 'tool-call',
          value: { id: `parent-done-${mainCalls}`, name: 'done', input: { message: 'Complete.' } },
        }
      yield { type: 'finish', reason: 'stop' }
    }),
  })
  t.after(async () => {
    await runtime.close()
    await shell.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const parent = await runtime.openSession('parent')
  for await (const event of parent.submit('previous-task-secret'))
    assert.notEqual(event.type, 'error')
  const attachment = await parent.context.append({ kind: 'note', body: 'attached-data' })
  for await (const event of parent.submit({
    task: 'new',
    text: original,
    files: [{ ref: attachment.ref, name: '../../outside.txt', mediaType: 'text/plain' }],
  }))
    assert.notEqual(event.type, 'error')
  assert.equal(childCalls, 2)
  assert(
    initialRequests[0].text.includes(original),
    'the first child request must carry parent requirements'
  )
  assert(initialRequests[0].text.includes('Implement only the parser.'))
  assert(!initialRequests[0].instructions.includes(original), 'parent input remains task data')
  await assert.rejects(readFile(paths[0]), { code: 'ENOENT' })
  for await (const event of parent.submit(correction)) assert.notEqual(event.type, 'error')
  assert.equal(childCalls, 4)
  assert(initialRequests[1].text.includes(original))
  assert(initialRequests[1].text.includes(correction))
  assert(initialRequests[1].text.includes('Update the parser for the new requirements.'))
  assert(!initialRequests[1].instructions.includes(correction))
  assert.notEqual(paths[0], paths[1])
  assert.equal(manifests[0].parentTaskId, manifests[1].parentTaskId)
  assert.equal(dirname(manifests[0].goals[0].path), dirname(paths[0]))
  await assert.rejects(readFile(paths[1]), { code: 'ENOENT' })
  for await (const event of parent.submit('Attempt an invalid material transfer'))
    assert.notEqual(event.type, 'error')
  assert.equal(
    childCalls,
    4,
    'invalid explicit materials must fail before invoking the child model'
  )
  assert(!(await readdir(join(root, 'runs'))).some((name) => name.startsWith('parent-task-')))
})
