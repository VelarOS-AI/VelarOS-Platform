export type VelarosCliStatus = 'ok' | 'error'

export const VelarosCliSchemaVersion = 1

export interface VelarosCliRunOptions {
  cwd?: string
  /** Optional foreground event sink used by long-running namespaces. */
  write?: (text: string) => void
}

export interface VelarosCliSuccessEnvelope {
  schemaVersion: 1
  kind: string
  status: Extract<VelarosCliStatus, 'ok'>
  namespace: string
  command: string
  cwd: string
  durationMs: number
  result: unknown
}

export interface VelarosCliErrorEnvelope {
  schemaVersion: 1
  kind: 'velaros.cli.error'
  status: Extract<VelarosCliStatus, 'error'>
  error: {
    code: string
    message: string
    details: Record<string, unknown>
  }
}

export interface VelarosCliNamespaceRunResult {
  text: string
  exitCode: number
  envelope?: unknown
}

export interface VelarosCliRunResult extends VelarosCliNamespaceRunResult {
  envelope: VelarosCliSuccessEnvelope | VelarosCliErrorEnvelope
}

/** 表示 VelarOS 命令行解析或执行阶段产生的稳定错误。 */
export class VelarosCliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 1,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'VelarosCliError'
  }
}
