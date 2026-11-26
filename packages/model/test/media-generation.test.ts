import { expect, test } from 'bun:test'

import { createModelRuntimeComposition } from '../src/index'

test('目录中的专用模型按图片、视频和语音端点生成二进制产物', async () => {
  const requests = new Map<string, Record<string, string>>()
  const runtime = createModelRuntimeComposition({
    providerScripts: { configPaths: [] },
    fetch: async (input, init) => {
      const url = new URL(String(input))
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-key')
      if (typeof init?.body === 'string') requests.set(url.pathname, JSON.parse(init.body))
      switch (url.pathname) {
        case '/api/v1/models':
          return Response.json({
            data: url.search
              ? [{ id: 'vendor/voice', supported_voices: [{ id: 'voice-one' }] }]
              : [{ id: 'vendor/chat', architecture: { input_modalities: ['text', 'image'] } }],
          })
        case '/api/v1/images/models':
          return Response.json({ data: [{ id: 'vendor/image' }] })
        case '/api/v1/videos/models':
          return Response.json({ data: [{ id: 'vendor/video' }] })
        case '/api/v1/images':
          return Response.json({ data: [{ b64_json: 'AQID' }] })
        case '/api/v1/videos':
          return Response.json({ id: 'fixture-job', status: 'completed' })
        case '/api/v1/videos/fixture-job/content':
          return new Response(Uint8Array.of(1, 2, 3), { headers: { 'Content-Type': 'video/mp4' } })
        case '/api/v1/audio/speech':
          return new Response(Uint8Array.of(1, 2, 3), { headers: { 'Content-Type': 'audio/mpeg' } })
        default:
          throw new Error(`Unexpected model path: ${url.pathname}`)
      }
    },
  })
  const config = {
    provider: 'openrouter' as const,
    apiKey: 'test-key',
    baseURL: 'https://openrouter.ai/api/v1',
    enabled: true,
    defaultModel: 'vendor/chat',
  }
  const context = { providerRuntimeConfigs: [config], openRouter: { useFreeModelsForDebug: false } }
  for (const [model, kind, mediaType] of [
    ['vendor/image', 'image', 'image/png'],
    ['vendor/video', 'video', 'video/mp4'],
    ['vendor/voice', 'audio', 'audio/mpeg'],
  ] as const) {
    const resolved = await runtime.agentModelResolver.resolve({ ...config, model }, context)
    expect(resolved.mediaGenerator?.kind).toBe(kind)
    const media = await resolved.mediaGenerator!.generate(
      'test prompt',
      new AbortController().signal
    )
    expect(media.mediaType).toBe(mediaType)
    expect(Array.from(media.bytes)).toEqual([1, 2, 3])
  }
  const chat = await runtime.agentModelResolver.resolve(
    { ...config, model: 'vendor/chat' },
    context
  )
  expect(chat.mediaGenerator).toBeUndefined()
  expect(requests.get('/api/v1/audio/speech')).toMatchObject({
    voice: 'voice-one',
    input: 'test prompt',
  })
})
