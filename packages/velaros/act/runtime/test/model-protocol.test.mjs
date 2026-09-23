import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'

import { done, marker, turn } from './support/model-turn.mjs'

const write = { execute: { source: "import {write} from 'test:world';await write();" } }
const finish = { type: 'finish', reason: 'stop' }
for (const [name, events] of [
  [
    'duplicate completion',
    (request) => [
      { type: 'text', text: `${marker(request)} done\n${marker(request)} done()` },
      finish,
    ],
  ],
  ['output after finish', (request) => [finish, turn(request, write)]],
  ['no output', () => [finish]],
  ['narration without control', () => [{ type: 'text', text: 'Continue working.' }, finish]],
  ['no finish', (request) => [turn(request, write)]],
  ['truncated output', (request) => [turn(request, write), { type: 'finish', reason: 'length' }]],
  [
    'provider failure after output',
    (request) => [
      turn(request, write),
      { type: 'error', code: 'provider', message: 'lost stream' },
    ],
  ],
  ['wrong program schema', (request) => [turn(request, { execute: { source: 123 } }), finish]],
  [
    'unclosed later block',
    (request) => [
      turn(request, write),
      { type: 'text', text: `\n${marker(request)} execute\noutput(1);` },
      finish,
    ],
  ],
  [
    'unrecognized event',
    () => [{ type: 'call', id: 'unexpected', name: 'script', input: write }, finish],
  ],
  [
    'invalid finish reason',
    (request) => [turn(request, write), { type: 'finish', reason: 'tool-call' }],
  ],
  [
    'unexpected object output',
    () => [{ type: 'output', value: { execute: write.execute } }, finish],
  ],
])
  test(`invalid ${name} cannot dispatch, accept a turn or consume a result lease`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'model-protocol-'))
    const storage = localContextStorage({ path: join(root, 'state.sqlite') })
    let writes = 0
    const model = {
      id: 'protocol',
      limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4000 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
      async *stream(request) {
        yield* events(request)
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
            instanceId: 'one',
            generation: 1,
            schemaRevision: '1',
          },
          summary: 'write target',
          operations: {
            write: {
              summary: 'count',
              input: { type: 'null' },
              output: { type: 'null' },
              effects: 'write',
              run: () => {
                writes++
                return null
              },
            },
          },
        },
      ],
    })
    t.after(async () => {
      await runtime.close()
      await rm(root, { recursive: true, force: true })
    })
    const session = await runtime.openSession('s')
    await session.context.append({ kind: 'user', body: 'Keep the result and inspect.' })
    await session.execute({ source: "import {output} from 'velaros';output('leased');" })
    const programs = new ProgramContext('s', session.context, storage)
    const before = await programs.state()
    const recordsBefore = (await storage.load('s')).records
    const received = []
    for await (const event of session.submit('Continue')) received.push(event)
    assert.equal(received.at(-1).status, 'failed', JSON.stringify(received))
    assert.equal(writes, 0)
    if (name !== 'narration without control')
      assert.equal(received.filter((x) => x.type === 'text').length, 0)
    const after = await programs.state()
    assert.equal(after.completedTurns, before.completedTurns)
    assert.deepEqual(after.leases, before.leases)
    const added = (await storage.load('s')).records.filter(
      (x) => !recordsBefore.some((old) => old.ref.id === x.ref.id)
    )
    assert(!added.some((x) => x.kind === 'assistant' || x.title.startsWith('script:control:')))
  })

for (const scenario of ['recover', 'exhaust', 'cancel'])
  test(`transient model retry ${scenario} preserves attempts without dispatching partial scripts`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'model-retry-'))
    const storage = localContextStorage({ path: join(root, 'state.sqlite') })
    let calls = 0
    let writes = 0
    const controller = new AbortController()
    const model = {
      id: 'retry',
      limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4000 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
      async *stream(request) {
        calls++
        if (scenario === 'recover' && calls === 2) {
          yield* done(request, 'retry accepted')
          return
        }
        yield turn(request, write)
        yield {
          type: 'error',
          code: 'provider',
          message: 'connection reset',
          retryAfterMs: scenario === 'cancel' ? 10000 : 0,
        }
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
            instanceId: 'one',
            generation: 1,
            schemaRevision: '1',
          },
          summary: 'write target',
          operations: {
            write: {
              summary: 'count',
              input: { type: 'null' },
              output: { type: 'null' },
              effects: 'write',
              run: () => {
                writes++
                return null
              },
            },
          },
        },
      ],
    })
    t.after(async () => {
      await runtime.close()
      await rm(root, { recursive: true, force: true })
    })
    const session = await runtime.openSession('s')
    const events = []
    for await (const event of session.submit('Finish without writing', controller.signal)) {
      events.push(event)
      if (scenario === 'cancel' && event.type === 'rejected') controller.abort()
    }
    assert.equal(writes, 0)
    assert.equal(calls, scenario === 'recover' ? 2 : scenario === 'exhaust' ? 3 : 1)
    assert.equal(
      events.at(-1).status,
      scenario === 'recover' ? 'completed' : scenario === 'exhaust' ? 'failed' : 'cancelled'
    )
    const trace = await runtime.trace('s', { maxChars: 1000000 })
    assert.equal(trace.turns.length, calls)
    assert.equal(
      trace.turns.filter((turn) => JSON.parse(turn.decision.body).status === 'rejected').length,
      scenario === 'recover' ? 1 : calls
    )
  })
