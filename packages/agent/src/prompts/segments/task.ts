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
      stability: 'dynamic',
      source: 'runtime',
      priority: PromptSegmentPriority.runtimeAdvice,
      when: () => !!snapshot.executionPlanPreview,
      text: snapshot.executionPlanPreview,
    }),
    createTextPromptSegment({
      id: 'runtime.proposal-mode',
      label: 'Proposal Mode',
      stability: 'dynamic',
      source: 'runtime',
      priority: PromptSegmentPriority.guardrail,
      when: () => snapshot.proposalMode,
      text: '当前为方案模式：调查和分析后形成可审阅方案；本轮保持只读，领域边界以已注入能力为准。',
    }),
    createTextPromptSegment({
      id: 'runtime.goal-mode',
      label: 'Goal Mode',
      stability: 'dynamic',
      source: 'runtime',
      priority: PromptSegmentPriority.runtimeAdvice + 1,
      when: () => snapshot.goalMode,
      text: '当前执行绑定到持久目标：持续推进并维护任务账本；仅在真正达成或无法继续时按 goal 工具契约更新状态。',
    }),
  ]
}
