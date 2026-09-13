import {
  type ConversationTranslator,
  conversationTranslatorRuntime,
} from '../i18n'

import { isCommandToolName } from './toolActivityPredicates'
import type { MergedToolCallGroup } from './toolCallRenderGrouping'
import { getToolMergedDetailItems } from './toolCallSummary'

import type { AppLocale, ToolCallBlock as ToolCallBlockType } from '#contracts'
import { isBlank, isEmpty } from '#internal/runtime'
import { asRecord, readStringPreserveOuterWhitespace } from '#internal/unknownJsonRecord'

export function getMergedToolDetails(
  blocks: ToolCallBlockType[],
  formatPathForDisplay?: (path: string) => string,
  locale?: AppLocale,
  translatorRuntime: ConversationTranslator = conversationTranslatorRuntime
): string[] {
  const seen = new Set<string>()
  const details: string[] = []

  for (const block of blocks) {
    // 每次调用在行内点名的对象与它单独成行时一致（计划更新即「进度 · 当前步骤」）。
    const blockDetails = getToolMergedDetailItems(
      block,
      formatPathForDisplay,
      locale,
      translatorRuntime
    )

    for (const detail of blockDetails) {
      if (!detail || seen.has(detail)) continue

      seen.add(detail)
      details.push(detail)
    }
  }

  return details
}

function getToolBlockCommand(block: ToolCallBlockType): Nullable<string> {
  const resultRecord = asRecord(block.result)
  const argsRecord = asRecord(block.args)
  return (
    readStringPreserveOuterWhitespace(resultRecord, 'command') ??
    readStringPreserveOuterWhitespace(argsRecord, 'command')
  )
}

export function getMergedCommandCopyValue(group: MergedToolCallGroup): Nullable<string> {
  if (!isCommandToolName(group.toolName)) return null

  const seen = new Set<string>()
  const commands: string[] = []

  for (const block of group.blocks) {
    const command = getToolBlockCommand(block)
    if (!command || isBlank(command.trim()) || seen.has(command)) continue

    seen.add(command)
    commands.push(command)
  }

  if (isEmpty(commands)) return null

  return commands.join('\n')
}

export function shouldRenderToolBlockCompact(toolName: string): boolean {
  return toolName !== 'apply_edits'
}
