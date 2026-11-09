import { spawnSync } from 'node:child_process'

import { expect, test } from 'bun:test'

test('user adapter Promise jobs remain inside the Node VM execution deadline', () => {
  const entry = new URL('../dist/index.js', import.meta.url).href
  const source = `
    import assert from 'node:assert/strict'
    import { createModelRuntimeComposition } from ${JSON.stringify(entry)}

    assert.equal(process.versions.bun, undefined)
    const composition = createModelRuntimeComposition({ providerScripts: { configPaths: [] } })
    const registry = composition.modelAdapterRegistry
    const config = (source) => ({
      provider: 'custom', apiKey: 'fixture-key', baseURL: 'https://fixture.invalid/v1',
      adapter: { kind: 'js', providerId: 'fixture', filename: 'fixture-user-adapter.js', source },
    })
    const loop = 'Promise.resolve().then(() => { while (true) {} });'
    const normal = [
      'module.exports = {',
      'createLanguageModelFactory({ helpers }) { return model => helpers.createOpenAI({})(model) },',
      'createEmbeddingRequest() {',
      'return { url: "https://fixture.invalid/embeddings", headers: {}, body: { input: ["fixture"] } }',
      '}',
      '}',
    ].join(' ')
    assert.equal(registry.createLanguageModelFactory(config(normal))('fixture-model').modelId, 'fixture-model')
    assert.deepEqual(registry.createEmbeddingRequest(config(normal), 'fixture-model', ['fixture']), {
      url: 'https://fixture.invalid/embeddings', headers: {}, body: { input: ['fixture'] },
    })
    const cases = [
      [loop + normal, 'source'],
      ['module.exports = { createLanguageModelFactory({ helpers }) {' + loop +
        'return model => helpers.createOpenAI({})(model) } }', 'factory'],
      ['module.exports = { createLanguageModelFactory({ helpers }) { return model => {' + loop +
        'return helpers.createOpenAI({})(model) } } }', 'model'],
      ['module.exports = { createEmbeddingRequest() {' + loop +
        'return { url: "https://fixture.invalid/embeddings", headers: {} } } }', 'embedding'],
    ]
    for (const [source, seam] of cases) {
      assert.throws(() => {
        if (seam === 'embedding') registry.createEmbeddingRequest(config(source), 'fixture-model', ['fixture'])
        else {
          const factory = registry.createLanguageModelFactory(config(source))
          if (seam === 'model') factory('fixture-model')
        }
      }, error => error?.code === 'MODEL_CUSTOM_ADAPTER_INVALID' && /timed out|超时/.test(error.message), seam)
    }
    console.log('node-vm-deadlines-ok')
  `
  const result = spawnSync('node', ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
    timeout: 12_000,
    killSignal: 'SIGKILL',
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Node VM regression failed: ${result.error?.message ?? result.stderr}`)
  }
  expect(result.signal).toBeNull()
  expect(result.stdout).toContain('node-vm-deadlines-ok')
}, 15_000)
