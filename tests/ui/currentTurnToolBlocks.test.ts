import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { ChatMessage, ToolCallBlock } from '../../packages/ui/src/conversation/contracts/conversation'
import {
  getGoalLifecycleRefreshKey,
  getLatestCurrentTurnToolBlock,
} from '../../packages/ui/src/conversation/shell/currentTurnToolBlocks'

function toolCall(toolName: string, toolCallId: string, extra: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return { type: 'tool-call', toolCallId, toolName, args: {}, ...extra } as ToolCallBlock
}

function assistant(id: string, blocks: ToolCallBlock[]): ChatMessage {
  return { id, role: 'assistant', blocks, timestamp: 1 } as ChatMessage
}

function turnInput(id: string): ChatMessage {
  return {
    id,
    role: 'user',
    conversationKind: 'turn-input',
    blocks: [{ type: 'text', text: 'go' }],
    timestamp: 1,
  } as ChatMessage
}

const goalArgs = { objective: 'ship the refactor' }

void describe('current-turn tool blocks for the sticky dock', () => {
  void test('finds the last matching tool call of the current turn only', () => {
    const messages = [
      assistant('a1', [toolCall('plan:update', 'old-plan')]),
      turnInput('u2'),
      assistant('a2', [toolCall('goal:create', 'goal-1'), toolCall('plan:update', 'plan-1')]),
    ]

    assert.equal(getLatestCurrentTurnToolBlock(messages, (name) => name === 'plan:update')?.toolCallId, 'plan-1')
    assert.equal(getLatestCurrentTurnToolBlock(messages.slice(0, 2), (name) => name === 'plan:update'), null)
  })

  void test('re-reads the goal as soon as a goal tool of this turn settles, even while the run continues', () => {
    const running = [
      turnInput('u1'),
      assistant('a1', [toolCall('goal:create', 'goal-1', { args: goalArgs, isRunning: true })]),
    ]
    const settled = [
      turnInput('u1'),
      assistant('a1', [
        toolCall('goal:create', 'goal-1', {
          args: goalArgs,
          isRunning: false,
          finishedAt: 1_000,
          result: { status: 'active', goal: { objective: 'ship the refactor', status: 'active' } },
        }),
        toolCall('plan:update', 'plan-1'),
      ]),
    ]

    const runningKey = getGoalLifecycleRefreshKey(running)
    const settledKey = getGoalLifecycleRefreshKey(settled)
    assert.ok(runningKey)
    assert.ok(settledKey)
    // 参数里的 objective 让「进行中」与「已落定」的签名相同，完成时刻必须让钥匙变化，否则落定后不会再读。
    assert.notEqual(runningKey, settledKey)
    // 之后同一轮只追加计划等其它工具，不重复触发读取。
    assert.equal(getGoalLifecycleRefreshKey([...settled, assistant('a2', [toolCall('project:read', 'r1')])]), settledKey)
  })

  void test('has no goal refresh key when the current turn made no goal change', () => {
    const messages = [
      assistant('a1', [toolCall('goal:create', 'goal-old', { args: goalArgs, finishedAt: 1 })]),
      turnInput('u2'),
      assistant('a2', [toolCall('plan:update', 'plan-1')]),
    ]

    assert.equal(getGoalLifecycleRefreshKey(messages), null)
  })
})
