import { isArray, isEmpty, isFalse, isObject, isPlainObject,isString,isTrue } from '@velaros-ai/core'

import { hasVerificationRelevantModifiedPaths } from './paths'

class CodingSessionEditResultHelper {
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
