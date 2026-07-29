export type VelarosCliStatus = 'ok' | 'error'

export const VelarosCliSchemaVersion = 1

export interface VelarosCliRunOptions {
  cwd?: string
}

export type VelarosCliToolAvailabilityReason =
  | 'available'
  | 'host-runtime-required'
  | 'tool-state-unavailable'

export interface VelarosCliToolAvailability {
  available: boolean
  reason: VelarosCliToolAvailabilityReason
  message?: string
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

export interface VelarosCliRunResult {
  envelope: VelarosCliSuccessEnvelope | VelarosCliErrorEnvelope
  text: string
  exitCode: number
}

/** 表示 VelarOS 通用命令行解析或执行阶段产生的稳定错误。 */
export class VelarosCliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 1,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'VelarosCliError'
  }
}

export interface VelarosCliToolLike<TContext = unknown> {
  description: string
  schema: {
    safeParse(input: unknown):
      | { success: true; data: Record<string, unknown> }
      | { success: false; error: unknown }
  }
  permissions?: readonly string[]
  capabilities?: unknown
  exposure?: unknown
  isAvailable?: (ctx: TContext) => boolean
  isConcurrencySafe?: (input: Record<string, unknown>) => boolean
  execute(input: Record<string, unknown>, ctx: TContext): Promise<unknown>
}

export type VelarosCliToolMap<TContext = unknown> = Record<string, VelarosCliToolLike<TContext>>

export type VelarosCliToolAvailabilityResolver<TContext = unknown> = (input: {
  name: string
  tool: VelarosCliToolLike<TContext>
  context: TContext
}) => VelarosCliToolAvailability | undefined

export interface VelarosCliWorkflowStep {
  id?: string
  tool: string
  args?: Record<string, unknown>
}
