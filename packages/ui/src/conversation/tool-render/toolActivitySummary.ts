import {
  type ConversationTranslator,
  conversationTranslatorRuntime,
} from '../i18n'

import {
  isCommandToolName,
  isDirectFileReadActivityToolName,
  isFileChangeToolName,
  isFileMoveLegacyActivityToolName,
  isMultiFileReadActivityToolName,
  isSearchActivityToolName,
  isUserConfirmationActivityToolName,
  isUserInputActivityToolName,
  isVerificationCommandActivityToolName,
} from './toolActivityPredicates'

import type { AppLocale, ToolCallBlock } from '#contracts'
import { isArray, isBlank, isEmpty,isFalse, isPresent, isString } from '#internal/runtime'
import {
  asRecord,
  readBoolean,
  readFirstString,
  readRecordsArray,
  readString,
  readStringArray,
} from '#internal/unknownJsonRecord'

interface ToolActivityCounts {
  editedFiles: Set<string>
  exploredFiles: Set<string>
  searchCount: number
  commandCount: number
  userInputCount: number
  userConfirmationCount: number
  planUpdateCount: number
  genericCount: number
}

function addPath(target: Set<string>, path: LooseOptional<string>): void {
  if (!isPresent(path) || isBlank(path.trim())) return

  target.add(path.trim())
}

function addPaths(target: Set<string>, paths: string[]): void {
  paths.forEach((path) => addPath(target, path))
}

function collectPathsFromResultFiles(block: ToolCallBlock, target: Set<string>): void {
  const result = asRecord(block.result)
  const files = readRecordsArray(result, 'files')

  files.forEach((file) => {
    addPath(target, readFirstString(file?.toPath, file?.path))
  })
}

function collectPatchPaths(patch: Nullable<string>, target: Set<string>): void {
  if (!patch) return

  patch.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/)
    addPath(target, match?.[1] ?? moveMatch?.[1])
  })
}

function collectEditPaths(block: ToolCallBlock, target: Set<string>): boolean {
  if (block.error || !isFileChangeToolName(block.toolName)) return false

  const args = asRecord(block.args)
  const result = asRecord(block.result)
  const isDryRun = !!readBoolean(args, 'dryRun') || !!readBoolean(result, 'dryRun')
  const changed = readBoolean(result, 'changed')

  if (isDryRun || isFalse(changed)) return false

  const sizeBefore = target.size

  // 工作区内核的 ws_edit / ws_rollback 返回 { changedFiles, newRevisions }（已真正写盘）；
  // 只有带 newRevisions 的结果才计入「已编辑」统计。
  if (isArray(result?.changedFiles) && isPresent(asRecord(result?.newRevisions))) {
    result.changedFiles.forEach((item) => {
      addPath(target, isString(item) ? item : readString(asRecord(item), 'path'))
    })
    if (target.size > sizeBefore) return true
  }

  // 优先读规范字段 fileChanges
  if (isArray(result?.fileChanges)) {
    result.fileChanges.forEach((item) => {
      const rec = asRecord(item)
      addPath(target, readString(rec, 'path'))
    })
    if (target.size > sizeBefore) return true
  }

  // 兼容旧格式
  const change = asRecord(result?.change)
  collectPathsFromResultFiles(block, target)
  addPath(target, readString(change, 'path'))
  addPath(target, readFirstString(result?.toPath, result?.path))
  addPath(target, readFirstString(args?.toPath, args?.path))
  collectPatchPaths(readString(args, 'patch'), target)

  readRecordsArray(args, 'edits').forEach((edit) => {
    addPath(target, readString(edit, 'path'))
  })

  return target.size > sizeBefore
}

function collectExploredPaths(block: ToolCallBlock, target: Set<string>): void {
  const args = asRecord(block.args)
  const result = asRecord(block.result)

  if (block.toolName === 'ws_read') {
    const batch = readRecordsArray(result, 'files')
    if (batch.length) {
      batch.forEach((file) => {
        const snap = asRecord(file.snapshot)
        addPath(target, readString(snap, 'path'))
      })
      return
    }
    addPath(target, readFirstString(asRecord(result?.snapshot)?.path, args?.path))
    addPaths(target, readStringArray(args, 'path'))
    addPaths(target, readStringArray(args, 'paths'))
    return
  }

  if (isDirectFileReadActivityToolName(block.toolName)) {
    addPath(target, readFirstString(result?.path, args?.path))
    return
  }

  if (!isMultiFileReadActivityToolName(block.toolName)) return

  const resultFiles = readRecordsArray(result, 'files')
  if (resultFiles.length) {
    resultFiles.forEach((file) => addPath(target, readString(file, 'path')))
    return
  }

  addPaths(target, readStringArray(args, 'paths'))
}

