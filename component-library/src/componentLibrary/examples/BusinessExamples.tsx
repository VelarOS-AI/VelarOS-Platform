import {
  WorkspaceAutoApprovalNoticeCard,
  WorkspaceGitCommitControlPreview,
  WorkspaceSessionControlPreview,
} from '@catalog/adapters/PreviewAdapters'
import { useI18n } from '@catalog/i18n'
import type { ComponentLibraryExample } from '@catalog/models/componentLibraryTypes'
import { CheckIcon, GearIcon, WrenchIcon, XCircleIcon } from '@phosphor-icons/react'
import type { ComponentProps } from 'react'

import {
  ChatInteractionNotice,
  InteractionSuggestionCard,
  SessionStickyDock,
  type SessionStickyDockItem,
} from '@velaros-ai/ui'
import {
  type ToolResultSummaryItem,
  ToolResultSummaryList,
} from '@velaros-ai/ui/conversation'
import { ToolCallBlock } from '@velaros-ai/ui/conversation/tool-render/ToolCallBlock'
import { Badge } from '@velaros-ai/ui/primitives/display/Badge'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'
import { Panel } from '@velaros-ai/ui/primitives/layout/Panel'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { ActionCardIconButton } from '@velaros-ai/ui/product/layout/ActionCard'

type ToolCallBlockType = ComponentProps<typeof ToolCallBlock>['block']

function WorkspaceSessionControlExample() {
  return (
    <div data-library-business-control-sample>
      <WorkspaceSessionControlPreview />
    </div>
  )
}

const workspaceSessionControlExampleCode = `
import { WorkspaceSessionControlPreview } from '@catalog/adapters/PreviewAdapters'

export function WorkspaceSessionControlExample() {
  return <WorkspaceSessionControlPreview />
}
`

const workspaceGitCommitControlExampleCode = `
import { WorkspaceGitCommitControlPreview } from '@catalog/adapters/PreviewAdapters'

export function WorkspaceGitCommitControlExample() {
  return <WorkspaceGitCommitControlPreview />
}
`

function WorkspaceGitCommitControlExample() {
  return (
    <div data-library-git-control-sample>
      <WorkspaceGitCommitControlPreview />
    </div>
  )
}

function ToolResultSummaryListExample() {
  const { t } = useI18n()
  const toolResultSummaryItems: ToolResultSummaryItem[] = [
    {
      id: 'command-typecheck',
      kind: 'command',
      tone: 'success',
      label: t('componentLibrary.exampleBusinessCommandLabel'),
      detail: 'bun run scripts:run typecheck:web',
      detailTitle: 'bun run scripts:run typecheck:web',
      statusLabel: t('componentLibrary.exampleBusinessCommandPassed'),
    },
    {
      id: 'file-change-component-library',
      kind: 'file-change',
      tone: 'success',
      label: t('componentLibrary.exampleBusinessFileChange'),
      detail: 'ComponentLibraryPage.tsx',
      detailTitle: 'ComponentLibraryPage.tsx',
      statusLabel: '+42 -8',
    },
    {
      id: 'plan-update',
      kind: 'plan',
      tone: 'running',
      label: t('componentLibrary.exampleBusinessPlanUpdate'),
      detail: t('componentLibrary.exampleBusinessPlanProgress'),
      detailTitle: t('componentLibrary.exampleBusinessPlanProgress'),
      statusLabel: t('componentLibrary.exampleBusinessRunning'),
    },
  ]

  return (
    <div data-library-business-sample="tool-result">
      <ToolResultSummaryList items={toolResultSummaryItems} />
    </div>
  )
}

function ToolResultRendererStatesExample() {
  const { t } = useI18n()

  return (
    <Panel variant="inset">
      <Inline gap="sm" wrap="wrap">
        <Badge variant="secondary">{t('componentLibrary.exampleBusinessPresentationBadge')}</Badge>
        <span>{t('componentLibrary.exampleBusinessPresentationDescription')}</span>
      </Inline>
    </Panel>
  )
}

function SessionStickyDockExample() {
  const planToolBlock: ToolCallBlockType = {
    type: 'tool-call',
    toolCallId: 'library-plan-update',
    toolName: 'plan:update',
    args: {
      explanation: '把会话级提醒固定在对话顶部，展开时不遮挡卡片操作。',
      plan: [
        {
          step: '完成业务组件拆分',
          status: 'completed',
        },
        {
          step: '补组件库 fixture',
          status: 'in_progress',
        },
        {
          step: '跑类型和组件库校验',
          status: 'pending',
        },
      ],
    },
    result: {
      explanation: '计划卡片复用原 plan:update 渲染器。',
      plan: [
        {
          step: '完成业务组件拆分',
          status: 'completed',
        },
        {
          step: '补组件库 fixture',
          status: 'in_progress',
        },
        {
          step: '跑类型和组件库校验',
          status: 'pending',
        },
      ],
    },
  }
  const stickyDockItems: SessionStickyDockItem[] = [
    {
      id: 'library-workspace-auto-approval',
      createdAt: Date.now() - 120_000,
      content: <WorkspaceAutoApprovalNoticeCard onDismiss={() => undefined} />,
    },
    {
      id: 'library-plan-update',
      createdAt: Date.now() - 60_000,
      content: <ToolCallBlock block={planToolBlock} compact />,
    },
  ]

  return (
    <div data-library-session-sticky-dock>
      <SessionStickyDock
        initialCollapsed={false}
        items={stickyDockItems}
        barLabel="会话固定坞"
      />
    </div>
  )
}

