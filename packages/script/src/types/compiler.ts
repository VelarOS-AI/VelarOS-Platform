import type { OperationSurface } from '@velaros-ai/kernel'

/** 自包含的 Skill 合同；省略输入在 JSON 边界用 null 表示，在 Node 调用时还原为 undefined。 */
export interface ScriptCompiledContract extends OperationSurface {
  /** 声明接受省略参数的操作名。 */
  readonly optionalInputs: readonly string[]
}
