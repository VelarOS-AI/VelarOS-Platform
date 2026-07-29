/**
 * @test-meta
 * title: 模型运行时包入口
 * summary: 包 · 模型运行时：验证发布入口通过构建产物导出可被节点模块正常解析。
 * area: package
 */
import assert from 'node:assert/strict'

import { test } from 'bun:test'

test('package entry resolves through dist exports', async () => {
  const runtime = await import('@velaros-ai/model')
  const catalog = await import('@velaros-ai/model/catalog')
  const contracts = await import('@velaros-ai/model/contracts')
  const nodeRuntime = await import('@velaros-ai/model/node')

  assert.deepEqual(Object.keys(contracts), [])
  assert.equal(typeof catalog.LocalModelEnvironment, 'function')
  assert.equal(typeof catalog.getModelProviderOperationalManifest, 'function')
  assert.equal(typeof catalog.getSharedProviderCatalog, 'function')
  assert.equal(typeof runtime.AgentModelRuntime, 'function')
  assert.equal(typeof runtime.AgentModelResolver, 'function')
  assert.equal(typeof runtime.ModelRequestClient, 'function')
  assert.equal(typeof runtime.ModelProviderCollection, 'function')
  assert.equal(typeof runtime.resolveAutoEmbeddingSelection, 'function')
  assert.equal(typeof runtime.isModelProviderEmbeddingCapable, 'function')
  assert.equal(typeof runtime.getFirstConfiguredProviderRuntimeConfig, 'function')
  assert.equal(typeof runtime.isProviderRuntimeConfigured, 'function')
  assert.equal(typeof runtime.getModelProviderOperationalManifest, 'function')
  assert.equal(typeof runtime.getSharedProviderCatalog, 'function')
  assert.equal(typeof runtime.resolveOllamaContextWindow, 'function')
  assert.equal(typeof runtime.OpenAiOnlyModels.has, 'function')
  assert.equal(runtime.OpenAiOnlyModels.add, undefined)
  assert.equal(runtime.DefaultModelRuntimeComposition, undefined)
  assert.equal(runtime.ModelRuntimeComposition, undefined)
  assert.equal(runtime.ProviderScriptRegistry, undefined)
  assert.equal(typeof nodeRuntime.DefaultModelRuntimeComposition, 'function')
  assert.equal(typeof nodeRuntime.ModelRuntimeComposition, 'function')
  assert.equal(typeof nodeRuntime.NodeLocalModelEnvironment, 'function')
  assert.equal(typeof nodeRuntime.ProviderScriptRegistry, 'function')
})
