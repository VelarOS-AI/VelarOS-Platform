import assert from 'node:assert/strict'

import { test } from 'bun:test'

import {
  BrowserResidentToolNames,
  BrowserToolCategoryIds,
  createBrowserBundledModDefinition,
} from '../dist/composition/mod.js'

const manifest = createBrowserBundledModDefinition().manifest
const spaceContribution = manifest.contributes.spaces[0]
const toolContributions = manifest.contributes.tools

void test('browser tools are guests in root-bound spaces: available there, resident only in browser', () => {
  for (const tool of toolContributions) {
    assert.ok(
      tool.availableInSpaces.includes('browser'),
      `${tool.name} 必须在浏览器空间可用`
    )
    assert.ok(
      tool.availableInSpaces.includes('project'),
      `${tool.name} 必须在项目空间可用（前端验证：起服务、打开 localhost 看渲染）`
    )
    // 客居 = 可用不常驻：写进 residentInSpaces 就等于给每个项目会话每轮塞浏览器 schema。
    assert.deepEqual(
      tool.residentInSpaces ?? null,
      BrowserResidentToolNames.has(tool.name) ? ['browser'] : null,
      `${tool.name} 的常驻声明只能是浏览器空间`
    )
  }
})

void test('every browser tool lands in exactly one of the seven category pages', () => {
  const categoryIds = new Set(BrowserToolCategoryIds)
  assert.equal(categoryIds.size, 7)
  for (const tool of toolContributions) {
    assert.ok(categoryIds.has(tool.categoryId), `${tool.name} 分类未登记`)
  }
})

void test('the browser space no longer points at a surface profile', () => {
  // `surfaceProfileId: 'browser-control'` 全仓零消费，指向的档也从未被选中过；
  // surface 答「谁在调用」、空间答「在哪儿干活」，两轴合一就得二选一。声明与档同批删除。
  assert.equal('surfaceProfileId' in spaceContribution, false)
  assert.equal(spaceContribution.identityStrategy, 'origin')
  assert.deepEqual([...spaceContribution.toolCategoryIds], [...BrowserToolCategoryIds])
})
