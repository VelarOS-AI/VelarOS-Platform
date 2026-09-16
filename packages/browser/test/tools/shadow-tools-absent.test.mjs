/**
 * @test-meta
 * title: 浏览器包不再定义影子工具
 * summary: act / extract / recipe 的动作分支是普通函数，不许再用工具定义器登记出模型永远看不到的工具名。
 * area: packages
 */
import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { DefaultToolContractExampleRegistry } from '@velaros-ai/agent/tool-contract'

/** 曾经用工具定义器完整定义、却从不交给模型的 21 个名字。 */
const RetiredShadowToolNames = [
  'browser:perform_target_action',
  'browser:navigate_page',
  'browser:scroll_page',
  'browser:type_text',
  'browser:press_key',
  'browser:move_mouse',
  'browser:click_coordinates',
  'browser:wait_for_selector',
  'browser:wait_for_page',
  'browser:set_viewport',
  'browser:set_page_zoom',
  'browser:extract_table',
  'browser:extract_list',
  'browser:paginate_extract',
  'browser:extract_page_content',
  'browser:generate_recipe_skeleton',
  'browser:generate_recipe_skeleton_from_snapshot',
  'browser:read_recipe_skeleton',
  'browser:run_recipe_skeleton',
  'browser:read_recipe_run',
  'browser:rerun_recipe_from_run',
]

void test('影子工具名既不在工具集合里，也不再写进全局示例表', async () => {
  const { browserTools } = await import(new URL('../../dist/tools.js', import.meta.url).href)

  for (const name of RetiredShadowToolNames) {
    assert.equal(browserTools[name], undefined, `${name} 不应该出现在工具集合里`)
  }

  const registered = [...DefaultToolContractExampleRegistry.snapshot().keys()].filter((name) =>
    name.startsWith('browser:')
  )
  const leaked = registered.filter((name) => {
    const [toolName] = name.split('.')
    return !Object.hasOwn(browserTools, toolName)
  })
  assert.deepEqual(leaked, [], '示例表里不应该留下模型看不到的浏览器工具名')
})
