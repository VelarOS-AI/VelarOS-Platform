/** 完成复核的独立验证入口；只执行本次固定文件副本上的有界 Node.js ESM 代码。 */
declare module 'velaros:completion-validation' {
  /** 本次复核最多两次。通过 JSON.parse(process.env.VELAR_REVIEW_INPUTS) 取得所选身份对应的只读文件 URL，再 import 或读取。仅临时工作目录可写；网络、子进程和副本外文件不可用，依赖须在所选文件中。回执只证明本次断言；区分产品反例、断言错误和环境缺口。
   */
  export function execute(input: CompletionValidationInput): Promise<CompletionValidationReceipt>

  /** 为当前需求编写一个有界 Node.js ESM 反例。只接受目录中已有的文件身份及完整哈希。 */
  interface CompletionValidationInput {
    readonly requirementIds: readonly string[]
    readonly artifacts: readonly CompletionValidationArtifact[]
    readonly code: string
  }

  /** 回执绑定完整需求、产物清单和验证源码。超时、取消、截断或清理缺口均不构成通过。 */
  interface CompletionValidationReceipt extends CompletionValidationOutcome {
    readonly identity: string
    readonly requirementIds: readonly string[]
    readonly requirementsSha256: string
    readonly artifacts: readonly CompletionValidationArtifact[]
    readonly codeSha256: string
    readonly versionCurrent: boolean
  }

  /** 本次证据目录中的完整产物身份与字节哈希；不能通过这里扩展读取范围。 */
  interface CompletionValidationArtifact {
    readonly identity: string
    readonly sha256: string
  }

  /** 实际独立进程的结果；passed 仅说明本次代码退出成功，不能代替全部需求验收。 */
  interface CompletionValidationOutcome {
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
}
