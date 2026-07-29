import type { AgentEvent, StreamToolResultEffects } from '@velaros-ai/core/types'

import type { KernelStoredToolOutput, KernelToolOutputStore } from './tool-output-store'

export interface KernelToolResultMaterializerOptions {
  outputStore?: LooseOptional<KernelToolOutputStore>
}

export interface MaterializeKernelToolResultInput {
  sessionId?: LooseOptional<string>
  localInstructionClaimScope?: LooseOptional<string>
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  result: unknown
  error?: LooseOptional<string>
  effects?: StreamToolResultEffects
  notices?: Array<Extract<AgentEvent, { type: 'notice' }>>
  /** 工具声明 outputInline：跳过 page-out，输出始终内联（不卸载为 payload 引用）。 */
  keepOutputInline?: boolean
}

export interface MaterializedKernelToolResult {
  displayResult: unknown
  modelResult: unknown
  effects: StreamToolResultEffects
  notices: Array<Extract<AgentEvent, { type: 'notice' }>>
  storedOutput: Nullable<KernelStoredToolOutput>
}

export class KernelToolResultMaterializer {
  public constructor(private readonly options: KernelToolResultMaterializerOptions = {}) {}

  public async materialize(
    input: MaterializeKernelToolResultInput
  ): Promise<MaterializedKernelToolResult> {
    // outputInline 工具：跳过整个 page-out 存储，输出原样内联给模型。
    if (!this.options.outputStore || input.keepOutputInline)
      return {
        displayResult: input.result,
        modelResult: input.result,
        effects: input.effects ?? {},
        notices: input.notices ?? [],
        storedOutput: null,
      }

    const projected = await this.options.outputStore.project({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      output: input.result,
    })

    return {
      displayResult: input.result,
      modelResult: projected.output,
      effects: input.effects ?? {},
      notices: input.notices ?? [],
      storedOutput: projected.stored,
    }
  }
}
