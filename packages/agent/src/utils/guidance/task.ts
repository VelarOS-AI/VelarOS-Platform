
import { PromptSegmentPriority } from '../../contract/constants.js'
import type { PromptSegmentDefinition, RuntimePromptSnapshot } from '../../types/guidance.js'

import { createTextPromptSegment } from './shared'

/**
 * 产出与**执行模式**相关的两段运行态提示词：计划预览（快照里有预览才渲染）与目标模式纪律（目标模式开启才渲染）。
 *
 * 内核只管执行模式这一类指导，**不认识任何领域任务语义**——各能力域自己的任务上下文走 `CapabilityPromptContributor` 贡献，
 * 不往这里加。两段都带 `when`：条件不满足时整段不渲染，而不是渲染一句空洞的占位。
 */
export function createTaskRuntimePromptSegments(
  snapshot: RuntimePromptSnapshot
): PromptSegmentDefinition[] {
  return [
    createTextPromptSegment({
      id: 'runtime.execution-plan',
      label: '执行计划',
      source: 'runtime',
      priority: PromptSegmentPriority.runtimeAdvice,
      when: () => !!snapshot.executionPlanPreview,
      text: snapshot.executionPlanPreview,
    }),
    createTextPromptSegment({
      id: 'runtime.goal-mode',
      label: '目标模式',
      source: 'runtime',
      priority: PromptSegmentPriority.runtimeAdvice + 1,
      when: () => snapshot.goalMode,
      text: '当前执行绑定到持久目标：持续推进并维护任务账本；真正达成或无法继续时按 goal 工具契约更新状态。',
    }),
  ]
}
