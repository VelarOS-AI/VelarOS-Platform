import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  shouldAnimateLiveToolActivity,
  shouldGroupProcessedActivityDisclosure,
  shouldRenderActivityGroupDisclosure,
  shouldRenderProcessedActivityDisclosure,
} from '../../packages/ui/src/conversation/blocks/AssistantMessageSegments'
import type { MessageRenderSegment } from '../../packages/ui/src/conversation/blocks/messageBubbleRenderModel'
import {
  resolveIncrementalStreamFadeText,
  resolveStreamingTextFadeBaseline,
  shouldRenderThinkingAsFlat,
} from '../../packages/ui/src/conversation/blocks/MessageMarkdownBlocks'
import {
  getToolActivityMotionRevision,
  resolveToolActivityMotionKind,
} from '../../packages/ui/src/conversation/blocks/ToolActivityMotion'
import type { ToolCallBlock } from '../../packages/ui/src/conversation/contracts'
import {
  shouldForceGroupedActivityFlat,
  shouldInlineGroupedActivityMessage,
} from '../../packages/ui/src/conversation/shell/ChatTranscript'

function toolBlock(toolCallId: string, options: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return {
    type: 'tool-call',
    toolCallId,
    toolName: 'system:read_file',
    args: {},
    isRunning: true,
    ...options,
  }
}

function activitySegment(block: ToolCallBlock): MessageRenderSegment {
  return {
    kind: 'activity-group',
    key: `activity:${block.toolCallId}`,
    blocks: [block],
    segments: [
      {
        kind: 'block',
        key: `tool:${block.toolCallId}`,
        block,
      },
    ],
  }
}

