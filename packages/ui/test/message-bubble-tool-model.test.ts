import { expect, test } from 'bun:test'

import { getMergedToolDetails } from '../src/conversation/tool-render/messageBubbleToolModel'

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

test('matches system workspace phrases only at ASCII word boundaries', () => {
  expect(getMergedToolDetails([planBlock('write to system workspace')])).toEqual(['Write output'])
  expect(getMergedToolDetails([planBlock('write to nonsystem workspacey')])).toEqual([
    'Write output · write to nonsystem workspacey',
  ])
})
