import assert from 'node:assert/strict'

// 评测与产品使用同一供应商装配，缓存与推理选项经过正式适配层。
export function campaignModelDriver(modelPackage, config) {
  const composition = modelPackage.createModelRuntimeComposition({
    environment: {},
    providerScripts: { configPaths: [] },
  })
  const provider = composition.agentModelRuntime.createAgentProvider({
    provider: 'openai',
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    reasoningLevel: 'high',
    ...config.providerCapabilities,
  })
  return modelPackage.createAiSdkModelDriver({
    id: config.model,
    model: provider(config.model),
    limits: {
      contextTokens: config.contextTokens,
      inputTokens: config.inputWindowTokens,
      outputTokens: config.outputTokens,
    },
  })
}

// 本地截获真实 SDK 请求，付费前验证关键字段；不访问供应商。
export async function verifyCampaignDriver(modelPackage, providerCapabilities = {}) {
  const transport = globalThis.fetch
  const wires = []
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://offline.invalid/v1/responses')
    wires.push(JSON.parse(init.body))
    return Response.json({ error: { message: 'offline preflight' } }, { status: 400 })
  }
  try {
    const driver = campaignModelDriver(modelPackage, {
      apiKey: 'offline-fixture',
      baseURL: 'https://offline.invalid/v1',
      model: 'gpt-5.6-sol',
      contextTokens: 65536,
      inputWindowTokens: 32768,
      outputTokens: 12000,
      providerCapabilities,
    })
    for await (const delta of driver.stream(
      {
        instructions: 'Offline wire verification',
        materials: [{ ref: 'frame', origin: 'runtime-view', text: 'next', totalChars: 4 }],
        history: [{ role: 'user', content: 'stable history', cacheBreakpoint: true }],
        cacheKey: 'offline-session',
        outputTokens: 12000,
        mode: 'work',
        response: { type: 'text' },
      },
      new AbortController().signal
    )) {
      if (delta.type === 'error') assert.match(delta.message, /offline preflight/)
    }
    assert.equal(wires.length, 1)
    const wire = wires[0]
    assert.equal(wire.prompt_cache_key, 'offline-session')
    assert.equal(wire.reasoning.effort, 'high')
    assert.equal(wire.store, false)
    assert(wire.include.includes('reasoning.encrypted_content'))
    const explicitBreakpoints = wire.input.some(
      (item) =>
        Array.isArray(item.content) && item.content.some((part) => part.prompt_cache_breakpoint)
    )
    assert.equal(explicitBreakpoints, providerCapabilities.openaiExplicitCacheBreakpoints === true)
    return { provider: 'formal-model-composition', sessionKey: true, explicitBreakpoints }
  } finally {
    globalThis.fetch = transport
  }
}
