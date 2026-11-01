/** 指令接收方与动态任务材料分离；此清单不授予能力。 */
export type InstructionAudience = 'main' | 'worker' | 'auxiliary'

/** 已装配块的来源及启用条件，正文只由所属生成器提供。 */
export interface RuntimeInstructionBlock {
  readonly id: string
  readonly owner: string
  readonly audience: InstructionAudience
  readonly source: string
  readonly revision: string
  readonly enabled: boolean
  readonly condition: string
  readonly text: string
}

/** 实际系统指令及其有序来源；动态帧材料不在此清单中。 */
export interface RuntimeInstructionManifest {
  readonly text: string
  readonly blocks: readonly RuntimeInstructionBlock[]
}
