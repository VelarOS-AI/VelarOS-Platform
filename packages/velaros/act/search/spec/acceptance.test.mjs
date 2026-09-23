import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ContextLimits } from '@velaros-ai/context'

import { SearchLimits } from '../../../dist/act/search/contract/constants.js'
import {
  VelarEvidenceModule,
  VelarSearchModule,
} from '../../../dist/act/search/contract/surface.js'
import { evidenceModule, searchModule } from '../../../dist/act/search/index.js'
import { verifyModule } from '../../runtime/test/support/module-contract.mjs'

test('INV-1 search 的实际操作与模板一致', () =>
  verifyModule(searchModule, new URL('../template.js', import.meta.url)))
test('INV-1 evidence 的实际操作与模板一致', () =>
  verifyModule(evidenceModule, new URL('../evidence-template.js', import.meta.url)))

test('搜索档位目录与调用使用同一组宿主名称，发现的名称可直接用于搜索', async () => {
  const names = ['quick', 'investigate']
  const info = names.map((name) => ({ name, default: name === 'investigate', limits: {} }))
  let selected
  const definition = searchModule.create({
    search: {
      profileInfo: () => info,
      run: async (input) => {
        selected = input.profile
        return { selected }
      },
    },
  })
  const call = () => ({
    signal: new AbortController().signal,
    invocation: { id: 'call', sessionId: 's', executionId: 'e' },
    recordEffect() {},
  })
  const operations = definition.operations
  const directory = await operations.profiles.run(null, call())
  assert.deepEqual(
    directory.map((item) => item.name),
    names
  )
  const profile = directory.find((item) => item.default).name
  assert.deepEqual(await operations.search.run({ query: 'session', profile }, call()), {
    selected: 'investigate',
  })
  assert.equal(selected, 'investigate')
})

test('INV-2 声明里写给模型的上限与常量表一致', () => {
  const report = `整份不超过 ${SearchLimits.reportChars} 个字符`
  for (const [surface, fragments] of [
    [
      VelarSearchModule,
      [
        `新搜索给 query（最多 ${SearchLimits.queryChars} 个字符）`,
        `sources 限定来源（最多 ${SearchLimits.sources} 个）`,
        `背景说明（最多 ${SearchLimits.contextChars} 个字符）；anchors 是已知相关的资源（最多 ${SearchLimits.anchors} 个）`,
        `limit 最多 ${ContextLimits.readChars} 个字符`,
        `按证据条目分页（limit 最多 ${SearchLimits.refreshItems} 条）`,
        report,
      ],
    ],
    [
      VelarEvidenceModule,
      [
        `query 用短关键词（1 到 ${SearchLimits.evidenceQueryChars} 个字符），limit 每次最多 ${SearchLimits.candidates} 个候选，默认 ${SearchLimits.defaultCandidates}`,
        `maxBytes 最多 ${SearchLimits.readBytes}，默认 ${SearchLimits.defaultReadBytes}`,
        report,
      ],
    ],
  ])
    for (const fragment of fragments)
      assert.ok(
        surface.declarations.includes(fragment),
        `${surface.specifier} 的声明里没有「${fragment}」`
      )
})