function getCommandCount(block: ToolCallBlock): number {
  if (isCommandToolName(block.toolName)) return 1

  if (!isVerificationCommandActivityToolName(block.toolName)) return 0

  const steps = readRecordsArray(asRecord(block.result), 'steps')
  const stepCommandCount = steps.filter((step) => !!readString(step, 'command')).length
  return stepCommandCount || 1
}

function buildActivityParts(
  counts: ToolActivityCounts,
  locale: AppLocale,
  conversationTranslate: ConversationTranslator['translate']
): string[] {
  const parts: string[] = []

  if (counts.editedFiles.size) {
    parts.push(
      conversationTranslate(
        locale,
        counts.editedFiles.size === 1
          ? 'toolSummary.activityEditedFilesOne'
          : 'toolSummary.activityEditedFilesMany',
        { count: counts.editedFiles.size }
      )
    )
  }

  if (counts.exploredFiles.size) {
    parts.push(
      conversationTranslate(
        locale,
        counts.exploredFiles.size === 1
          ? 'toolSummary.activityExploredFilesOne'
          : 'toolSummary.activityExploredFilesMany',
        { count: counts.exploredFiles.size }
      )
    )
  }

  if (counts.searchCount) {
    parts.push(
      conversationTranslate(
        locale,
        counts.searchCount === 1
          ? 'toolSummary.activitySearchCountOne'
          : 'toolSummary.activitySearchCountMany',
        { count: counts.searchCount }
      )
    )
  }

  if (counts.commandCount) {
    parts.push(
      conversationTranslate(
        locale,
        counts.commandCount === 1
          ? 'toolSummary.activityCommandCountOne'
          : 'toolSummary.activityCommandCountMany',
        { count: counts.commandCount }
      )
    )
  }

  if (counts.userInputCount) {
    parts.push(
      conversationTranslate(
        locale,
        counts.userInputCount === 1
          ? 'toolSummary.activityAskedUserCountOne'
          : 'toolSummary.activityAskedUserCountMany',
        { count: counts.userInputCount }
      )
    )
  }

  if (counts.userConfirmationCount) {
    parts.push(
      conversationTranslate(
        locale,
        counts.userConfirmationCount === 1
          ? 'toolSummary.activityConfirmationCountOne'
          : 'toolSummary.activityConfirmationCountMany',
        { count: counts.userConfirmationCount }
      )
    )
  }

  if (counts.genericCount) {
    parts.push(
      conversationTranslate(
        locale,
        counts.genericCount === 1
          ? 'toolSummary.activityUsedToolCountOne'
          : 'toolSummary.activityUsedToolCountMany',
        { count: counts.genericCount }
      )
    )
  }

  if (isEmpty(parts) && counts.planUpdateCount) {
    parts.push(
      conversationTranslate(
        locale,
        counts.planUpdateCount === 1
          ? 'toolSummary.activityPlanUpdateCountOne'
          : 'toolSummary.activityPlanUpdateCountMany',
        { count: counts.planUpdateCount }
      )
    )
  }

  return parts
}

export function getToolActivityGroupSummary(
  blocks: ToolCallBlock[],
  locale: AppLocale,
  translatorRuntime: ConversationTranslator = conversationTranslatorRuntime
): string {
  const conversationTranslate = translatorRuntime.translate
  const counts: ToolActivityCounts = {
    editedFiles: new Set(),
    exploredFiles: new Set(),
    searchCount: 0,
    commandCount: 0,
    userInputCount: 0,
    userConfirmationCount: 0,
    planUpdateCount: 0,
    genericCount: 0,
  }

  blocks.forEach((block) => {
    if (block.toolName === 'update_plan') {
      counts.planUpdateCount += 1
      return
    }

    if (collectEditPaths(block, counts.editedFiles)) return

    // FileChangeTool 即使 dryRun / changed=false / 出错也不计入 genericCount
    if (isFileChangeToolName(block.toolName)) return

    if (!block.error && isFileMoveLegacyActivityToolName(block.toolName)) {
      const args = asRecord(block.args)
      addPath(counts.editedFiles, readFirstString(args?.toPath, args?.fromPath, args?.path))
      return
    }

    const commandCount = getCommandCount(block)
    if (commandCount > 0) {
      counts.commandCount += commandCount
      return
    }

    if (isSearchActivityToolName(block.toolName)) {
      counts.searchCount += 1
      return
    }

    if (isUserInputActivityToolName(block.toolName)) {
      counts.userInputCount += 1
      return
    }

    if (isUserConfirmationActivityToolName(block.toolName)) {
      counts.userConfirmationCount += 1
      return
    }

    const exploredBefore = counts.exploredFiles.size
    collectExploredPaths(block, counts.exploredFiles)
    if (counts.exploredFiles.size > exploredBefore) return

    counts.genericCount += 1
  })

  return buildActivityParts(counts, locale, conversationTranslate).join(
    conversationTranslate(locale, 'toolSummary.activitySeparator')
  )
}
