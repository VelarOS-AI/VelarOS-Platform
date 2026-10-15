/** @AgentView 本次证据目录中的完整产物身份与字节哈希；不能通过这里扩展读取范围。 */
export interface CompletionValidationArtifact {
  readonly identity: string
  readonly sha256: string
}

/** @AgentView 为当前需求编写一个有界 Node.js ESM 反例。只接受目录中已有的文件身份及完整哈希。 */
export interface CompletionValidationInput {
  readonly requirementIds: readonly string[]
  readonly artifacts: readonly CompletionValidationArtifact[]
  readonly code: string
}

/** @AgentView 实际独立进程的结果；passed 仅说明本次代码退出成功，不能代替全部需求验收。 */
export interface CompletionValidationOutcome {
  readonly status: 'passed' | 'failed' | 'unavailable'
  readonly exitCode?: number
  readonly signal?: string
  readonly timedOut: boolean
  readonly cancelled: boolean
  readonly stdout: string
  readonly stderr: string
  readonly outputTruncated: boolean
  readonly cleanupComplete: boolean
  readonly durationMs: number
  readonly issue?: string
  readonly environmentSha256?: string
}

/** @AgentView 回执绑定完整需求、产物清单和验证源码。超时、取消、截断或清理缺口均不构成通过。 */
export interface CompletionValidationReceipt extends CompletionValidationOutcome {
  readonly identity: string
  readonly requirementIds: readonly string[]
  readonly requirementsSha256: string
  readonly artifacts: readonly CompletionValidationArtifact[]
  readonly codeSha256: string
  readonly versionCurrent: boolean
}
