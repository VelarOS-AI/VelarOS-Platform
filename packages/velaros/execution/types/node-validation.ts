/** 宿主从已授权快照读取的完整文本；path 仅为副本中的相对文件名。 */
export interface NodeValidationFile {
  readonly identity: string
  readonly path: string
  readonly sha256: string
  readonly text: string
}

/** 宿主固定的独立验证输入；模型不控制运行时、环境或可读宿主根。 */
export interface NodeValidationRequest {
  readonly files: readonly NodeValidationFile[]
  readonly code: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

/** 实际受监督进程与临时资源的收尾事实，不能解释为完整需求通过。 */
export interface NodeValidationResult {
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
