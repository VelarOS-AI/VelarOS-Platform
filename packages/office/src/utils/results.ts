/** 统一的工具返回结构：授权被拒、外部命令失败、缺少转换器时给模型看的形状。 */

import type { OfficeMutationDecision, OfficeSystemCommandResult } from '../types/office.js'
import type { OfficeOutput } from '../types/workspace.js'

/** Office 写操作被授权拒绝时的统一返回结构：一个字节都没写。 */
export function buildProjectMutationSkippedResult(
  authorization: OfficeMutationDecision
): Record<string, unknown> {
  return {
    approved: false,
    skipped: true,
    changed: false,
    rootPath: authorization.rootPath,
    rejectionMessage: authorization.rejectionMessage,
    message: authorization.message,
  }
}

/** 外部命令失败时的统一返回结构。 */
export function createCommandFailureResult(input: {
  outputPath: string
  kind: OfficeOutput['kind']
  operation: string
  commandResult: OfficeSystemCommandResult
}): Record<string, unknown> {
  return {
    changed: false,
    kind: input.kind,
    outputPath: input.outputPath,
    commandResult: input.commandResult,
    message: `${input.operation}失败：外部命令退出码 ${input.commandResult.exitCode ?? 'unknown'}。请查看 stdout/stderr。`,
  }
}
