import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBuiltinModule } from 'node:process'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { volatileStorageBackend } from '../../../../../context/test/support/storage-contract.mjs'
import { createRuntime } from '../../../../dist/act/runtime/index.js'

import { done, modelText, turn } from './model-turn.mjs'

assert.equal(getBuiltinModule('node:sqlite'), undefined, 'SQLite must actually be disabled')
assert.throws(() => localContextStorage({ path: ':memory:' }), { code: 'STORAGE_UNAVAILABLE' })
const root = await mkdtemp(join(tmpdir(), 'runtime-no-sqlite-'))
const workspace = join(root, 'project')
const dataDir = join(root, 'data')
const backend = volatileStorageBackend()
let runtime
let calls = 0
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
              "import {output} from 'velaros';import {read,edit} from 'velaros:project';const file=(await read({files:[{path:'value.txt'}]})).files[0];if(file.text!=='one\\n')throw Error('unexpected');await edit({steps:[{action:'replace',path:'value.txt',oldText:'one',newText:'two'}]});output('saved');",
          },
          observe: {
            source:
              "import {output} from 'velaros';import {read} from 'velaros:project';output(await read({files:[{path:'value.txt'}]}));",
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
        assert.match(observation.text, /two/)
        yield* done(request, 'verified version two')
      }
    },
  }
  runtime = await createRuntime({
    runner: nodeSubprocessCodeRunner,
    workspace,
    dataDir,
    storage: await backend.open(),
    model,
    agents: false,
    search: false,
    memory: false,
    context: { maintenance: false },
  })
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
  runtime = await createRuntime({
    runner: nodeSubprocessCodeRunner,
    workspace,
    dataDir,
    storage,
    memory: false,
    agents: false,
    search: false,
  })
  const restored = await runtime.openSession('main')
  assert.equal((await restored.view.inspect()).view.progress.step, state.view.progress.step)
  await assert.rejects(readFile(join(dataDir, 'context.sqlite')), { code: 'ENOENT' })
  await runtime.close()
  assert.equal(backend.closes, 2)
  console.info(
    'SQLite disabled: real Act loop, Project edit, observe, trace and restored session passed'
  )
} finally {
  await runtime?.close()
  await rm(root, { recursive: true, force: true })
}
