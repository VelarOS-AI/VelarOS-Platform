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
      text: [
        '当前执行绑定到持久目标；按任务账本持续推进，并在真正达成或受阻时更新目标状态。',
        '模型确认存在缺少必要授权、用户输入或外部状态等真实阻碍，已经无法继续推进时，可以自行调用 update_goal({status:"blocked"})；不需要等待多轮审计。',
        '不要仅因为任务困难、耗时、结果不确定或希望获得澄清就标记受阻。',
      ].join('\n'),
    }),
  ]
}
