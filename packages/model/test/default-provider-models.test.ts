/**
 * @test-meta
 * title: 型号只能由动态目录或明确输入提供
 * summary: 同步入口不得给出硬编码候选或默认型号，也不能根据静态表改写远端身份。
 * area: package
 */
import { describe, expect, test } from 'bun:test'

import { DefaultProviderModels, ModelProviderOperationalManifests } from '../src/contract/constants'
import { modelCatalog } from '../src/index'

describe('缺省模型常量表', () => {
  test('所有内置服务商的首次默认型号和同步候选均为空', () => {
    for (const manifest of ModelProviderOperationalManifests) {
      expect(DefaultProviderModels[manifest.id]).toBe('')
      expect(modelCatalog.catalog(manifest.id)?.models).toEqual([])
      expect(modelCatalog.models(manifest.id)).toEqual([])
      expect(modelCatalog.suggestedModels(manifest.id)).toEqual([])
      expect(modelCatalog.resolveModel(manifest.id)).toBe('')
    }
    expect(modelCatalog.resolveModel('openai', ' remote-private-model ')).toBe(
      'remote-private-model'
    )
    expect(
      modelCatalog.visibleModels('openai-compatible-gateway', [
        'gpt-4o-mini',
        ' private ',
        'private',
      ])
    ).toEqual(['gpt-4o-mini', 'private'])
  })

  test('常量表覆盖全部内置 provider，且没有多余条目', () => {
    const manifestIds = ModelProviderOperationalManifests.map((manifest) => manifest.id)

    expect(Object.keys(DefaultProviderModels).sort()).toEqual([...manifestIds].sort())
    for (const id of manifestIds) {
      expect(modelCatalog.catalog(id)).not.toBeNull()
    }
  })
})
