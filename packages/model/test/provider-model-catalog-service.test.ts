import { describe, expect, test } from 'bun:test'

import {
  ModelProviderCollection,
  ProviderModelCatalogService,
  type ProviderScriptRegistryPort,
} from '../src'

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

  test('parses Google model names and authenticates through the query string', async () => {
    let capturedUrl = ''
    const service = createService(async (input) => {
      capturedUrl = String(input)
      return Response.json({
        models: [{ name: 'models/gemini-next', displayName: 'Gemini Next' }],
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
