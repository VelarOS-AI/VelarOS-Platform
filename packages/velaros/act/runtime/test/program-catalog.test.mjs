import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { AppError } from '@velaros-ai/core/error'
import { codeProgramChecker, nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'

const request = (operation, input, caught = false) => ({
  source: caught
    ? `import {${operation}} from 'velaros:programs';let result;try {result=await ${operation}(${JSON.stringify(input)})}catch(error){result={error:{code:error.code,message:error.message}}}export default result;`
    : `import {${operation}} from 'velaros:programs';export default await ${operation}(${JSON.stringify(input)});`,
})
const valid = (receipt) => {
  assert.equal(receipt.checked, true, JSON.stringify(receipt))
  assert.equal(receipt.result.failed, undefined, JSON.stringify(receipt))
  return receipt.result.value
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'scriptact-program-catalog-'))
  const f = { writes: 0, runs: 0, modules: [], checks: 0 }
  const module = {
    binding: { moduleId: 'test:catalog', instanceId: 'one', generation: 1, schemaRevision: '1' },
    summary: 'parameterized catalog proof',
    operations: {
      add: {
        summary: 'add exact input',
        input: { type: 'integer' },
        output: { type: 'integer' },
        effects: 'write',
        run(input) {
          f.writes++
          return input + 1
        },
      },
    },
  }
  f.modules = [module]
  const runner = {
    run(...args) {
      f.runs++
      return nodeSubprocessCodeRunner.run(...args)
    },
  }
  const open = async () => {
    f.storage = localContextStorage({ path: join(root, 'state.sqlite') })
    f.runtime = await createRuntime({
      storage: f.storage,
      runner,
      modules: f.modules,
      context: { maintenance: false },
      agents: false,
      search: false,
      memory: false,
    })
    f.session = await f.runtime.openSession('s')
    if (!(await f.storage.load('s'))?.records.some((record) => record.kind === 'user'))
      await f.session.context.append({
        kind: 'user',
        body: 'Publish and use parameterized programs for this task.',
      })
    f.programs = new ProgramContext('s', f.session.context, f.storage, {
      async validate(program) {
        f.checks++
        const checked = codeProgramChecker.check({ ...program, granted: [] })
        if (!checked.ok) throw new AppError('VALIDATION', 'fixture source invalid')
        return []
      },
      async unchanged() {
        return true
      },
    })
  }
  await open()
  f.restart = async (modules = f.modules) => {
    await f.runtime.close()
    f.modules = modules
    await open()
  }
  t.after(async () => {
    await f.runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  return f
}

test('INV-81 default model programs surface publishes without executing then reuses immutable source with fresh inputs and receipts', async (t) => {
  const f = await fixture(t)
  const publication = {
    name: 'increase',
    purpose: 'Increment supplied parameter',
    inputDescription: '{value:number}',
    source:
      "import {input} from 'velaros:program';import {add} from './lib/step.js';export default await add(input.value);",
    modules: {
      'lib/step.js': "export {add} from 'test:catalog';",
      'unused.js': "import {secret} from 'test:ungranted';export default secret;",
    },
  }
  const first = valid(await f.session.execute(request('publish', publication)))
  assert.equal(f.writes, 0)
  assert.equal(first.revision, 1)
  assert.deepEqual(
    first.dependencies.map((binding) => binding.moduleId),
    ['test:catalog']
  )
  assert.equal(first.dependencies[0].generation, 1)
  const before = f.runs
  const described = valid(await f.session.execute(request('describe', { name: 'increase' })))
  assert.equal(described.sourceRef, first.sourceRef)
  assert.equal(f.runs, before + 1, 'directory query only runs the querying script')
  for (const value of [4, 19])
    assert.equal(
      valid(await f.session.execute({ sourceRef: first.sourceRef, input: { value } })),
      value + 1
    )
  assert.equal(f.writes, 2)
  const second = valid(
    await f.session.execute(
      request('publish', { ...publication, purpose: 'Updated documentation', baseRevision: 1 })
    )
  )
  assert.equal(second.revision, 2)
  assert.equal(second.contentRevision, first.contentRevision)
  assert.notEqual(second.sourceRef, first.sourceRef)
  const old = valid(await f.session.execute(request('describe', { sourceRef: first.sourceRef })))
  assert.equal(old.revision, 1)
  assert.equal(valid(await f.session.execute({ sourceRef: old.sourceRef, input: { value: 7 } })), 8)
  const duplicate = valid(await f.session.execute(request('publish', publication, true)))
  assert.equal(duplicate.error.code, 'CONFLICT')
  assert.equal(
    valid(await f.session.execute(request('describe', { name: 'increase' }))).sourceRef,
    second.sourceRef
  )
})

test('INV-81 malformed and unauthorized publication keep old alias and do not execute user programs', async (t) => {
  const f = await fixture(t)
  const first = valid(
    await f.session.execute(
      request('publish', {
        name: 'stable',
        purpose: 'Stable pure program',
        source: 'export default 1;',
      })
    )
  )
  for (const source of [
    'export default (',
    "import {secret} from 'test:ungranted';export default secret;",
  ]) {
    const failed = valid(
      await f.session.execute(
        request(
          'publish',
          { name: 'stable', baseRevision: 1, purpose: 'Invalid candidate', source },
          true
        )
      )
    )
    assert.equal(failed.error.code, 'VALIDATION')
    assert.equal(
      valid(await f.session.execute(request('describe', { name: 'stable' }))).sourceRef,
      first.sourceRef
    )
  }
  assert.equal(f.writes, 0)
})

test('INV-81 concurrent name CAS has one winner; directory query reuses publication checks instead of parsing again', async (t) => {
  const f = await fixture(t)
  const input = { name: 'race', purpose: 'One CAS winner', source: 'export default 1;' }
  const results = await Promise.allSettled([
    f.programs.catalog.publish(input, new AbortController().signal),
    f.programs.catalog.publish(input, new AbortController().signal),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'CONFLICT')
  const checked = f.checks
  const page = await f.programs.catalog.list({}, new AbortController().signal)
  assert.equal(page.items.length, 1)
  assert.equal(f.checks, checked)
  assert.equal(f.runs, 0)
  const invalid = await Promise.allSettled(
    [-1, 0, 65, 1.5].map((limit) =>
      f.programs.catalog.list({ limit }, new AbortController().signal)
    )
  )
  assert.ok(
    invalid.every((result) => result.status === 'rejected' && result.reason.code === 'VALIDATION')
  )
})

test('INV-81 catalog survives restart, respects current permissions and reset, and cannot reactivate old sources via metadata', async (t) => {
  const f = await fixture(t)
  const entry = valid(
    await f.session.execute(
      request('publish', {
        name: 'call',
        purpose: 'Authorized operation',
        source: "import {add} from 'test:catalog';export default await add(3);",
      })
    )
  )
  await f.restart()
  assert.equal(
    valid(await f.session.execute(request('describe', { name: 'call' }))).sourceRef,
    entry.sourceRef
  )
  await f.restart([])
  assert.deepEqual(valid(await f.session.execute(request('list', {}))).items, [])
  await assert.rejects(f.session.execute({ sourceRef: entry.sourceRef }), { code: 'SCRIPT_CHECK' })
  await f.session.context.append({
    kind: 'audit',
    title: 'search:history-reset',
    body: 'reset current authorization scope',
  })
  const old = valid(
    await f.session.execute(request('describe', { sourceRef: entry.sourceRef }, true))
  )
  assert.equal(old.error.code, 'NOT_FOUND')
  const replaced = valid(
    await f.session.execute(
      request('publish', { name: 'call', purpose: 'New reset scope', source: 'export default 2;' })
    )
  )
  assert.equal(replaced.revision, 1)
  assert.notEqual(replaced.sourceRef, entry.sourceRef)
})

test('INV-81 same schema label with changed actual operation contract forces import recheck', async (t) => {
  const f = await fixture(t)
  const entry = valid(
    await f.session.execute(
      request('publish', {
        name: 'binding',
        purpose: 'Follow exact import contract',
        source: "import {add} from 'test:catalog';export default await add(1);",
      })
    )
  )
  await f.restart([
    {
      binding: {
        moduleId: 'test:catalog',
        instanceId: 'replacement',
        generation: 2,
        schemaRevision: '1',
      },
      summary: 'new operation',
      operations: {
        other: {
          summary: 'other',
          input: { type: 'null' },
          output: { type: 'null' },
          effects: 'none',
          run: () => null,
        },
      },
    },
  ])
  assert.deepEqual(valid(await f.session.execute(request('list', {}))).items, [])
  assert.equal(
    valid(await f.session.execute(request('describe', { sourceRef: entry.sourceRef }, true))).error
      .code,
    'NOT_FOUND'
  )
})
