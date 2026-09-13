import { expect, test } from 'bun:test'

import { getMergedToolDetails } from '../src/conversation/tool-render/messageBubbleToolModel'
import { getToolDetailItems } from '../src/conversation/tool-render/toolCallSummary'

function planBlock(objective: string) {
  return {
    type: 'tool-call' as const,
    toolCallId: 'plan-1',
    toolName: 'plan:update',
    args: {
      plan: [{ id: 'step-1', title: 'Write output', objective, status: 'running' }],
    },
  }
}

test('previews a merged plan update as its progress and the step in progress', () => {
  expect(getMergedToolDetails([planBlock('write to system workspace')])).toEqual(['0/1 · Write output'])
})

test('matches system workspace phrases only at ASCII word boundaries', () => {
  // 步骤目标只在悬停详情的步骤行里出现；只是「写到 system 工作区」的落点说明不展示。
  expect(getToolDetailItems(planBlock('write to system workspace'))).toEqual(['1. [running] Write output'])
  expect(getToolDetailItems(planBlock('write to nonsystem workspacey'))).toEqual([
    '1. [running] Write output · write to nonsystem workspacey',
  ])
})
