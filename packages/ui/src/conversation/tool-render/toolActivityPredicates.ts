import { hasToolActivityKind } from '#internal/toolPresentationCatalog'

/**
 * 工具活动种类谓词——从 UI 自有工具展示元数据目录派生。
 *
 * 原 desktop `@shared/constants/toolRendering` 的活动谓词随 message tool 视图件入包；宿主 compat 层保留
 * 其自用面。`isCommandToolName` 额外并入历史别名 `run_command`（与宿主同值）。
 */
const LegacyCommandActivityToolNameSet = new Set<string>(['run_command'])

export function isCommandToolName(toolName: string): boolean {
  return hasToolActivityKind(toolName, 'command') || LegacyCommandActivityToolNameSet.has(toolName)
}

export function isFileChangeToolName(toolName: string): boolean {
  return hasToolActivityKind(toolName, 'file-change')
}

export function isDirectFileReadActivityToolName(toolName: string): boolean {
  return hasToolActivityKind(toolName, 'direct-file-read')
}

export function isMultiFileReadActivityToolName(toolName: string): boolean {
  return hasToolActivityKind(toolName, 'multi-file-read')
}

export function isSearchActivityToolName(toolName: string): boolean {
  return hasToolActivityKind(toolName, 'search')
}

export function isFileMoveLegacyActivityToolName(toolName: string): boolean {
  return hasToolActivityKind(toolName, 'file-move')
}

export function isUserInputActivityToolName(toolName: string): boolean {
  return hasToolActivityKind(toolName, 'user-input')
}

export function isUserConfirmationActivityToolName(toolName: string): boolean {
  return hasToolActivityKind(toolName, 'user-confirmation')
}

export function isVerificationCommandActivityToolName(toolName: string): boolean {
  return hasToolActivityKind(toolName, 'verification-command')
}
