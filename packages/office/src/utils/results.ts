/** 统一的工具返回结构：授权被拒、外部命令失败、缺少转换器时给模型看的形状。 */

import type {
  OfficeOutput,
  OfficeProjectAuthorizationDecision,
  OfficeSystemCommandResult,
  OfficeSystemToolInstallAlternative,
} from '../types/office.js'

/** Office 写操作被授权拒绝时的统一返回结构：一个字节都没写。 */
export function buildProjectMutationSkippedResult(
  authorization: OfficeProjectAuthorizationDecision
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

/** 构建“用浏览器线上处理”的替代方案。 */
export function createBrowserOnlineAlternative(input: {
  zhDescription: string
  enDescription: string
  zhDraft: string
  enDraft: string
}): OfficeSystemToolInstallAlternative {
  return {
    id: 'browser-online',
    label: {
      'zh-CN': '用浏览器线上处理',
      'en-US': 'Use browser online',
    },
    description: {
      'zh-CN': input.zhDescription,
      'en-US': input.enDescription,
    },
    draft: {
      'zh-CN': input.zhDraft,
      'en-US': input.enDraft,
    },
  }
}
