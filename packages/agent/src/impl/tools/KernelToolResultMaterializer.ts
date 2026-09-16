import type { KernelToolOutputStore } from '../../contract/requires.js'
import type {MaterializedKernelToolResult, MaterializeKernelToolResultInput } from '../../types/tools.js'

export interface KernelToolResultMaterializerOptions {
  outputStore?: LooseOptional<KernelToolOutputStore>
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
