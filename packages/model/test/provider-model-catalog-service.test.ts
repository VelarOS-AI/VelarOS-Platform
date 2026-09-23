import { describe, expect, test } from 'bun:test'

import { ModelProviderCollection } from '../src/impl/providers/ModelProviderCollection'
import { ProviderModelCatalogService } from '../src/impl/providers/ProviderModelCatalogService'
import type { ProviderScriptRegistryPort } from '../src/index'

const EmptyProviderScripts: ProviderScriptRegistryPort = {
  supportsProvider: () => false,
  getProviderScript: () => null,
  listProviderManifests: () => [],
  validateProviderRuntime: async () => ({ ok: false, message: null }),
  listProviderModels: async () => [],
  resolveRuntimeMetadata: async () => null,
  fetchTavily: async () => ({}),
}

function createService(
  fetch: typeof globalThis.fetch,
  options: { referer?: string; title?: string; environment?: Record<string, string> } = {}
): ProviderModelCatalogService {
  return new ProviderModelCatalogService({
    providerCollection: new ModelProviderCollection(EmptyProviderScripts, {
      environment: options.environment,
    }),
    providerScriptRegistry: EmptyProviderScripts,
    fetch,
    attribution: options,
  })
}

describe('ProviderModelCatalogService', () => {
  test('loads and normalizes OpenAI-compatible remote models', async () => {
    let capturedUrl = ''
    let capturedAuthorization = ''
    const service = createService(async (input, init) => {
      capturedUrl = String(input)
      capturedAuthorization = new Headers(init?.headers).get('Authorization') ?? ''
      return Response.json({
        data: [
          { id: 'gpt-next', display_name: 'GPT Next' },
          { id: 'gpt-next' },
          { id: 'gpt-mini' },
        ],
      })
    })

    const catalog = await service.listProviderModels({
      provider: 'openai',
      apiKey: 'secret',
      baseURL: '',
    })

    expect(capturedUrl).toBe('https://api.openai.com/v1/models')
    expect(capturedAuthorization).toBe('Bearer secret')
    expect(catalog.source).toBe('remote')
    expect(catalog.models.map((model) => [model.id, model.label])).toEqual([
      ['gpt-next', 'GPT Next'],
      ['gpt-mini', 'gpt-mini'],
    ])
  })

  test('loads the public OpenRouter catalog without requiring a key', async () => {
    let capturedHeaders = new Headers()
    const service = createService(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers)
      return Response.json({
        data: [{
          id: 'vendor/model-next',
          name: 'Model Next',
          architecture: { input_modalities: ['text', 'image', 'unknown'] },
        }],
      })
    }, {
      referer: 'https://velaros.ai',
      title: 'VelarOS Workbench',
    })

    const catalog = await service.listProviderModels({
      provider: 'openrouter',
      apiKey: '',
      baseURL: '',
    })

    expect(capturedHeaders.get('Authorization')).toBeNull()
    expect(capturedHeaders.get('HTTP-Referer')).toBe('https://velaros.ai')
    expect(capturedHeaders.get('X-Title')).toBe('VelarOS Workbench')
    expect(catalog.models).toMatchObject([{
      id: 'vendor/model-next',
      label: 'Model Next',
      inputModalities: ['text', 'image'],
    }])
  })

  test('归一化远端目录的开销不随模型条数增长', async () => {
    class CountingProviderCollection extends ModelProviderCollection {
      public presetLookups = 0

      public override listPresets(): ReturnType<ModelProviderCollection['listPresets']> {
        this.presetLookups += 1
        return super.listPresets()
      }
    }

    async function countPresetLookups(modelCount: number): Promise<number> {
      const providerCollection = new CountingProviderCollection(EmptyProviderScripts)
      const service = new ProviderModelCatalogService({
        providerCollection,
        providerScriptRegistry: EmptyProviderScripts,
        fetch: async () =>
          Response.json({
            data: Array.from({ length: modelCount }, (_value, index) => ({
              id: `model-${index}`,
            })),
          }),
      })
      await service.listProviderModels({ provider: 'openai', apiKey: 'secret', baseURL: '' })

      return providerCollection.presetLookups
    }

    // listPresets 每次都重建全部 provider 预设与目录；放进 per-model 循环时
    // OpenRouter 的几百条模型会把它重建几百遍（M4）。
    expect(await countPresetLookups(200)).toBe(await countPresetLookups(2))
  })

  test('parses Google model names and authenticates through the query string', async () => {
    let capturedUrl = ''
    const service = createService(async (input) => {
      capturedUrl = String(input)
      return Response.json({
        models: [{ name: 'models/gemini-next', displayName: 'Gemini Next', inputTokenLimit: 65536 }],
      })
    })

    const catalog = await service.listProviderModels({
      provider: 'google',
      apiKey: 'google-secret',
      baseURL: '',
    })

    const url = new URL(capturedUrl)
    expect(url.pathname).toBe('/v1beta/models')
    expect(url.searchParams.get('key')).toBe('google-secret')
    expect(url.searchParams.get('pageSize')).toBe('1000')
    expect(catalog.models.map((model) => model.id)).toEqual(['gemini-next'])
    expect(catalog.models[0]?.contextWindow).toBe(65536)
  })

  test('does not contact credential-required providers before a key is configured', async () => {
    let calls = 0
    const service = createService(async () => {
      calls += 1
      return Response.json({ data: [] })
    })

    const catalog = await service.listProviderModels({
      provider: 'anthropic',
      apiKey: '',
      baseURL: '',
    })

    expect(calls).toBe(0)
    expect(catalog.models).toEqual([])
    expect(catalog.error).toContain('API Key')
  })

  test('uses the composition environment without exposing it to the product renderer', async () => {
    let capturedAuthorization = ''
    const service = createService(async (_input, init) => {
      capturedAuthorization = new Headers(init?.headers).get('Authorization') ?? ''
      return Response.json({ data: [{ id: 'gpt-env' }] })
    }, {
      environment: { OPENAI_API_KEY: 'environment-secret' },
    })

    const catalog = await service.listProviderModels({
      provider: 'openai',
      apiKey: '',
      baseURL: '',
    })

    expect(capturedAuthorization).toBe('Bearer environment-secret')
    expect(catalog.models.map((model) => model.id)).toEqual(['gpt-env'])
  })

  test('returns a bounded provider error instead of rejecting the product IPC', async () => {
    const service = createService(async () =>
      new Response(JSON.stringify({ error: { message: 'invalid api key with details' } }), {
        status: 401,
      }))

    const catalog = await service.listProviderModels({
      provider: 'openai',
      apiKey: 'bad',
      baseURL: '',
    })

    expect(catalog.models).toEqual([])
    expect(catalog.error).toBe('ChatGPT API Key 不可用')
  })
})

