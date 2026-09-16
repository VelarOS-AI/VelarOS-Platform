// 用途：钉住 recipe / 快照 / 运行记录的路径只有一套规则。
// 历史事故：工具侧拒绝任何含 `..` 的文件名（recipes/a..b.json 被误拒）且不认反斜杠；
// Desktop 面板的预览先把反斜杠换成 `/` 再按段判断——同一个文件面板能预览、工具读不了，
// 或者反过来。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { normalizeBrowserRecipePath } from '../../src/utils/artifacts.js'
import {
  requirePageSnapshotPath,
  requireRecipePath,
  requireRunPath,
} from '../../src/utils/recipes/paths.js'

void describe('站点工区产物路径', () => {
  void test('工具与面板预览对同一个路径给同一个答案', () => {
    for (const path of ['recipes/a.json', 'recipes\\a.json', '/recipes/a.json', ' recipes/a.json ']) {
      assert.equal(requireRecipePath(path), 'recipes/a.json')
      assert.equal(normalizeBrowserRecipePath(path), 'recipes/a.json')
    }
  })

  void test('文件名里的 .. 不算穿越', () => {
    assert.equal(requireRecipePath('recipes/a..b.json'), 'recipes/a..b.json')
    assert.equal(normalizeBrowserRecipePath('recipes/a..b.json'), 'recipes/a..b.json')
  })

  void test('整段是 .. 或 . 的路径一律拒绝', () => {
    for (const path of [
      'recipes/../secrets.json',
      'recipes/./a.json',
      'recipes\\..\\secrets.json',
      '../recipes/a.json',
    ]) {
      assert.throws(() => requireRecipePath(path), /recipes\//u)
      assert.throws(() => normalizeBrowserRecipePath(path), /recipes\//u)
    }
  })

  void test('目录与扩展名照旧把关', () => {
    assert.throws(() => requireRecipePath('pages/a.json'), /recipes\//u)
    assert.throws(() => requireRecipePath('recipes/a.txt'), /recipes\//u)
    assert.throws(() => requireRecipePath('recipes'), /recipes\//u)
    assert.equal(requirePageSnapshotPath('pages\\snap.json'), 'pages/snap.json')
    assert.equal(requireRunPath('runs/2026-01-01.json'), 'runs/2026-01-01.json')
    assert.throws(() => requireRunPath('runs/../pages/a.json'), /runs\//u)
  })
})
