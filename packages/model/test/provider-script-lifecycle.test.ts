import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { ModelProviderCollection } from '../src/impl/providers/ModelProviderCollection'
import { ProviderModelCatalogService } from '../src/impl/providers/ProviderModelCatalogService'
import { ProviderScriptRegistry } from '../src/impl/providers/ProviderScriptRegistry'

function source(id: string): string {
  return `module.exports = {
    manifest: { id: '${id}', label: 'Fixture', description: 'Fixture',
      defaultModel: 'fixture', models: [{ id: 'fixture' }] },
    createLanguageModelFactory() { return () => ({}) }
  }`
}

test('a failed script reload publishes no partial registry and does not replay side effects on reads', () => {
  const root = mkdtempSync(join(tmpdir(), 'velaros-model-script-lifecycle-'))
  try {
    const first = join(root, 'first.cjs')
    const second = join(root, 'second.cjs')
    const configPath = join(root, 'dev.json')
    const counter = join(root, 'loads.txt')
    writeFileSync(
      first,
      `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'loaded\\n');\n${source('first-provider')}`
    )
    writeFileSync(second, 'throw new Error("fixture script failed")')
    writeFileSync(configPath, JSON.stringify({ providerScripts: { scripts: [first, second] } }))
    const registry = new ProviderScriptRegistry({ configPaths: [] })
    registry.registerSource({
      source: source('memory-provider'),
      scriptPath: join(root, 'memory.cjs'),
    })
    registry.configureSources({ configPaths: [configPath] })
    let failure: unknown
    try {
      registry.reload()
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'MODEL_PROVIDER_SCRIPT_INVALID' })
    for (const read of [
      () => registry.listProviderManifests(),
      () => registry.getActiveConfigPath(),
      () => registry.supportsProvider('openai'),
    ]) {
      try {
        read()
        throw new Error('failed registry must keep rejecting reads')
      } catch (error) {
        expect(error).toBe(failure)
      }
    }
    expect(readFileSync(counter, 'utf8')).toBe('loaded\n')
    writeFileSync(second, source('second-provider'))
    expect(() => registry.listProviderManifests()).toThrow('fixture script failed')
    registry.reload()
    expect(registry.listProviderManifests().map((manifest) => manifest.id)).toEqual([
      'first-provider',
      'second-provider',
      'memory-provider',
    ])
    expect(readFileSync(counter, 'utf8')).toBe('loaded\nloaded\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function blockedScript(timeoutMs = 1_000) {
  const registry = new ProviderScriptRegistry({ configPaths: [] })
  const provider = registry.registerSource({
    source: source('blocked-provider'),
    scriptPath: join(tmpdir(), 'velaros-model-blocked-provider.cjs'),
  })
  const entered = Promise.withResolvers<AbortSignal>()
  const drained = Promise.withResolvers<void>()
  let calls = 0
  const block = async (signal?: AbortSignal): Promise<void> => {
    calls++
    if (!signal) throw new Error('script did not receive an AbortSignal')
    entered.resolve(signal)
    try {
      await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    } finally {
      drained.resolve()
    }
  }
  const definition = registry.requireProviderScript(provider).definition
  definition.validate = ({ signal }) => block(signal)
  definition.listModels = async ({ signal }) => {
    await block(signal)
    return []
  }
  const service = new ProviderModelCatalogService({
    providerCollection: new ModelProviderCollection(registry),
    providerScriptRegistry: registry,
    timeoutMs,
  })
  return {
    registry,
    service,
    request: { provider, apiKey: '', baseURL: '' },
    entered: entered.promise,
    drained: drained.promise,
    calls: () => calls,
  }
}

for (const operation of ['validateProviderRuntime', 'listProviderModels'] as const) {
  test(`INV-12 script ${operation} receives cancellation and preserves the caller reason`, async () => {
    const fixture = blockedScript()
    const controller = new AbortController()
    const reason = new Error('fixture caller stopped')
    const pending = fixture.service[operation](fixture.request, controller.signal)
    const underlying = await fixture.entered
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    await fixture.drained
    expect(underlying.aborted).toBe(true)
    expect(fixture.calls()).toBe(1)
  })

  test(`INV-12 script ${operation} receives its deadline and releases its operation`, async () => {
    const fixture = blockedScript(20)
    const pending = fixture.service[operation](fixture.request)
    const underlying = await fixture.entered
    const result = await pending
    await fixture.drained
    expect(underlying.aborted).toBe(true)
    expect(result).toMatchObject(
      operation === 'validateProviderRuntime' ? { ok: false } : { models: [] }
    )
    expect(fixture.calls()).toBe(1)
  })

  test(`script ${operation} rejects an already cancelled call before invoking the script`, async () => {
    const fixture = blockedScript()
    const reason = new Error('fixture already stopped')
    await expect(
      fixture.registry[operation](fixture.request, AbortSignal.abort(reason))
    ).rejects.toBe(reason)
    expect(fixture.calls()).toBe(0)
  })
}

test('shared script discovery cancels only after its last waiter leaves', async () => {
  const fixture = blockedScript()
  const first = new AbortController()
  const second = new AbortController()
  const request = { ...fixture.request, model: 'fixture' }
  const older = fixture.service.resolveModelCapabilities(request, first.signal)
  const newer = fixture.service.resolveModelCapabilities(request, second.signal)
  const underlying = await fixture.entered
  const firstReason = new Error('first waiter stopped')
  first.abort(firstReason)
  await expect(older).rejects.toBe(firstReason)
  expect(underlying.aborted).toBe(false)
  const secondReason = new Error('last waiter stopped')
  second.abort(secondReason)
  await expect(newer).rejects.toBe(secondReason)
  await fixture.drained
  expect(underlying.aborted).toBe(true)
  expect(fixture.calls()).toBe(1)
})
