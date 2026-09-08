import { describe, expect, spyOn, test } from 'bun:test'

import type { ChatProviderId, ListProviderModelsRequest, ModelInputModality } from '../src'
import { createModelRuntimeComposition } from '../src/node'

const Model = 'fixture/text-only-8k'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function response(window: number, modalities: readonly ModelInputModality[] = ['text']) {
  return Response.json({ data: [{
    id: Model,
    context_length: window,
    architecture: { input_modalities: modalities },
  }] })
}

function createRuntime(fetch: typeof globalThis.fetch, timeoutMs = 1_000) {
  const composition = createModelRuntimeComposition({
    providerScripts: { configPaths: [] },
    providerCatalog: { fetch, timeoutMs },
  })
  const request = (overrides: Partial<ListProviderModelsRequest> = {}) => ({
    provider: 'openrouter' as ChatProviderId,
    apiKey: 'fixture-key',
    baseURL: 'https://fixture.invalid/v1',
    defaultModel: Model,
    purpose: 'chat' as const,
    ...overrides,
  })
  const resolve = (input = request(), signal?: AbortSignal) =>
    composition.agentModelResolver.resolve({ ...input, model: Model }, {
      providerRuntimeConfigs: [{ ...input, enabled: true }],
      openRouter: { useFreeModelsForDebug: false },
    }, signal)
  return { composition, request, resolve, catalog: composition.providerModelCatalogService }
}

function createScriptRuntime(metadataBody: string, listBody: string) {
  const fixture = createRuntime(async () => { throw new Error('script must not use HTTP') }, 25)
  const provider = 'fixture-metadata-priority' as ChatProviderId
  fixture.composition.providerScriptRegistry.registerSource({
    scriptPath: '/tmp/velaros-metadata-priority.cjs',
    source: `module.exports = {
      manifest: { id:'${provider}', label:'Fixture', description:'Fixture', defaultBaseURL:'', defaultApiKey:'', apiKeyOptional:true, baseURLConfigurable:true, enabledByDefault:true, defaultModel:'${Model}', models:[{id:'${Model}'}] },
      listModels() { ${listBody} },
      resolveRuntimeMetadata() { ${metadataBody} },
      createLanguageModelFactory() { return () => ({}) }
    }`,
  })
  return { ...fixture, run: () => fixture.resolve(fixture.request({ provider })) }
}

