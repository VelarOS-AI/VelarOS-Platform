import type { ContentBlock, ToolCallBlock as ToolCallBlockType } from '#contracts'
import { isEmpty,isPresent } from '#internal/runtime'

export const TOOL_GROUP_COLLAPSE_MIN = 4
export const TOOL_ACTIVITY_SUMMARY_EXCLUDED_TOOL_NAMES = ['ui:show_widget', 'plan:update'] as const
export const TOOL_ACTIVITY_SUMMARY_INTERACTION_TOOL_NAMES = [
  'interaction:show_action_cards',
  'interaction:confirm',
] as const

export const ToolActivitySummaryExcludedToolNameSet = new Set<string>(
  TOOL_ACTIVITY_SUMMARY_EXCLUDED_TOOL_NAMES
)
const ToolActivitySummaryInteractionToolNameSet = new Set<string>(
  TOOL_ACTIVITY_SUMMARY_INTERACTION_TOOL_NAMES
)

export interface MergedToolCallGroup {
  key: string
  toolName: string
  blocks: ToolCallBlockType[]
  representative: ToolCallBlockType
}

export type ToolRenderSegment =
  | { kind: 'block'; block: ContentBlock; key: string }
  | { kind: 'merged-tool'; group: MergedToolCallGroup; key: string }
  | { kind: 'tool-group'; blocks: ToolCallBlockType[]; key: string }

export type ToolActivitySummaryExclusionPredicate = (
  block: Pick<ToolCallBlockType, 'toolName' | 'isRunning' | 'error' | 'toolCallId'>
) => boolean

export interface ToolRenderGroupingOptions {
  isToolActivitySummaryExcludedToolCall?: ToolActivitySummaryExclusionPredicate
}

export function isToolActivitySummaryExcludedToolCall(
  block: Pick<ToolCallBlockType, 'toolName' | 'isRunning' | 'error'>
): boolean {
  if (ToolActivitySummaryInteractionToolNameSet.has(block.toolName)) return true
  if (!block.isRunning && isPresent(block.error)) return false

  return ToolActivitySummaryExcludedToolNameSet.has(block.toolName)
}

export function pickRepresentativeToolBlock(blocks: ToolCallBlockType[]): ToolCallBlockType {
  let latestError: Nullable<ToolCallBlockType> = null

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (!block) continue
    if (block.isRunning) return block
    if (!latestError && isPresent(block.error)) latestError = block
  }

  return latestError ?? blocks[blocks.length - 1] ?? blocks[0]
}

export function mergeToolCallGroups(blocks: ToolCallBlockType[]): MergedToolCallGroup[] {
  const groups: MergedToolCallGroup[] = []
  const groupByToolName = new Map<string, MergedToolCallGroup>()

  blocks.forEach((block) => {
    const existing = groupByToolName.get(block.toolName)
    if (existing) {
      existing.blocks.push(block)
      existing.representative = pickRepresentativeToolBlock(existing.blocks)
      return
    }

    const nextGroup: MergedToolCallGroup = {
      key: `merged-tool:${block.toolName}:${block.toolCallId}`,
      toolName: block.toolName,
      blocks: [block],
      representative: block,
    }
    groupByToolName.set(block.toolName, nextGroup)
    groups.push(nextGroup)
  })

  return groups
}

export function buildToolRenderSegments(
  blocks: ContentBlock[],
  collapseMin = TOOL_GROUP_COLLAPSE_MIN,
  options: ToolRenderGroupingOptions = {}
): ToolRenderSegment[] {
  const segments: ToolRenderSegment[] = []
  let pendingToolBlocks: ToolCallBlockType[] = []
  const isExcludedToolCall =
    options.isToolActivitySummaryExcludedToolCall ?? isToolActivitySummaryExcludedToolCall

  const flushPendingToolBlocks = (): void => {
    if (isEmpty(pendingToolBlocks)) return

    const mergedGroups = mergeToolCallGroups(pendingToolBlocks)

    if (mergedGroups.length >= collapseMin) {
      segments.push({
        kind: 'tool-group',
        blocks: pendingToolBlocks,
        key: `tool-group:${pendingToolBlocks[0].toolCallId}`,
      })
    } else {
      mergedGroups.forEach((group) => {
        if (group.blocks.length === 1) {
          segments.push({
            kind: 'block',
            block: group.representative,
            key: `tool:${group.representative.toolCallId}`,
          })
          return
        }

        segments.push({
          kind: 'merged-tool',
          group,
          key: group.key,
        })
      })
    }

    pendingToolBlocks = []
  }

  blocks.forEach((block, index) => {
    if (block.type === 'tool-call' && !isExcludedToolCall(block)) {
      pendingToolBlocks.push(block)
      return
    }

    flushPendingToolBlocks()
    segments.push({
      kind: 'block',
      block,
      key:
        block.type === 'tool-call'
          ? `tool:${block.toolCallId}`
          : block.type === 'thinking'
            ? `thinking:${index}`
            : block.type === 'system-tool-install-suggestion'
              ? `system-tool:${block.suggestion.id}`
              : block.type === 'capability-auto-approval'
                ? `capability-auto-approval:${block.notice.id}`
                : block.type === 'user-action-card'
                  ? `user-action-card:${block.card.id}`
                  : block.type === 'project-auto-approval'
                    ? `project-auto-approval:${block.notice.id}`
                    : `text:${index}`,
    })
  })

  flushPendingToolBlocks()
  return segments
}
