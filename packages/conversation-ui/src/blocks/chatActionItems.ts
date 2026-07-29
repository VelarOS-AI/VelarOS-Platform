import type { ConversationActionItem } from '../projection'
import { isCommandToolName, isFileChangeToolName } from '../tool-render/toolActivityPredicates'

import type { ChatMessage, ToolCallBlock } from '#contracts'
import { platformCompatibility } from '#internal/platform'
import { isBlank, isBoolean, isPlainObject, isString, isTrue, optionalWhen } from '#internal/runtime'

function normalizePathCandidate(value: any): Nullable<string> {
  if (!isString(value)) return null

  const normalized = value.trim()
  return isBlank(normalized) ? null : normalized
}

function getPathLabel(path: string): string {
  return platformCompatibility.getPathTextBaseName(path) || path
}

function buildPathDetail(path: string, title: string): string | undefined {
  const normalizedPath = platformCompatibility.normalizePathTextForComparison(path)
  const normalizedTitle = platformCompatibility.normalizePathTextForComparison(title)

  return optionalWhen(!(normalizedPath === normalizedTitle), path)
}

function readObjectValue(record: Record<string, any>, key: string): any {
  return optionalWhen(!Object.is(record[key], undefined), record[key])
}

function buildFileActionItem(
  key: string,
  action: ConversationActionItem['action'],
  path: string,
  openPath?: string
): ConversationActionItem {
  const title = getPathLabel(path)

  return {
    key,
    kind: 'file',
    action,
    title,
    detail: buildPathDetail(path, title),
    openPath,
  }
}

function normalizeActionPathKey(item: ConversationActionItem): string {
  return platformCompatibility
    .normalizePathTextForComparison(item.openPath ?? item.detail ?? item.title)
    .toLowerCase()
}

function shouldPreferIncomingActionItem(
  existing: ConversationActionItem,
  incoming: ConversationActionItem
): boolean {
  if (existing.action === 'file' && incoming.action === 'opened') return false

  if (existing.action === 'opened' && incoming.action === 'file') return true

  return false
}

function shouldMergeActionItemsForSamePath(
  existing: ConversationActionItem,
  incoming: ConversationActionItem
): boolean {
  return (
    (existing.action === 'file' && incoming.action === 'opened') ||
    (existing.action === 'opened' && incoming.action === 'file')
  )
}

function mergeActionItemsForSamePath(
  existing: ConversationActionItem,
  incoming: ConversationActionItem
): ConversationActionItem {
  const preferred = shouldPreferIncomingActionItem(existing, incoming) ? incoming : existing
  const fallback = preferred === existing ? incoming : existing

  return {
    ...preferred,
    openPath: preferred.openPath ?? fallback.openPath,
  }
}

function extractActionItemsFromTool(block: ToolCallBlock): ConversationActionItem[] {
  if (!isPlainObject(block.result)) return []

  const result = block.result

  // move_file 需要在 isFileChangeToolName 判断前先处理：
  // 它属于 FileChangeTool（工作区文件渲染器需要），但同时也要生成 "moved" action item。
  if (block.toolName === 'move_file') {
    const toPath = normalizePathCandidate(readObjectValue(result, 'toPath'))
    return toPath ? [buildFileActionItem(`move:${toPath}`, 'moved', toPath, toPath)] : []
  }

  if (isFileChangeToolName(block.toolName)) return []

  if (isCommandToolName(block.toolName)) return []

  switch (block.toolName) {
    case 'delete_file': {
      const path = normalizePathCandidate(readObjectValue(result, 'path'))
      return path ? [buildFileActionItem(`delete:${path}`, 'deleted', path)] : []
    }
    case 'open_path': {
      const path = normalizePathCandidate(readObjectValue(result, 'path'))
      return path ? [buildFileActionItem(`open:${path}`, 'opened', path, path)] : []
    }
    case 'reveal_path': {
      const path = normalizePathCandidate(readObjectValue(result, 'path'))
      return path ? [buildFileActionItem(`reveal:${path}`, 'revealed', path, path)] : []
    }
    case 'open_application': {
      const targetPath = normalizePathCandidate(readObjectValue(result, 'targetPath'))
      return targetPath
        ? [buildFileActionItem(`application:${targetPath}`, 'opened', targetPath, targetPath)]
        : []
    }
    case 'open': {
      const targetPath =
        normalizePathCandidate(readObjectValue(result, 'path')) ??
        normalizePathCandidate(readObjectValue(result, 'targetPath'))
      if (!targetPath) return []

      const revealed = readObjectValue(result, 'revealed')
      const action = isTrue(revealed) ? 'revealed' : 'opened'
      return [buildFileActionItem(`open:${action}:${targetPath}`, action, targetPath, targetPath)]
    }
    default: {
      const genericPath = normalizePathCandidate(readObjectValue(result, 'path'))
      const created = readObjectValue(result, 'created')
      const opened = readObjectValue(result, 'opened')
      const deleted = readObjectValue(result, 'deleted')

      if (!genericPath || ![created, opened, deleted].some((value) => isBoolean(value))) return []

      if (isTrue(deleted)) return [buildFileActionItem(`generic-delete:${genericPath}`, 'deleted', genericPath)]

      if (isTrue(opened)) return [
          buildFileActionItem(`generic-open:${genericPath}`, 'opened', genericPath, genericPath),
        ]

      return [buildFileActionItem(`generic-file:${genericPath}`, 'file', genericPath, genericPath)]
    }
  }
}

export function extractChatActionItems(message: Pick<ChatMessage, 'blocks'>): ConversationActionItem[] {
  const items = new Map<string, ConversationActionItem>()
  const itemKeysByPath = new Map<string, string>()

  for (const block of message.blocks) {
    if (block.type !== 'tool-call') {
      continue
    }

    for (const item of extractActionItemsFromTool(block)) {
      const pathKey = normalizeActionPathKey(item)
      const existingItemKey = itemKeysByPath.get(pathKey)
      if (existingItemKey) {
        const existing = items.get(existingItemKey)
        if (existing && shouldMergeActionItemsForSamePath(existing, item)) {
          items.set(existingItemKey, mergeActionItemsForSamePath(existing, item))
          continue
        }
      }

      if (!items.has(item.key)) {
        items.set(item.key, item)
        if (item.action === 'file' || item.action === 'opened') {
          itemKeysByPath.set(pathKey, item.key)
        }
      }
    }
  }

  return [...items.values()]
}