function ChatInteractionNoticeExample() {
  return (
    <Stack gap="md" className="w-full max-w-xl">
      <ChatInteractionNotice
        tone="running"
        title="执行中"
        description="Agent 正在处理当前任务，完成后会继续输出。"
      />
      <ChatInteractionNotice
        tone="warning"
        title="需要确认"
        description="当前操作可能影响工作区文件，请确认是否继续。"
      />
      <ChatInteractionNotice
        tone="error"
        title="执行失败"
        description="工具调用返回错误，请查看详情后重试或调整指令。"
        icon={<XCircleIcon size={16} weight="fill" />}
      />
    </Stack>
  )
}

const chatInteractionNoticeExampleCode = `
import { ChatInteractionNotice } from '@velaros-ai/ui'

export function ChatInteractionNoticeExample() {
  return (
    <ChatInteractionNotice
      tone="warning"
      title="需要确认"
      description="当前会话等待用户确认后继续执行。"
    />
  )
}
`

function InteractionSuggestionCardExample() {
  return (
    <InteractionSuggestionCard
      tone="info"
      icon={<WrenchIcon size={17} weight="duotone" />}
      title="建议安装系统工具"
      description="安装后可在当前会话中直接调用该工具。"
      actions={
        <>
          <ActionCardIconButton label="批准">
            <CheckIcon size={15} weight="bold" />
          </ActionCardIconButton>
          <ActionCardIconButton label="设置">
            <GearIcon size={15} weight="bold" />
          </ActionCardIconButton>
        </>
      }
    />
  )
}

const interactionSuggestionCardExampleCode = `
import { CheckIcon } from '@phosphor-icons/react'

import { InteractionSuggestionCard } from '@velaros-ai/ui'

export function InteractionSuggestionCardExample() {
  return (
    <InteractionSuggestionCard
      tone="info"
      icon={<CheckIcon size={17} weight="bold" />}
      title="建议安装系统工具"
      description="安装后可在此会话中直接调用该工具。"
      actions={
        <ActionCardIconButton label="批准">
          <CheckIcon size={15} weight="bold" />
        </ActionCardIconButton>
      }
    />
  )
}
`

const sessionStickyDockExampleCode = `
import { SessionStickyDock, type SessionStickyDockItem } from '@velaros-ai/ui'
import { ToolCallBlock } from '@velaros-ai/ui/conversation/tool-render/ToolCallBlock'
import type { ComponentProps } from 'react'

const planToolBlock: ComponentProps<typeof ToolCallBlock>['block'] = {
  type: 'tool-call',
  toolCallId: 'plan-update',
  toolName: 'plan:update',
  args: {
    explanation: '计划卡片复用原 plan:update 渲染器。',
    plan: [
      { step: '完成业务组件拆分', status: 'completed' },
      { step: '补组件库 fixture', status: 'in_progress' },
    ],
  },
  result: {
    explanation: '计划卡片复用原 plan:update 渲染器。',
    plan: [
      { step: '完成业务组件拆分', status: 'completed' },
      { step: '补组件库 fixture', status: 'in_progress' },
    ],
  },
}

const items: SessionStickyDockItem[] = [
  {
    id: 'plan-update',
    createdAt: Date.now(),
    content: <ToolCallBlock block={planToolBlock} compact />,
  },
]

export function SessionStickyDockExample() {
  return <SessionStickyDock items={items} barLabel="会话固定坞" />
}
`

export const businessComponentExamples: Record<string, ComponentLibraryExample[]> = {
  'workspace-session-control': [
    {
      id: 'workspace-session-fixture',
      label: 'Fixture: workspace picker',
      node: <WorkspaceSessionControlExample />,
      code: workspaceSessionControlExampleCode,
    },
  ],
  'workspace-git-commit-control': [
    {
      id: 'workspace-git-fixture',
      label: 'Fixture: dirty branch',
      node: <WorkspaceGitCommitControlExample />,
      code: workspaceGitCommitControlExampleCode,
    },
  ],
  'tool-result-summary-list': [
    {
      id: 'tool-result-fixture',
      label: 'Fixture: grouped tool results',
      node: <ToolResultSummaryListExample />,
    },
  ],
  'tool-result-live-renderers': [
    {
      id: 'tool-result-states',
      label: 'Fixture: promotion states',
      node: <ToolResultRendererStatesExample />,
    },
  ],
  'session-sticky-dock': [
    {
      id: 'session-sticky-dock-fixture',
      label: 'Fixture: session notices dock',
      node: <SessionStickyDockExample />,
      code: sessionStickyDockExampleCode,
    },
  ],
  'chat-interaction-notice': [
    {
      id: 'chat-interaction-notice-fixture',
      label: 'Fixture: notice tones',
      node: <ChatInteractionNoticeExample />,
      code: chatInteractionNoticeExampleCode,
    },
  ],
  'interaction-suggestion-card': [
    {
      id: 'interaction-suggestion-card-fixture',
      label: 'Fixture: suggestion card',
      node: <InteractionSuggestionCardExample />,
      code: interactionSuggestionCardExampleCode,
    },
  ],
}