void describe('live chat activity presentation', () => {
  void test('keeps closed consecutive disclosures inline while exit content is still mounted', () => {
    const stylesheet = readFileSync(
      fileURLToPath(
        new URL(
          '../../packages/ui/src/conversation/blocks/MessageBubble.module.css',
          import.meta.url
        )
      ),
      'utf8'
    )

    assert.match(
      stylesheet,
      /\.toolActivitySummaryRow\s*>\s*\.toolActivityDisclosure:has\(> \.toolActivityToggle\[aria-expanded='true'\]\)/
    )
    assert.doesNotMatch(
      stylesheet,
      /\.toolActivitySummaryRow\s*>\s*\.toolActivityDisclosure:has\(\.toolActivityBodyShell\)/
    )

    const block = toolBlock('tool-inline', { isRunning: false })
    const thinkingSegment: MessageRenderSegment = {
      kind: 'segment',
      key: 'thinking:inline',
      segment: {
        kind: 'block',
        key: 'thinking:inline',
        block: { type: 'thinking', text: '继续检查。' },
      },
    }
    const textSegment: MessageRenderSegment = {
      kind: 'segment',
      key: 'text:break',
      segment: {
        kind: 'block',
        key: 'text:break',
        block: { type: 'text', text: '正文另起一行。' },
      },
    }

    assert.equal(shouldGroupProcessedActivityDisclosure(activitySegment(block)), true)
    assert.equal(shouldGroupProcessedActivityDisclosure(thinkingSegment), true)
    assert.equal(shouldGroupProcessedActivityDisclosure(textSegment), false)
  })

  void test('keeps thinking and tool activity flat while the message is streaming', () => {
    const block = toolBlock('tool-1')

    assert.equal(shouldRenderThinkingAsFlat({ autoCollapse: false, isStreaming: true }), true)
    assert.equal(shouldRenderActivityGroupDisclosure(activitySegment(block), true), false)
    assert.equal(shouldRenderActivityGroupDisclosure(activitySegment(block), false), true)
    assert.equal(
      shouldAnimateLiveToolActivity({
        armedMessageId: null,
        isStreaming: true,
        messageId: 'message-1',
      }),
      false
    )
    assert.equal(
      shouldAnimateLiveToolActivity({
        armedMessageId: 'message-1',
        isStreaming: true,
        messageId: 'message-1',
      }),
      true
    )
  })

  void test('keeps grouped child activity flat so the owning run creates one disclosure', () => {
    assert.equal(shouldForceGroupedActivityFlat(true), true)
    assert.equal(shouldForceGroupedActivityFlat(false), false)

    assert.equal(
      shouldInlineGroupedActivityMessage(
        {
          id: 'activity-only',
          role: 'assistant',
          timestamp: 1,
          blocks: [
            { type: 'thinking', text: '检查。' },
            toolBlock('tool-inline'),
          ],
        },
        false
      ),
      true
    )
    assert.equal(
      shouldInlineGroupedActivityMessage(
        {
          id: 'activity-with-text',
          role: 'assistant',
          timestamp: 1,
          blocks: [{ type: 'text', text: '阶段汇报。' }],
        },
        false
      ),
      false
    )
  })

  void test('only folds grouped guidance activity after the owning run is processed', () => {
    assert.equal(
      shouldRenderProcessedActivityDisclosure({
        hasFinalSummaryText: false,
        hasGroupedRunActivity: true,
        shouldUseProcessedActivityBoundary: false,
      }),
      false
    )
    assert.equal(
      shouldRenderProcessedActivityDisclosure({
        hasFinalSummaryText: false,
        hasGroupedRunActivity: true,
        shouldUseProcessedActivityBoundary: true,
      }),
      true
    )
  })

  void test('animates a tool once on entry and only on semantic phase updates', () => {
    const running = toolBlock('tool-1')
    const runningProgressA = toolBlock('tool-1', { progress: '1 / 10' })
    const runningProgressB = toolBlock('tool-1', { progress: '2 / 10' })
    const complete = toolBlock('tool-1', {
      isRunning: false,
      result: { ok: true },
    })
    const runningRevision = getToolActivityMotionRevision([running])
    const progressRevision = getToolActivityMotionRevision([runningProgressA])

    assert.equal(
      resolveToolActivityMotionKind({
        isStreaming: true,
        revision: runningRevision,
      }),
      'enter'
    )
    assert.equal(getToolActivityMotionRevision([runningProgressB]), progressRevision)
    assert.equal(
      resolveToolActivityMotionKind({
        isStreaming: true,
        previousRevision: progressRevision,
        revision: getToolActivityMotionRevision([complete]),
      }),
      'update'
    )
    assert.equal(
      resolveToolActivityMotionKind({
        isStreaming: false,
        previousRevision: runningRevision,
        revision: getToolActivityMotionRevision([complete]),
      }),
      'none'
    )

    const groupedRevision = getToolActivityMotionRevision([runningProgressA, toolBlock('tool-2')])
    assert.equal(
      resolveToolActivityMotionKind({
        isStreaming: true,
        previousRevision: progressRevision,
        revision: groupedRevision,
      }),
      'update'
    )
  })

  void test('fades only the newly appended text tail as one batch', () => {
    assert.equal(resolveStreamingTextFadeBaseline(), Number.MAX_SAFE_INTEGER)
    assert.equal(resolveStreamingTextFadeBaseline(42), 42)
    assert.deepEqual(
      resolveIncrementalStreamFadeText({
        previousTextLength: 5,
        text: 'hello world',
        textStart: 0,
      }),
      { unchangedText: 'hello', newText: ' world' }
    )
    assert.deepEqual(
      resolveIncrementalStreamFadeText({
        previousTextLength: 11,
        text: 'hello world',
        textStart: 0,
      }),
      { unchangedText: 'hello world', newText: '' }
    )
    assert.deepEqual(
      resolveIncrementalStreamFadeText({
        previousTextLength: 0,
        text: '新的中文尾部',
        textStart: 0,
      }),
      { unchangedText: '', newText: '新的中文尾部' }
    )
  })
})
