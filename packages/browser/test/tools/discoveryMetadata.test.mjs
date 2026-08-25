/**
 * @test-meta
 * title: 浏览器聚合动作可由任务意图直接发现
 * summary: 工具目录摘要必须明确暴露 URL 导航能力，不能迫使模型读取整类工具或反复搜索。
 * area: packages
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const packagePath = new URL('../../dist/tools/index.js', import.meta.url)

test('browser:act discovery summary names its primary navigation and interaction intents', async () => {
  const { browserTools } = await import(packagePath.href)
  const browserAct = browserTools['browser:act']

  assert.match(browserAct.description, /^描述：[^\n]*URL/mu)
  assert.match(browserAct.description, /^描述：[^\n]*跳转/mu)
  assert.match(browserAct.description, /^描述：[^\n]*点击/mu)
  assert.match(browserAct.description, /^描述：[^\n]*填写/mu)
  assert.match(browserAct.description, /targetRef/u)

  const weakModelTargetInput = browserAct.schema.safeParse({
    action: 'target',
    targetAction: 'fill',
    targetRef: '@e4',
    value: 'stable',
  })
  assert.equal(weakModelTargetInput.success, true)
})
