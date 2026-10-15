import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { freezeRuntimeCompletion, runtimeCompletionOptions } from './runtime-completion.mjs'

async function fixture(t, source = '') {
  const root = await mkdtemp(join(tmpdir(), 'velaros-review-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const module = join(root, 'source.mjs')
  await writeFile(module, source)
  return { root, config: { module, exportName: 'WorkspaceArtifacts' } }
}

test('frozen host adapter reads the assigned workspace without following later source edits', async (t) => {
  const { root, config } = await fixture(
    t,
    `import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
export class WorkspaceArtifacts {
  constructor(root) { this.root=root }
  async capture(identities) {
    return Promise.all(identities.map(async identity => ({identity,text:await readFile(join(this.root,identity.slice(5)),'utf8')})))
  }
}`
  )
  const frozen = await freezeRuntimeCompletion(config, root)
  await writeFile(join(root, 'actual.txt'), 'actual workspace artifact')
  await writeFile(config.module, 'throw new Error("the source must no longer be imported")')
  const completion = await runtimeCompletionOptions(frozen, root)
  assert.equal(completion.kind, 'model-review')
  assert.deepEqual(await completion.artifacts.capture(['file:actual.txt']), [
    { identity: 'file:actual.txt', text: 'actual workspace artifact' },
  ])
  assert.match(await readFile(frozen.module, 'utf8'), /class WorkspaceArtifacts/u)
  await assert.rejects(freezeRuntimeCompletion(config, root), { code: 'EEXIST' })
})

test('changed frozen bytes fail before importing or constructing the adapter', async (t) => {
  const { root, config } = await fixture(t, 'export class WorkspaceArtifacts {capture(){}}')
  const frozen = await freezeRuntimeCompletion(config, root)
  await writeFile(frozen.module, 'throw new Error("unverified import executed")')
  await assert.rejects(runtimeCompletionOptions(frozen, root), /Completion adapter changed/u)
})

test('invalid adapter contracts fail before model dispatch', async (t) => {
  for (const source of ['export const unrelated=1', 'export class WorkspaceArtifacts {}']) {
    const { root, config } = await fixture(t, source)
    const frozen = await freezeRuntimeCompletion(config, root)
    await assert.rejects(runtimeCompletionOptions(frozen, root), /adapter/u)
  }
  await assert.rejects(
    freezeRuntimeCompletion({ module: 'relative.mjs', exportName: 'Adapter' }, '/tmp'),
    /absolute path/u
  )
})

test('historical configurations retain their recorded completion coverage', async () => {
  assert.equal(await freezeRuntimeCompletion(undefined, '/unused'), undefined)
  assert.equal(await runtimeCompletionOptions(undefined, '/unused'), undefined)
})

test('validation mode is frozen explicitly and uses the same artifact authority', async (t) => {
  const { root, config } = await fixture(t, 'export class WorkspaceArtifacts {capture(){}}')
  const frozen = await freezeRuntimeCompletion({ ...config, validation: 'node-isolated' }, root)
  assert.equal(frozen.validation, 'node-isolated')
  await assert.rejects(runtimeCompletionOptions(frozen, root), /lacks/u)
  const signal = new AbortController().signal
  let options
  const port = { execute() {} }
  const completion = await runtimeCompletionOptions(frozen, root, {
    executable: process.execPath,
    signal,
    createValidationHost(value) {
      options = value
      return port
    },
  })
  assert.equal(completion.validation, port)
  assert.equal(options.artifacts, completion.artifacts)
  assert.equal(options.workspace, root)
  assert.equal(options.executable, process.execPath)
  assert.equal(options.signal, signal)
})

test('unknown validation contracts fail before freezing executable capabilities', async (t) => {
  const { root, config } = await fixture(t, 'export class WorkspaceArtifacts {capture(){}}')
  await assert.rejects(
    freezeRuntimeCompletion({ ...config, validation: 'unrestricted' }, root),
    /Unknown/u
  )
})

test('evidence discovery is explicitly frozen and historical configurations remain unchanged', async (t) => {
  for (const discoverEvidence of [undefined, false, true]) {
    const { root, config } = await fixture(t, 'export class WorkspaceArtifacts {capture(){}}')
    const frozen = await freezeRuntimeCompletion({ ...config, discoverEvidence }, root)
    const completion = await runtimeCompletionOptions(frozen, root)
    assert.equal(completion.discoverEvidence, discoverEvidence)
    assert.equal(Object.hasOwn(frozen, 'discoverEvidence'), discoverEvidence !== undefined)
  }
  const { root, config } = await fixture(t, 'export class WorkspaceArtifacts {capture(){}}')
  await assert.rejects(
    freezeRuntimeCompletion({ ...config, discoverEvidence: 'true' }, root),
    /discovery/u
  )
})

test('counterexample review freezes its opt-in and requires the isolated host before dispatch', async (t) => {
  for (const counterexampleReview of [undefined, false, true]) {
    const { root, config } = await fixture(t, 'export class WorkspaceArtifacts {capture(){}}')
    const frozen = await freezeRuntimeCompletion(
      { ...config, counterexampleReview, validation: 'node-isolated' },
      root
    )
    const port = { execute() {} }
    const completion = await runtimeCompletionOptions(frozen, root, {
      executable: process.execPath,
      createValidationHost: () => port,
    })
    assert.equal(completion.counterexampleReview, counterexampleReview)
    assert.equal(completion.validation, port)
    assert.equal(Object.hasOwn(frozen, 'counterexampleReview'), counterexampleReview !== undefined)
    await assert.rejects(
      runtimeCompletionOptions(
        { ...frozen, validation: undefined, counterexampleReview: true },
        root
      ),
      /requires isolated/u
    )
  }
  const { root, config } = await fixture(t, 'export class WorkspaceArtifacts {capture(){}}')
  await assert.rejects(
    freezeRuntimeCompletion({ ...config, counterexampleReview: 'true' }, root),
    /configuration/u
  )
  await assert.rejects(
    freezeRuntimeCompletion({ ...config, counterexampleReview: true }, root),
    /requires isolated/u
  )
})
