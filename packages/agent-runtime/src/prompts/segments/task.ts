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
      text: [
        '当前为方案模式：只调查、分析和形成可审阅方案。',
        '不要执行产生外部副作用的动作；领域约束以本轮 capability contributor 为准。',
      ].join('\n'),
    }),
    createTextPromptSegment({
      id: 'runtime.goal-mode',
      label: 'Goal Mode',
      stability: 'dynamic',
      source: 'runtime',
      priority: PromptSegmentPriority.runtimeAdvice + 1,
      when: () => snapshot.goalMode,
      text: '当前执行绑定到持久目标；按任务账本持续推进，并在真正达成或阻塞时更新目标状态。',
    }),
  ]
}
