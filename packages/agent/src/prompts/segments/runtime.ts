import { isEmpty } from '@velaros-ai/core'

import type { PromptSegmentDefinition } from '../registry'

import {
  createSelectedSkillPromptSegment,
  createSkillPromptSegment,
  createTextPromptSegment,
  createThinkingDepthPromptSegment,
  formatLabelList,
  hasAnyRuntimeTool,
  hasAnyRuntimeToolAvailable,
  hasRuntimeTool,
  PromptSegmentPriority,
  type RuntimePromptSnapshot,
  type RuntimePromptToolCategorySummary,
} from './shared'
import { createTaskRuntimePromptSegments } from './task'

const MaxCustomSubAgentPromptEntries = 12

function renderCustomSubAgentLines(snapshot: RuntimePromptSnapshot): string[] {
  const agents = snapshot.customSubAgents.slice(0, MaxCustomSubAgentPromptEntries)
  if (isEmpty(agents)) return []
  const omitted = snapshot.customSubAgents.length - agents.length
  return [
    `- 自定义子 Agent：${agents
      .map((agent) => `${agent.id}（base: ${agent.base}）：${agent.description}`)
      .join('；')}${omitted > 0 ? `；另有 ${omitted} 个未列出` : ''}。`,
  ]
}

function buildRuntimeToolCapabilityMap(snapshot: RuntimePromptSnapshot): string {
  const lines = [
    '工具字段、枚举、前置条件和返回含义以本轮真实 schema/description 为准，不要猜工具名。',
    '复杂能力先 discover/search/list，再 bounded inspect/read，最后 execute/verify；简单无状态工具可直接调用。',
    '返回 truncated、has_more、next_cursor 或低置信时继续补查，并保留可追溯证据。',
  ]
  if (hasRuntimeTool(snapshot, 'tooling:map')) {
    lines.push('缺少能力时先用 tooling:map 查看可装载能力，再按返回的 activation 信息处理。')
  }
  if (hasAnyRuntimeTool(snapshot, ['context:recall'])) {
    lines.push('需要恢复已裁剪证据时调用 context:recall。')
  }
  if (hasAnyRuntimeTool(snapshot, ['context:distill'])) {
    lines.push('长任务阶段转折点可调用 context:distill 保存关键事实和进度。')
  }
  return lines.join('\n')
}

function createRuntimePromptSegments(
  snapshot: RuntimePromptSnapshot,
  capabilitySegments: readonly PromptSegmentDefinition[] = []
): PromptSegmentDefinition[] {
  const responseLanguage = snapshot.locale === 'zh-CN' ? '简体中文' : 'English'
  const segments: PromptSegmentDefinition[] = [
    createTextPromptSegment({
      id: 'runtime.session',
      label: 'Session Runtime',
      stability: 'dynamic',
      source: 'runtime',
      priority: PromptSegmentPriority.runtime,
      text: `当前界面语言：${responseLanguage}。回复和可见状态默认使用${responseLanguage}；代码、命令、路径和专有名词可保留原文。`,
    }),
    ...createTaskRuntimePromptSegments(snapshot),
    ...capabilitySegments,
  ]

  if (snapshot.contextPhase === 'bootstrap') {
    segments.push(
      createTextPromptSegment({
        id: 'runtime.bootstrap-context',
        label: 'Fast Start Context',
        stability: 'dynamic',
        source: 'runtime',
        priority: PromptSegmentPriority.runtimeAdvice - 30,
        text: [
          '当前是新任务快速启动阶段。',
          '简单问答直接回答；需要执行时先建立一个最小只读事实锚点或查询能力目录。',
        ].join('\n'),
      })
    )
    return segments
  }

  segments.push(
    createTextPromptSegment({
      id: 'runtime.tool-capability-map',
      label: 'Agent Tool Execution Chain',
      stability: 'dynamic',
      source: 'runtime',
      priority: PromptSegmentPriority.runtime + 31,
      when: () => hasAnyRuntimeToolAvailable(snapshot),
      text: buildRuntimeToolCapabilityMap(snapshot),
    }),
    createTextPromptSegment({
      id: 'runtime.sub-agent-dispatch',
      label: 'Sub-Agent Dispatch',
      stability: 'dynamic',
      source: 'runtime',
      priority: PromptSegmentPriority.runtime + 31.5,
      when: () => hasRuntimeTool(snapshot, 'agent:dispatch'),
      text: [
        '子 Agent 只用于可独立并行或本身需要多步的有界子任务；能直接完成的工作不要外派。',
        '主 Agent 负责综合、验证和收口。',
        ...renderCustomSubAgentLines(snapshot),
      ].join('\n'),
    }),
    createTextPromptSegment({
      id: 'runtime.run-profile',
      label: 'Run Profile',
      stability: 'dynamic',
      source: 'runtime',
      priority: PromptSegmentPriority.runtime + 32,
      text: `当前运行档位：${snapshot.runProfile}；工具参数档位：${snapshot.toolSurfaceProfile}。`,
    }),
    createTextPromptSegment({
      id: 'runtime.selected-capability-hints',
      label: 'Selected Capabilities',
      stability: 'dynamic',
      source: 'runtime',
      priority: PromptSegmentPriority.runtime + 33,
      when: () => !isEmpty(snapshot.selectedPromptFeatureLabels),
      text: `本轮已选能力：${formatLabelList(snapshot.selectedPromptFeatureLabels)}`,
    })
  )
  return segments
}

export {
  createRuntimePromptSegments,
  createSelectedSkillPromptSegment,
  createSkillPromptSegment,
  createTextPromptSegment,
  createThinkingDepthPromptSegment,
  PromptSegmentPriority,
}
export type { RuntimePromptSnapshot, RuntimePromptToolCategorySummary }
