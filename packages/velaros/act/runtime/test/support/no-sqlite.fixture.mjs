import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBuiltinModule } from 'node:process'

import { localContextStorage } from '@velaros-ai/context/node'

import { done, modelText, turn } from './model-turn.mjs'
import { withProjectFixture } from './project-fixture.mjs'
import { createTestRuntime as createRuntime } from './runtime-fixture.mjs'

assert.equal(getBuiltinModule('node:sqlite'), undefined, 'SQLite must actually be disabled')
assert.throws(() => localContextStorage({ path: ':memory:' }), { code: 'STORAGE_UNAVAILABLE' })
const root = await mkdtemp(join(tmpdir(), 'runtime-no-sqlite-'))
const workspace = join(root, 'project')
const dataDir = join(root, 'data')
const pending = new Map()
let requestId = 0
let closes = 0
function request(method, connection, args = []) {
  return new Promise((resolve, reject) => {
    if (!process.connected) return reject(new Error('ContextStorage host disconnected'))
    const id = ++requestId
    pending.set(id, { resolve, reject })
    process.send({ channel: 'context-storage', id, connection, method, args }, (error) => {
      if (!error) return
      pending.delete(id)
      reject(error)
    })
  })
}
function receive(reply) {
  if (reply.channel !== 'context-storage') return
  const waiter = pending.get(reply.id)
  if (!waiter) return
  pending.delete(reply.id)
  if (reply.error) waiter.reject(Object.assign(new Error(reply.error.message), reply.error))
  else waiter.resolve(reply.value)
}
function disconnected() {
  for (const waiter of pending.values())
    waiter.reject(new Error('ContextStorage host disconnected'))
  pending.clear()
}
process.on('message', receive)
process.on('disconnect', disconnected)
const backend = {
  get closes() {
    return closes
  },
  async open() {
    const { connection, methods } = await request('open')
    return Object.fromEntries(
      methods.map((method) => [
        method,
        async (...args) => {
          const value = await request(method, connection, args)
          if (method === 'close') closes++
          return value
        },
      ])
    )
  },
}
let runtime
let calls = 0
const platformHasDefaultConfinement = process.platform === 'darwin' || process.platform === 'linux'
try {
  await mkdir(workspace)
  await writeFile(join(workspace, 'value.txt'), 'one\n')
  const model = {
    id: 'contract-test',
    limits: { contextTokens: 150000, inputTokens: 140000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
    async *stream(request) {
      if (++calls === 1) {
        yield turn(request, {
          execute: {
            source:
              "import {output} from 'velaros';import {commit} from 'velaros:project';await commit({changes:[{path:'value.txt',oldText:'one',newText:'two'}]});output('saved');",
          },
          observe: {
            source:
              "import {output} from 'velaros';import {inspect} from 'velaros:project';output(await inspect({}));",
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else {
        assert.equal(
          await readFile(join(workspace, 'value.txt'), 'utf8'),
          'two\n',
          modelText(request)
        )
        const observation = JSON.parse(request.materials[0].text).partitions.observation
        assert.match(
          observation.text,
          platformHasDefaultConfinement ? /two/ : /SHELL_CONFINEMENT_UNAVAILABLE/
        )
        yield* done(request, 'verified version two')
      }
    },
  }
  runtime = await createRuntime(
    await withProjectFixture(
      { storage: await backend.open(), model, context: { maintenance: false } },
      { root: workspace }
    ),
    { cwd: workspace }
  )
  const session = await runtime.openSession('main')
  const events = []
  for await (const event of session.submit('Change one to two, then observe the current file.'))
    events.push(event)
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  assert.equal(calls, 2)
  assert.equal(await readFile(join(workspace, 'value.txt'), 'utf8'), 'two\n')
  const state = await session.view.inspect()
  assert.match(JSON.stringify(state), /two/)
  const trace = await runtime.trace('main')
  assert.equal(trace.turns.length, 2)
  await runtime.close()
  await runtime.close()
  assert.equal(backend.closes, 1)
  const storage = await backend.open()
  const persisted = await storage.load('main')
  assert(persisted.records.some((record) => record.kind === 'user'))
  runtime = await createRuntime(await withProjectFixture({ storage }, { root: workspace }), {
    cwd: workspace,
  })
  const restored = await runtime.openSession('main')
  assert.equal((await restored.view.inspect()).view.progress.step, state.view.progress.step)
  await assert.rejects(readFile(join(dataDir, 'context.sqlite')), { code: 'ENOENT' })
  await runtime.close()
  assert.equal(backend.closes, 2)
  console.info(
    'SQLite disabled: real Act loop, Project edit, observation contract, trace and restored session passed'
  )
} finally {
  await runtime?.close()
  await rm(root, { recursive: true, force: true })
  assert.equal(pending.size, 0, 'Storage requests must drain before the IPC connection closes')
  process.off('message', receive)
  process.off('disconnect', disconnected)
  if (process.connected) process.disconnect()
}
