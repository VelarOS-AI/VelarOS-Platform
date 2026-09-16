import { isArray, isEmpty, isFalse, isObject, isPlainObject,isString,isTrue } from '@velaros-ai/core'

import { hasVerificationRelevantModifiedPaths } from '../../utils/session/paths'

/**
 * 判读「一次工具调用到底算不算改了代码」的那把尺子：编辑跟踪器拿它决定要不要推进 editVersion。
 *
 * 只认构造时传进来的两份工具名清单（可变更工具、非代码变更工具），不认工具语义；结果形状则按几种历史形态
 * 逐个嗅探。每个编辑跟踪器持一份，跟着会话活。
 */
export interface CodingSessionEditResultHelperApi {
  /** 这个工具名是否属于「会改代码」的那一类；是的话它的成功结果就该让编辑版本 +1。 */
  isCapabilityMutationTool(toolName: string): boolean
  /**
   * 这次调用是不是「其实什么都没改」：结果里 `skipped` 为真或 `changed` 为假。
   *
   * 命中时跟踪器整条跳过——既不算新编辑，也不算检查或验证，避免空转把待验证状态重置掉。
   */
  isSkippedOrUnchangedResult(result: unknown): boolean
  /**
   * 这次变更是否只动了「不值得跑验证」的东西（文档、配置之类的非代码产物）。
   *
   * 两条判据：工具名本身就在非代码变更清单里，或者它虽是编辑工具但改到的路径全都与验证无关。
   * 命中时不推进编辑版本，模型就不会被提醒去跑一遍构建/测试。
   */
  isNonCodeArtifactMutation(toolName: string, result: unknown): boolean
  /**
   * 从工具结果里把被改到的路径挖出来（去重）。
   *
   * 兼容几种历史形态：`changedFiles` 数组、顶层 `path`/`fromPath`/`toPath`、以及 `files[]` 里每项的同名字段。
   * 认不出来就返回空数组，调用方据此当作「没有路径信息」。
   */
  extractModifiedPaths(result: unknown): string[]
}

class CodingSessionEditResultHelper implements CodingSessionEditResultHelperApi {
  private readonly editTools: Set<string>
  private readonly nonCodeMutationTools: Set<string>

  constructor(options: {
    mutationToolNames: readonly string[]
    nonCodeMutationToolNames: readonly string[]
  }) {
    this.editTools = new Set(options.mutationToolNames)
    this.nonCodeMutationTools = new Set(options.nonCodeMutationToolNames)
  }

  public isCapabilityMutationTool(toolName: string): boolean {
    return this.editTools.has(toolName)
  }

  public isSkippedOrUnchangedResult(result: unknown): boolean {
    if (!result || !isObject(result)) return false

    const record = result as { skipped?: unknown; changed?: unknown }
    return isTrue(record.skipped) || isFalse(record.changed)
  }

  public isNonCodeArtifactMutation(toolName: string, result: unknown): boolean {
    if (this.nonCodeMutationTools.has(toolName)) return true

    if (!this.editTools.has(toolName)) return false

    const modifiedPaths = this.extractModifiedPaths(result)
    return !isEmpty(modifiedPaths) && !hasVerificationRelevantModifiedPaths(modifiedPaths)
  }

  public extractModifiedPaths(result: unknown): string[] {
    if (!result || !isPlainObject(result)) return []

    const paths: string[] = []
    const record = result

    // 能力变更可能返回已修改资源列表。
    const changedFiles = record.changedFiles
    if (isArray(changedFiles)) {
      changedFiles.forEach((p) => {
        if (isString(p) && p) paths.push(p)
      })
    }

    // 旧结果形态：单路径、来源路径、目标路径。
    for (const key of ['path', 'fromPath', 'toPath'] as const) {
      const value = record[key]
      if (isString(value) && value) {
        paths.push(value)
      }
    }

    const files = record.files
    if (isArray(files)) {
      files.forEach((file) => {
        if (!file || !isPlainObject(file)) return

        for (const key of ['path', 'fromPath', 'toPath'] as const) {
          const value = (file)[key]
          if (isString(value) && value) {
            paths.push(value)
          }
        }
      })
    }

    return [...new Set(paths)]
  }
}

export { CodingSessionEditResultHelper }
