import type { PromptSegmentDefinition } from '../registry'

import {
  createTextPromptSegment,
  PromptSegmentPriority,
  type RuntimePromptSnapshot,
} from './shared'

/**
 * Kernel owns only execution-mode guidance. Capability packages contribute
 * domain-specific task context through CapabilityPromptContributor.
 */
export function createTaskRuntimePromptSegments(
  snapshot: RuntimePromptSnapshot
): PromptSegmentDefinition[] {
  return [
    createTextPromptSegment({
      id: 'runtime.execution-plan',
      label: 'Execution Plan',
      source: 'runtime',
      priority: PromptSegmentPriority.runtimeAdvice,
      when: () => !!snapshot.executionPlanPreview,
      text: snapshot.executionPlanPreview,
    }),
    createTextPromptSegment({
      id: 'runtime.goal-mode',
      label: 'Goal Mode',
      source: 'runtime',
      priority: PromptSegmentPriority.runtimeAdvice + 1,
      when: () => snapshot.goalMode,
      text: '当前执行绑定到持久目标：持续推进并维护任务账本；真正达成或无法继续时按 goal 工具契约更新状态。',
    }),
  ]
}
