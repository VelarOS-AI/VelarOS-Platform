import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ProcessedActivityAutoCollapseWindowMs,
  shouldAnimateLiveToolActivity,
  shouldGroupProcessedActivityDisclosure,
  shouldRenderActivityGroupDisclosure,
  shouldRenderProcessedActivityDisclosure,
  shouldRequestProcessedActivityAutoCollapse,
} from '../../packages/ui/src/conversation/blocks/AssistantMessageSegments'
import type { MessageRenderSegment } from '../../packages/ui/src/conversation/blocks/messageBubbleRenderModel'
import { shouldRenderThinkingAsFlat } from '../../packages/ui/src/conversation/blocks/MessageMarkdownBlocks'
import { shouldInitiallyExpandToolActivityDisclosure } from '../../packages/ui/src/conversation/blocks/MessageToolActivity'
import {
  planStreamFade,
  splitStreamFadeText,
} from '../../packages/ui/src/conversation/blocks/streamTextFade'
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
  void test('a message that just finished streaming asks once to auto-collapse its processed activity', () => {
    const streaming = { messageId: 'assistant-1', isStreaming: true }
    const finished = { messageId: 'assistant-1', isStreaming: false }
    assert.equal(shouldRequestProcessedActivityAutoCollapse(streaming, finished), true)
    // 一直没流式过（历史消息、重挂载）、重新开始流式、换成另一条消息：都不发起。
    assert.equal(shouldRequestProcessedActivityAutoCollapse(finished, finished), false)
    assert.equal(shouldRequestProcessedActivityAutoCollapse(finished, streaming), false)
    assert.equal(
      shouldRequestProcessedActivityAutoCollapse(streaming, { messageId: 'assistant-2', isStreaming: false }),
      false
    )
  })

  void test('the collapse request outlives the re-renders that follow a completion', () => {
    const source = readFileSync(
      fileURLToPath(
        new URL('../../packages/ui/src/conversation/blocks/AssistantMessageSegments.tsx', import.meta.url)
      ),
      'utf8'
    )
    // 请求锁存在状态里，按保留时长撤下；不再由渲染期读一次 ref 决定（下一次重渲染就会把它翻回去）。
    assert.match(source, /const shouldAutoCollapseProcessedActivity = !isStreaming && autoCollapseRequested/u)
    assert.doesNotMatch(source, /!isStreaming && recentlyStreamingMessageIdRef\.current === messageId\s*\n\s*\/\/ 流式结束/u)
    assert.match(
      source,
      /timers\.after\(\s*ProcessedActivityAutoCollapseWindowMs,\s*\(\) => setAutoCollapseRequested\(false\)/u
    )
    assert.ok(ProcessedActivityAutoCollapseWindowMs >= 500)
  })

  void test('keeps the completion-collapse request live after the disclosure has mounted', () => {
    assert.equal(
      shouldInitiallyExpandToolActivityDisclosure({
        autoCollapseAfterPaint: true,
        defaultExpanded: false,
        hasRunningTool: false,
      }),
      true
    )

    const source = readFileSync(
      fileURLToPath(
        new URL(
          '../../packages/ui/src/conversation/blocks/MessageToolActivity.tsx',
          import.meta.url
        )
      ),
      'utf8'
    )
    assert.match(
      source,
      /autoCollapseAfterPaint\s*&&\s*!hasRunningTool/u
    )
    assert.doesNotMatch(source, /useRef\(\s*autoCollapseAfterPaint/u)
  })

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

  void test('fades only the newly appended text tail, never replaying what is already on screen', () => {
    // 已上屏 5 个字、它们的批次早已淡完：只有新接上的尾巴淡入。
    const plan = planStreamFade({
      ledger: { length: 5, chunks: [] },
      now: 1_000,
      sourceLength: 11,
      mounted: true,
    })
    assert.deepEqual(splitStreamFadeText('hello world', 0, plan), [
      { text: 'hello', start: 0, bornAt: null },
      { text: ' world', start: 5, bornAt: 1_000 },
    ])
    // 没有新字时什么都不淡。
    const idle = planStreamFade({ ledger: { length: 11, chunks: [] }, now: 1_000, sourceLength: 11, mounted: true })
    assert.deepEqual(splitStreamFadeText('hello world', 0, idle), [
      { text: 'hello world', start: 0, bornAt: null },
    ])
    // 首次见到的长块（切回、首次打开）整段当作已显示。
    assert.deepEqual(
      planStreamFade({ ledger: undefined, now: 1_000, sourceLength: 400, mounted: false }),
      []
    )
  })
})
