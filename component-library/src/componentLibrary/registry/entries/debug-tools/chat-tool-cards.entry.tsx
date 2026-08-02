import {
  CommandToolCardExample,
  DefaultToolCardExample,
  FileChangeToolCardExample,
  GoalToolCardExample,
  PlanToolCardExample,
  ToolCardDensityExample,
} from '@catalog/examples/ChatToolCardExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.debugTools,
  entryOrder: 20,
  entry: {
    id: 'chat-tool-cards',
    name: 'Tool Cards — Dispatch Families',
    layer: 'Feature',
    status: 'ready',
    domain: 'Tool result',
    source: '@velaros-ai/ui/conversation',
    origin: 'packages/ui/src/conversation/tool-render',
    exampleMode: 'fixture',
    usage:
      'ToolCallBlock 按 block.toolName 路由到各 renderer(command / default / plan / goal / file-change 等)。这里平铺每族的 running / success / error 等状态形态与 compact / full 密度。',
    avoid: '不要再为单个工具手搓一次性结果卡;新工具优先落进现有 renderer 族或 DefaultToolRender。',
    examples: [
      { id: 'tool-card-command', label: 'Command(bash)· running/success/error/timedOut · 手编 fixture', node: <CommandToolCardExample /> },
      { id: 'tool-card-default', label: 'Default(project:read)· running/success/error · 手编 fixture', node: <DefaultToolCardExample /> },
      { id: 'tool-card-plan', label: 'Plan(plan:update)· in-progress/completed/failed · 手编 fixture', node: <PlanToolCardExample /> },
      { id: 'tool-card-goal', label: 'Goal(goal:create)· active/complete/blocked · 手编 fixture', node: <GoalToolCardExample /> },
      { id: 'tool-card-file-change', label: 'FileChange(project:edit)· success/running/rejected/no-change · 手编 fixture', node: <FileChangeToolCardExample /> },
      { id: 'tool-card-density', label: 'compact / full 密度两态 · 手编 fixture', node: <ToolCardDensityExample /> },
    ],
    api: [
      {
        name: 'ToolCallBlock.block.toolName',
        description: '唯一路由键(精确字符串,不做归一化);未注册工具名回落 DefaultToolRender。',
        type: 'string',
      },
      {
        name: 'ToolCallBlock.compact',
        description: 'compact=合并行(CompactToolRow);full=可展开的 ToolDisclosureCard。',
        type: 'boolean',
        defaultValue: 'false',
      },
    ],
  },
})