describe('provider credential validation', () => {
  test('managed and source-adapter runtimes do not get an unrelated HTTP probe', async () => {
    let calls = 0
    const service = createService(async () => {
      calls++
      return Response.json({ data: [] })
    })
    for (const provider of ['velaros', 'velar-dev', 'custom'] as const) {
      const result = await service.validateProviderRuntime({ provider, apiKey: '', baseURL: '' })
      expect(result.ok).toBe(false)
      expect(result.message).toContain('专用运行时')
    }
    expect(calls).toBe(0)
  })

  test('validation and discovery resolve injected environment credentials consistently', async () => {
    const credentials: Array<string | null> = []
    const service = createService(async (_input, init) => {
      credentials.push(new Headers(init?.headers).get('Authorization'))
      return Response.json({ data: [] })
    }, { environment: { OPENAI_API_KEY: 'environment-secret' } })
    const request = { provider: 'openai' as const, apiKey: '', baseURL: '' }
    expect((await service.validateProviderRuntime(request)).ok).toBe(true)
    await service.listProviderModels(request)
    expect(credentials).toEqual(['Bearer environment-secret', 'Bearer environment-secret'])
  })

  test('probes authenticated provider endpoints with the correct credential placement', async () => {
    for (const provider of ['openai', 'openrouter', 'anthropic', 'google'] as const) {
      let url = new URL('https://unused.invalid')
      let headers = new Headers()
      const service = createService(async (input, init) => {
        url = new URL(String(input))
        headers = new Headers(init?.headers)
        return Response.json({ data: [] })
      }, { referer: 'https://desktop.example', title: 'Desktop' })
      expect(await service.validateProviderRuntime({ provider, apiKey: 'fixture-key', baseURL: 'https://provider.example/v1' }))
        .toEqual({ ok: true, message: null })
      expect(url.pathname).toBe(provider === 'openrouter' ? '/v1/key' : '/v1/models')
      if (provider === 'google') {
        expect(url.searchParams.get('key')).toBe('fixture-key')
        expect(headers.has('Authorization')).toBe(false)
      } else if (provider === 'anthropic') {
        expect(headers.get('x-api-key')).toBe('fixture-key')
        expect(headers.get('anthropic-version')).toBe('2023-06-01')
      } else expect(headers.get('Authorization')).toBe('Bearer fixture-key')
      if (provider === 'openrouter') {
        expect(headers.get('HTTP-Referer')).toBe('https://desktop.example')
        expect(headers.get('X-Title')).toBe('Desktop')
      }
    }
  })

  test('missing required credentials never send a request, while local providers can omit Bearer', async () => {
    let calls = 0
    const service = createService(async (_input, init) => {
      calls++
      expect(new Headers(init?.headers).has('Authorization')).toBe(false)
      return new Response(null, { status: 200 })
    })
    expect(await service.validateProviderRuntime({ provider: 'openai', apiKey: '', baseURL: '' }))
      .toEqual({ ok: false, message: null })
    expect(calls).toBe(0)
    expect((await service.validateProviderRuntime({ provider: 'ollama', apiKey: '', baseURL: '' })).ok).toBe(true)
    expect(calls).toBe(1)
  })

  test('public OpenRouter listing cannot make an invalid key pass validation', async () => {
    const service = createService(async (input) => String(input).endsWith('/key')
      ? Response.json({ error: { message: 'invalid api key' } }, { status: 401 })
      : Response.json({ data: [{ id: 'provider/model' }] }))
    expect((await service.listProviderModels({ provider: 'openrouter', apiKey: 'invalid', baseURL: '' })).models).toHaveLength(1)
    const result = await service.validateProviderRuntime({ provider: 'openrouter', apiKey: 'invalid', baseURL: '' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('API Key 不可用')
  })

  test('timeout covers error-body reads and aborts the transport', async () => {
    let signal: AbortSignal | undefined
    const service = new ProviderModelCatalogService({
      providerCollection: new ModelProviderCollection(EmptyProviderScripts),
      timeoutMs: 10,
      fetch: async (_input, init) => {
        signal = init?.signal ?? undefined
        return new Response(new ReadableStream({
          start(controller) { signal?.addEventListener('abort', () => controller.error(signal?.reason), { once: true }) },
        }), { status: 500 })
      },
    })
    const result = await service.validateProviderRuntime({ provider: 'openai', apiKey: 'fixture', baseURL: '' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('超时')
    expect(signal?.aborted).toBe(true)
  })
})
