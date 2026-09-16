/**
 * @test-meta
 * title: 模型运行时包入口
 * summary: 包 · 模型运行时：验证收口后的三个发布入口通过构建产物导出可被节点模块正常解析。
 * area: package
 */
import assert from 'node:assert/strict'

import { test } from 'bun:test'

test('package entry resolves through dist exports', async () => {
  const runtime = await import('@velaros-ai/model')
  const catalog = await import('@velaros-ai/model/catalog')
  const contracts = await import('@velaros-ai/model/contracts')

  // 三个入口的值面：可移植数据入口只有常量表，catalog 多一份目录实例，根入口是全部。
  assert.equal(typeof contracts.ModelErrorCodes.credentialMissing, 'string')
  assert.equal(contracts.modelCatalog, undefined)
  assert.equal(typeof catalog.modelCatalog.manifest, 'function')
  assert.equal(typeof catalog.modelCatalog.resolveOllamaChatModel, 'function')
  assert.equal(typeof runtime.createModelRuntimeComposition, 'function')
  assert.equal(typeof runtime.createModelRequestClient, 'function')
  assert.equal(typeof runtime.createModelKernelModule, 'function')
  assert.equal(typeof runtime.modelProfiles.credential, 'function')
  assert.equal(typeof runtime.modelProviderRetry.plan, 'function')
  assert.equal(typeof runtime.modelUsage.summarize, 'function')
  assert.deepEqual(runtime.ModelErrorCodes.credentialMissing, 'MODEL_CREDENTIAL_MISSING')

  // 0.7.0 起类一律不出包，旧的函数式入口也不再有。
  for (const name of [
    'AgentModelResolver',
    'AgentModelRuntime',
    'DefaultModelRuntimeComposition',
    'LocalModelEnvironment',
    'ModelAdapter',
    'ModelProviderCollection',
    'ModelRequestClient',
    'ModelRequestService',
    'ModelRuntimeComposition',
    'ProviderModelCatalogService',
    'ProviderScriptRegistry',
    'VelarCloudModelRuntime',
    'getSharedProviderCatalog',
    'resolveDefaultEmbeddingModelForProvider',
    'resolveOllamaContextWindow',
    'velarCloudModelRuntime',
  ]) {
    assert.equal(runtime[name], undefined, `${name} 不该再出现在根入口上`)
    assert.equal(catalog[name], undefined, `${name} 不该再出现在 ./catalog 上`)
  }
})
