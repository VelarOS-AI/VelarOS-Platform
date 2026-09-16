import type { KernelToolOutputStore } from '../../contract/requires.js'
import type {MaterializedKernelToolResult, MaterializeKernelToolResultInput } from '../../types/tools.js'

/** 构造参数：只有一项，决定超预算的工具输出往哪存。 */
export interface KernelToolResultMaterializerOptions {
  /**
   * 工具输出的落地店；缺省（不传或传 null）时整条 page-out 通道关闭，结果原样内联给模型。
   * 由 `ToolExecutor` 按会话装配：宿主给了 `contextPayloadStore` 就用 payload 店，否则用内存店。
   */
  outputStore?: LooseOptional<KernelToolOutputStore>
}

/**
 * 工具结果物化器：把一次执行的原始返回值分成「给界面看的」和「给模型看的」两份。
 *
 * 由 `ToolExecutor` 在构造时建一份长期持有。界面永远拿原文；模型那份在超预算时被换成
 * 「摘要 + 可召回句柄」，全文另存进 `outputStore` 并作为 `storedOutput` 一并返回，供后续 `context:recall`。
 */
export interface KernelToolResultMaterializerApi {
  /**
   * 物化一次工具结果：没有配 `outputStore`、或该工具声明了 `keepOutputInline` 时原样直出，
   * 否则交给 `outputStore.project` 决定内联还是句柄化。`effects` / `notices` 缺省补成空值，
   * 调用方拿到的形状恒定。store 抛错不在这里吞，向上冒泡由执行链按失败收敛。
   */
  materialize(input: MaterializeKernelToolResultInput): Promise<MaterializedKernelToolResult>
}

export class KernelToolResultMaterializer implements KernelToolResultMaterializerApi {
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
