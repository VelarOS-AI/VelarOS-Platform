import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'

import { createContextInvocationJournal } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { AppError } from '@velaros-ai/core/error'
import { createOperationRuntime } from '@velaros-ai/kernel'
import {
  codeProgramChecker,
  createKernelScriptSession,
  createNodeCodeRunner,
} from '@velaros-ai/script'

import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { createNodeExecutionEnvironment } from '../../../dist/act/runtime/node.js'
import { createLocalShellHost } from '../../../dist/execution/local.js'

import { createTestRuntime as createRuntime } from './support/runtime-fixture.mjs'

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
  const host = createLocalShellHost({ cwd: root })
  const delegate = createNodeCodeRunner(
    createNodeExecutionEnvironment({
      cwd: root,
      directory: join(root, 'runs'),
      host,
    })
  )
  const f = { root, writes: 0, runs: 0, modules: [], checks: 0, catalogAllowed: true }
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
    environment: delegate.environment,
    cwd: delegate.cwd,
    run(...args) {
      f.runs++
      return delegate.run(...args)
    },
  }
  f.runner = runner
  const open = async () => {
    f.storage = localContextStorage({ path: join(root, 'state.sqlite') })
    f.runtime = await createRuntime({
      storage: f.storage,
      runner,
      modules: f.modules,
      moduleAccess: (_id, moduleId) => moduleId !== 'test:catalog' || f.catalogAllowed,
      context: { maintenance: false },
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
    await host.dispose()
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
  assert.match(first.sourceRef, /^[a-f0-9]{8}$/)
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
    "import {missing} from 'test:catalog';export default missing;",
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

test('INV-81 Node publications preserve native dependencies and validate reachable capability imports without executing', async (t) => {
  const f = await fixture(t)
  const packageRoot = join(f.root, 'node_modules', 'catalog-local')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'catalog-local', type: 'module', exports: './index.mjs' })
  )
  await writeFile(join(packageRoot, 'index.mjs'), 'export const seed=4;')
  await writeFile(join(f.root, 'helper.mjs'), 'export const increment=3;')
  const first = valid(
    await f.session.execute(
      request('publish', {
        name: 'native',
        purpose: 'Use actual Node dependencies',
        source:
          "import {sep} from 'node:path';import {diffLines} from 'velaros:npm/diff';import {seed} from 'catalog-local';import {increment} from './helper.mjs';import {step} from './lib/step.js';export default [await step(seed+increment),sep,diffLines('a\\n','b\\n').length];",
        modules: {
          'lib/step.js': "export {add as step} from 'test:catalog';",
          'unused.js': "import {secret} from 'test:ungranted';export default secret;",
        },
      })
    )
  )
  assert.equal(f.writes, 0)
  assert.deepEqual(
    first.dependencies.map((binding) => binding.moduleId),
    ['test:catalog']
  )
  assert.deepEqual(valid(await f.session.execute({ sourceRef: first.sourceRef })), [8, sep, 2])
  assert.equal(f.writes, 1)
  for (const source of [
    "export {missing as step} from 'test:catalog';",
    "export {secret as step} from 'test:ungranted';",
    'export const step = (',
  ]) {
    const rejected = valid(
      await f.session.execute(
        request(
          'publish',
          {
            name: 'native',
            baseRevision: first.revision,
            purpose: 'Invalid reachable module',
            source: "import {step} from './lib/step.js';export default await step(1);",
            modules: { 'lib/step.js': source },
          },
          true
        )
      )
    )
    assert.equal(rejected.error.code, 'VALIDATION')
    assert.equal(
      valid(await f.session.execute(request('describe', { name: 'native' }))).sourceRef,
      first.sourceRef
    )
    assert.equal(f.writes, 1, 'publication checks never execute the candidate')
  }
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
  f.catalogAllowed = false
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
  await assert.rejects(f.restart([]), { code: 'CONFLICT' })
})

