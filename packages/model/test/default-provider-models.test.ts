/**
 * @test-meta
 * title: 缺省模型常量表与静态目录一致
 * summary: 包 · 模型运行时：常量表里直接写的缺省模型必须与静态目录逐条对得上。
 * area: package
 */
import { describe, expect, test } from 'bun:test'

import { DefaultProviderModels, ModelProviderOperationalManifests } from '../src/contract/constants'
import { getSharedProviderCatalog, SharedProviderCatalogs } from '../src/exports/index'

describe('缺省模型常量表', () => {
  test('每个内置 provider 的缺省模型与静态目录一致', () => {
    const fromCatalog = Object.fromEntries(
      SharedProviderCatalogs.map((catalog) => [catalog.provider, catalog.defaultModel])
    )

    expect({ ...DefaultProviderModels }).toEqual(fromCatalog)
  })

  test('常量表覆盖全部内置 provider，且没有多余条目', () => {
    const manifestIds = ModelProviderOperationalManifests.map((manifest) => manifest.id)

    expect(Object.keys(DefaultProviderModels).sort()).toEqual([...manifestIds].sort())
    for (const id of manifestIds) {
      expect(getSharedProviderCatalog(id)).not.toBeNull()
    }
  })
})
