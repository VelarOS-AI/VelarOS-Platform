import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { getThinkingStageLabel } from '../../packages/ui/src/conversation/status/thinkingStageLabel'

void describe('thinking stage label', () => {
  void test('does not publish a partially streamed sentence character by character', () => {
    assert.equal(getThinkingStageLabel('让'), null)
    assert.equal(getThinkingStageLabel('让我'), null)
    assert.equal(getThinkingStageLabel('让我读取所有输入文件'), null)
  })

  void test('publishes once the first sentence or line is complete', () => {
    assert.equal(
      getThinkingStageLabel('让我读取所有输入文件的内容。后续继续分析。'),
      '让我读取所有输入文件的内容'
    )
    assert.equal(getThinkingStageLabel('### 检查项目结构\n继续处理'), '检查项目结构')
  })

  void test('uses a stable fixed prefix for a long unpunctuated stream', () => {
    const prefix = '这是一个没有句号但已经足够长的思考阶段说明用于验证状态栏不会继续随着后续字符发生变化'.repeat(2)
    const first = getThinkingStageLabel(prefix)
    const extended = getThinkingStageLabel(`${prefix}并且这里还有更多内容`)

    assert.ok(first?.endsWith('…'))
    assert.equal(extended, first)
  })
})
