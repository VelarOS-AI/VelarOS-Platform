import { isArray, isEmpty, isFalse, isObject, isString,isTrue } from '@velaros-ai/core'

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
    if (!result || !isObject(result)) return []

    const paths: string[] = []
    const record = result as Record<string, unknown>

    // Capability mutations may return a changed-resource list.
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
        if (!file || !isObject(file)) return

        for (const key of ['path', 'fromPath', 'toPath'] as const) {
          const value = (file as Record<string, unknown>)[key]
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