describe('动态目录与运行时能力快照', () => {
  test('完整显式 metadata 不查询悬挂目录，具体 config 的显式窗口优先', async () => {
    for (const metadata of [
      '{contextWindow:4096,inputModalities:["text"]}',
      '{contextWindow:16384,inputModalities:["text"],config:{provider:"openai",model:"gpt-4.1",contextWindow:4096}}',
      '{inputModalities:["text"],config:{provider:"openai",model:"gpt-4.1",contextWindow:4096}}',
    ]) {
      const fixture = createScriptRuntime(`return ${metadata}`, 'return new Promise(() => {})')
      const lookup = spyOn(fixture.catalog, 'resolveModelCapabilities')
      const runtime = await fixture.run()
      expect(lookup).not.toHaveBeenCalled()
      expect(runtime.contextWindow).toBe(4096)
      expect(runtime.supportedInputModalities).toEqual(['text'])
    }
  })

  test('显式 metadata 缺一项时查询目录补齐，并保持已有字段优先', async () => {
    for (const scenario of [
      { metadata: '{inputModalities:["text"]}', window: 8192, modalities: ['text'] },
      { metadata: '{contextWindow:4096}', window: 4096, modalities: ['text', 'image'] },
    ]) {
      const fixture = createScriptRuntime(`return ${scenario.metadata}`, `return [{id:'${Model}',contextWindow:8192,inputModalities:['text','image']}]`)
      const lookup = spyOn(fixture.catalog, 'resolveModelCapabilities')
      const runtime = await fixture.run()
      expect(lookup).toHaveBeenCalledTimes(1)
      expect(runtime.contextWindow).toBe(scenario.window)
      expect(runtime.supportedInputModalities).toEqual(scenario.modalities)
    }
  })

  test('metadata 失败保留原因但不能以默认估计覆盖动态 8K 窗口', async () => {
    const fixture = createScriptRuntime('throw new Error("metadata offline")', `return [{id:'${Model}',contextWindow:8192,inputModalities:['text']}]`)
    const runtime = await fixture.run()
    expect(runtime.contextWindow).toBe(8192)
    expect(runtime.supportedInputModalities).toEqual(['text'])
    expect(runtime.fallbackReason).toContain('metadata offline')
  })

  test('具体 config 只有模型名时，动态窗口优先于该模型的静态查表', async () => {
    const fixture = createScriptRuntime('return {inputModalities:["text"],config:{provider:"openai",model:"gpt-4.1"}}', `return [{id:'${Model}',contextWindow:8192,inputModalities:['text','image']}]`)
    const lookup = spyOn(fixture.catalog, 'resolveModelCapabilities')
    const runtime = await fixture.run()
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(runtime.contextWindow).toBe(8192)
    expect(runtime.supportedInputModalities).toEqual(['text'])
  })

  for (const status of [200, 503]) {
    test(`响应头返回而正文挂起时，取消仍中止真实 fetch 信号：${status}`, async () => {
      const bodyStarted = deferred<AbortSignal>()
      const fixture = createRuntime(async (_input, init) => {
        const signal = init?.signal
        if (!signal) throw new Error('missing signal')
        const body = new ReadableStream({ start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        } })
        const headersReceived = new Response(body, { status })
        const method = status === 200 ? 'json' : 'text'
        const readBody = headersReceived[method].bind(headersReceived)
        spyOn(headersReceived, method).mockImplementation(() => {
          bodyStarted.resolve(signal)
          return readBody()
        })
        return headersReceived
      })
      const controller = new AbortController()
      const pending = fixture.resolve(fixture.request(), controller.signal)
      const underlying = await bodyStarted.promise
      expect(underlying.aborted).toBe(false)
      controller.abort(new Error('stop body read'))
      await expect(pending).rejects.toThrow('stop body read')
      expect(underlying.aborted).toBe(true)
    })
  }

  test('远端 8K/text-only 能力进入同一运行时窗口和工具模态契约', async () => {
    let calls = 0
    const fixture = createRuntime(async () => { calls++; return response(8192) })
    const catalog = await fixture.catalog.listProviderModels(fixture.request())
    expect(catalog.models[0]).toMatchObject({ contextWindow: 8192, inputModalities: ['text'] })
    const runtime = await fixture.resolve()
    expect(runtime.contextWindow).toBe(8192)
    expect(runtime.supportedInputModalities).toEqual(['text'])
    expect(calls).toBe(1)
  })

  test('相同模型按 provider、endpoint 与凭据隔离，并允许返回原作用域', async () => {
    let calls = 0
    const fixture = createRuntime(async (input, init) => {
      calls++
      const url = String(input)
      const key = new Headers(init?.headers).get('Authorization')
      const window = url.includes('second') ? 4096 : key === 'Bearer other-key' ? 16384 : 8192
      return response(window, window === 8192 ? ['text'] : ['text', 'image'])
    })
    expect((await fixture.resolve()).contextWindow).toBe(8192)
    expect((await fixture.resolve(fixture.request({ baseURL: 'https://second.invalid/v1' }))).contextWindow).toBe(4096)
    expect((await fixture.resolve(fixture.request({ apiKey: 'other-key' }))).supportedInputModalities).toEqual(['text', 'image'])
    expect((await fixture.resolve(fixture.request({ provider: 'openai-compatible-gateway' }))).contextWindow).toBe(8192)
    expect((await fixture.resolve()).supportedInputModalities).toEqual(['text'])
    expect(calls).toBe(4)
  })

  test('显式刷新与失效后的下一次运行使用最新能力', async () => {
    let window = 8192
    let calls = 0
    const fixture = createRuntime(async () => { calls++; return response(window) })
    expect((await fixture.resolve()).contextWindow).toBe(8192)
    window = 4096
    await fixture.catalog.listProviderModels(fixture.request())
    expect((await fixture.resolve()).contextWindow).toBe(4096)
    window = 16384
    fixture.catalog.invalidateProviderModels(fixture.request())
    expect((await fixture.resolve()).contextWindow).toBe(16384)
    expect(calls).toBe(3)
  })

  test('并发首次解析共用查询，取消一名等待者不影响另一名', async () => {
    const pending = deferred<Response>()
    const started = deferred<void>()
    let calls = 0
    const fixture = createRuntime(async () => { calls++; started.resolve(); return pending.promise })
    const controller = new AbortController()
    const first = fixture.resolve(fixture.request(), controller.signal)
    const second = fixture.resolve()
    await started.promise
    controller.abort(new Error('fixture stop'))
    await expect(first).rejects.toThrow('fixture stop')
    pending.resolve(response(8192))
    expect((await second).contextWindow).toBe(8192)
    expect(calls).toBe(1)
  })

  test('所有等待者取消后终止底层查询，下一次运行可以重新获取', async () => {
    const started = deferred<AbortSignal>()
    let calls = 0
    const fixture = createRuntime(async (_input, init) => {
      calls++
      if (calls > 1) return response(4096)
      const signal = init?.signal
      if (!signal) throw new Error('missing signal')
      started.resolve(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const controller = new AbortController()
    const pending = fixture.resolve(fixture.request(), controller.signal)
    const underlying = await started.promise
    controller.abort(new Error('fixture stop'))
    await expect(pending).rejects.toThrow('fixture stop')
    expect(underlying.aborted).toBe(true)
    expect((await fixture.resolve()).contextWindow).toBe(4096)
    expect(calls).toBe(2)
  })

  test('同作用域后发刷新先完成时，旧响应不能覆盖新快照', async () => {
    const firstResponse = deferred<Response>()
    const firstStarted = deferred<void>()
    let calls = 0
    const fixture = createRuntime(async () => {
      calls++
      if (calls > 1) return response(4096)
      firstStarted.resolve()
      return firstResponse.promise
    })
    const older = fixture.catalog.listProviderModels(fixture.request())
    await firstStarted.promise
    await fixture.catalog.listProviderModels(fixture.request())
    firstResponse.resolve(response(131072, ['text', 'image']))
    await older
    expect((await fixture.resolve()).contextWindow).toBe(4096)
    expect((await fixture.resolve()).supportedInputModalities).toEqual(['text'])
    expect(calls).toBe(2)
  })

  test('失效时仍在途的旧响应不能复活下一次运行的能力', async () => {
    const firstResponse = deferred<Response>()
    const firstStarted = deferred<void>()
    let calls = 0
    const fixture = createRuntime(async () => {
      calls++
      if (calls > 1) return response(4096)
      firstStarted.resolve()
      return firstResponse.promise
    })
    const older = fixture.resolve()
    await firstStarted.promise
    fixture.catalog.invalidateProviderModels(fixture.request())
    firstResponse.resolve(response(131072, ['text', 'image']))
    await older
    expect((await fixture.resolve()).contextWindow).toBe(4096)
    expect(calls).toBe(2)
  })

  test('目录失败短期回落且不每轮重试，凭据切换立即重新查询', async () => {
    let calls = 0
    const fixture = createRuntime(async (_input, init) => {
      calls++
      return new Headers(init?.headers).get('Authorization') === 'Bearer updated'
        ? response(8192)
        : Response.json({ error: { message: 'models unavailable' } }, { status: 404 })
    })
    expect((await fixture.resolve()).supportedInputModalities).toEqual(['text', 'image', 'audio'])
    await fixture.resolve()
    expect(calls).toBe(1)
    expect((await fixture.resolve(fixture.request({ apiKey: 'updated' }))).contextWindow).toBe(8192)
    expect(calls).toBe(2)
  })

  test('目录超时有界回落，并复用短期失败快照', async () => {
    let calls = 0
    const fixture = createRuntime(() => { calls++; return new Promise<Response>(() => {}) }, 20)
    const started = Date.now()
    expect((await fixture.resolve()).contextWindow).toBeUndefined()
    await fixture.resolve()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(calls).toBe(1)
  })

  test('成功与失败快照分别到期，不把旧能力永久留给恢复的任务', async () => {
    let now = Date.now()
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    let calls = 0
    const fixture = createRuntime(async () => {
      calls++
      return calls === 1
        ? Response.json({ error: 'offline' }, { status: 503 })
        : response(calls === 2 ? 8192 : 4096)
    })
    try {
      await fixture.resolve()
      now += 29_999
      await fixture.resolve()
      expect(calls).toBe(1)
      now += 1
      expect((await fixture.resolve()).contextWindow).toBe(8192)
      now += 299_999
      expect((await fixture.resolve()).contextWindow).toBe(8192)
      expect(calls).toBe(2)
      now += 1
      expect((await fixture.resolve()).contextWindow).toBe(4096)
      expect(calls).toBe(3)
    } finally {
      clock.mockRestore()
    }
  })

  test('大量凭据作用域保持缓存有界，淘汰后重新读取而不跨凭据复用', async () => {
    let calls = 0
    const fixture = createRuntime(async () => { calls++; return response(8192) })
    for (let index = 0; index < 129; index++) {
      await fixture.resolve(fixture.request({ apiKey: `scope-${index}` }))
    }
    await fixture.resolve(fixture.request({ apiKey: 'scope-128' }))
    expect(calls).toBe(129)
    await fixture.resolve(fixture.request({ apiKey: 'scope-0' }))
    expect(calls).toBe(130)
  })

  test('脚本替换后同一配置读取新目录，具体 metadata 继续优先', async () => {
    const fixture = createRuntime(async () => { throw new Error('script must not use HTTP') })
    const provider = 'fixture-script' as ChatProviderId
    const register = (window: number, metadata = '{}') => fixture.composition.providerScriptRegistry.registerSource({
      scriptPath: '/tmp/velaros-capability-script.cjs',
      source: `module.exports = {
        manifest: { id:'${provider}', label:'Fixture', description:'Fixture', defaultBaseURL:'', defaultApiKey:'', apiKeyOptional:true, baseURLConfigurable:true, enabledByDefault:true, defaultModel:'${Model}', models:[{id:'${Model}'}] },
        listModels() { return [{id:'${Model}',contextWindow:${window},inputModalities:['text','image']}] },
        resolveRuntimeMetadata() { return ${metadata} },
        createLanguageModelFactory() { return () => ({}) }
      }`,
    })
    register(8192)
    expect((await fixture.resolve(fixture.request({ provider }))).contextWindow).toBe(8192)
    register(4096)
    expect((await fixture.resolve(fixture.request({ provider }))).contextWindow).toBe(4096)
    register(16384, '{contextWindow:2048,inputModalities:["text"]}')
    const runtime = await fixture.resolve(fixture.request({ provider }))
    expect(runtime.contextWindow).toBe(2048)
    expect(runtime.supportedInputModalities).toEqual(['text'])
  })
})