test('INV-81 same schema label with changed actual operation contract forces import recheck', async (t) => {
  const f = await fixture(t)
  const journal = createContextInvocationJournal(f.storage)
  let kernel = createOperationRuntime({ modules: f.modules, journal })
  t.after(() => kernel.drain())
  let checks = 0
  const programs = new ProgramContext('s', f.session.context, f.storage, {
    async unchanged(bindings, signal) {
      signal.throwIfAborted()
      return bindings.every(
        (binding) => JSON.stringify(kernel.bind('s', binding.moduleId)) === JSON.stringify(binding)
      )
    },
    async validate(program, signal) {
      signal.throwIfAborted()
      checks++
      const script = createKernelScriptSession({
        runtime: kernel,
        runner: f.runner,
        allowedModules: ['test:catalog'],
        sessionId: 's',
        executionId: crypto.randomUUID(),
        mode: 'execute',
      })
      if (!script.check(program).ok) throw new AppError('VALIDATION', 'current import rejected')
      return script.dependencies(program)
    },
  })
  const signal = new AbortController().signal
  const entry = await programs.catalog.publish(
    {
      name: 'binding',
      purpose: 'Follow exact import contract',
      source: "import {add} from 'test:catalog';export default await add(1);",
    },
    signal
  )
  assert.equal((await programs.catalog.list({}, signal)).items[0].sourceRef, entry.sourceRef)
  assert.equal(checks, 1, 'unchanged bindings reuse the successful publication check')
  const replacement = [
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
  ]
  await kernel.drain()
  kernel = createOperationRuntime({ modules: replacement, journal })
  assert.deepEqual((await programs.catalog.list({}, signal)).items, [])
  await assert.rejects(programs.catalog.describe({ name: 'binding' }, signal), {
    code: 'NOT_FOUND',
  })
  await assert.rejects(programs.catalog.describe({ sourceRef: entry.sourceRef }, signal), {
    code: 'NOT_FOUND',
  })
  assert.ok(checks > 1, 'the real checker rechecks the changed operation declarations')
  await kernel.drain()
  await assert.rejects(f.restart(replacement), { code: 'CONFLICT' })
  assert.equal(f.runs, 0)
  assert.equal(f.writes, 0)
})

test('INV-81 catalog preserves backend and archive failures while hiding only authorization and import rejections', async (t) => {
  const f = await fixture(t)
  const signal = new AbortController().signal
  const entry = await f.programs.catalog.publish(
    { name: 'fault-boundary', purpose: 'Keep failure facts', source: 'export default 1;' },
    signal
  )
  const source = await f.session.context.read({ sessionId: 's', id: entry.sourceRef }, { limit: 1 })
  const fault = { phase: undefined, error: undefined }
  const storage = new Proxy(f.storage, {
    get(target, key) {
      if (key === 'selectSnapshot')
        return async (sessionId, selections) => {
          if (
            fault.phase === 'snapshot' &&
            selections.some((item) => item.refId === entry.sourceRef)
          )
            throw fault.error
          return target.selectSnapshot(sessionId, selections)
        }
      if (key === 'get')
        return async (sessionId, objectId) => {
          if (objectId === source.record.objectId) {
            if (fault.phase === 'read') throw fault.error
            if (fault.phase === 'json') return '{'
          }
          return target.get(sessionId, objectId)
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const programs = new ProgramContext('s', f.session.context, storage, {
    async unchanged() {
      if (fault.phase === 'unchanged') throw fault.error
      return false
    },
    async validate() {
      if (fault.phase === 'validate') throw fault.error
      return []
    },
  })
  const lookups = [
    () => programs.catalog.list({}, signal),
    () => programs.catalog.describe({ name: entry.name }, signal),
  ]
  for (const [phase, failure] of [
    ['snapshot', new AppError('NOT_FOUND', 'storage segment missing')],
    ['read', new AppError('VALIDATION', 'archive backend corrupt')],
    ['unchanged', new AppError('UNAVAILABLE', 'authorization backend offline')],
    ['validate', new AppError('CLOSED', 'checker runtime closed')],
    ['validate', new TypeError('checker backend fault')],
  ]) {
    Object.assign(fault, { phase, error: failure })
    for (const lookup of lookups) await assert.rejects(lookup, (error) => error === failure)
  }
  fault.phase = 'json'
  for (const lookup of lookups) await assert.rejects(lookup, SyntaxError)
  for (const [phase, codes] of [
    ['unchanged', ['PERMISSION', 'NOT_FOUND']],
    ['validate', ['VALIDATION', 'PERMISSION', 'NOT_FOUND']],
  ])
    for (const code of codes) {
      Object.assign(fault, { phase, error: new AppError(code, 'current import is unavailable') })
      assert.deepEqual(await programs.catalog.list({}, signal), { items: [], nextOffset: null })
      await assert.rejects(lookups[1], { code: 'NOT_FOUND' })
    }
  assert.equal(f.runs, 0)
  assert.equal(f.writes, 0)
})
