import {
  ChatDebugTimeline,
  type DisclosureItem,
} from '@catalog/adapters/PreviewAdapters'
import { useI18n } from '@catalog/i18n'
import { CheckCircleIcon, ClockIcon } from '@phosphor-icons/react'
import type { ComponentProps, ReactElement } from 'react'

import { ToolCallBlock } from '@velaros-ai/ui/conversation/tool-render/ToolCallBlock'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { CompactToolRow } from '@velaros-ai/ui/product/layout/CompactToolRow'

const DebugTimestamp = new Date('2026-05-08T19:20:00+08:00').getTime()
type ToolCallBlockType = ComponentProps<typeof ToolCallBlock>['block']

const toolBlock: ToolCallBlockType = {
  type: 'tool-call',
  toolCallId: 'component-library-tool',
  toolName: 'bash',
  args: {
    command: 'bun run scripts:run typecheck:web',
  },
  result: {
    exitCode: 0,
    stdout: 'tsc --noEmit -p tsconfig.web.json --composite false',
  },
}

const planToolBlock: ToolCallBlockType = {
  type: 'tool-call',
  toolCallId: 'component-library-plan',
  toolName: 'update_plan',
  args: {
    explanation: '把计划工具输出收进组件库，后续对话栏直接复用原渲染器。',
    plan: [
      {
        step: '复用 PlanToolRender',
        status: 'completed',
      },
      {
        step: '补组件库条目',
        status: 'in_progress',
      },
      {
        step: '跑组件库校验',
        status: 'pending',
      },
    ],
  },
  result: {
    explanation: '计划卡片复用 update_plan 工具渲染器。',
    plan: [
      {
        step: '复用 PlanToolRender',
        status: 'completed',
      },
      {
        step: '补组件库条目',
        status: 'in_progress',
      },
      {
        step: '跑组件库校验',
        status: 'pending',
      },
    ],
  },
}

export function DebugTimelineExample(): ReactElement {
  const { t } = useI18n()
  const timelineItems: DisclosureItem[] = [
    {
      id: 'context-built',
      timestamp: DebugTimestamp,
      tone: 'success',
      title: t('componentLibrary.exampleDebugContextBuilt'),
      description: t('componentLibrary.exampleDebugContextDescription'),
      content: (
        <CompactToolRow
          icon={<CheckCircleIcon size={14} />}
          label={t('componentLibrary.exampleDebugSystemPrompt')}
          detail={t('componentLibrary.exampleDebugContextSize')}
        />
      ),
    },
    {
      id: 'tool-running',
      timestamp: DebugTimestamp + 18_000,
      tone: 'running',
      title: t('componentLibrary.exampleDebugToolRunning'),
      description: 'bash · bun run scripts:run typecheck:web',
      content: (
        <CompactToolRow
          icon={<ClockIcon size={14} />}
          label={t('componentLibrary.exampleDebugTypecheck')}
          detail={t('chat.workerThreadRunning')}
          tone="running"
        />
      ),
    },
  ]

  return (
    <Stack gap="sm">
      <ChatDebugTimeline items={timelineItems} />
    </Stack>
  )
}

export function ToolRendererExample(): ReactElement {
  return (
    <Stack gap="sm">
      <ToolCallBlock block={toolBlock} compact />
      <ToolCallBlock block={planToolBlock} compact />
    </Stack>
  )
}
