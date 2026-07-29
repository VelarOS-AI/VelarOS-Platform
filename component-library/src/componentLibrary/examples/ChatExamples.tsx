import { type ComponentProps, type ReactElement, useState } from 'react'
import { BrowserLinkedChatPane } from '@catalog/adapters/PreviewAdapters'
import type { I18nContextValue } from '@catalog/i18n'
import { useI18n } from '@catalog/i18n'

import {
  ChatAwaitingInputCard,
  ChatConfirmationCard,
  ChatConversationSkeleton,
  ChatNoticeCard,
  type ChatStatusRuntime,
  type ConversationMessageRunMarker,
  MessageBubble,
} from '@velaros-ai/ui/conversation'
import {
  ChatInput,
  type ChatInputQueuedDraft,
} from '@velaros-ai/ui/conversation/composer'
import { Badge } from '@velaros-ai/ui/primitives/display/Badge'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'

type Translate = I18nContextValue['t']
type ChatMessage = ComponentProps<typeof MessageBubble>['message']

const FixtureTimestamp = new Date('2026-05-07T10:30:00+08:00').getTime()

const emptyRuntime: ChatStatusRuntime = {
  status: 'idle',
  teamPhase: null,
  activeTurn: null,
  completedTurns: 0,
  isContextCompacting: false,
  lastContextCompactionAt: null,
  lastError: null,
  connectionRetryAttempt: null,
  connectionRetryMaxAttempts: null,
  lastRunStartedAt: null,
  awaitingConfirmationMessage: null,
  awaitingInputQuestion: null,
}

const completedMarker: ConversationMessageRunMarker = {
  messageId: 'library-assistant-completed',
  status: 'completed',
  detail: null,
  turnCount: 1,
  turnKind: 'turn',
  timestamp: FixtureTimestamp + 74_000,
}

function buildUserMessage(t: Translate): ChatMessage {
  return {
    id: 'library-user-refactor-request',
    role: 'user',
    timestamp: FixtureTimestamp,
    attachments: [
      {
        id: 'frontend-plan',
        kind: 'file',
        name: 'frontend-refactor-plan.md',
        mediaType: 'text/markdown',
        size: 18432,
      },
    ],
    blocks: [
      {
        type: 'text',
        text: t('componentLibrary.chatExample.userRefactorBody'),
      },
    ],
  }
}

function buildCompletedAssistantMessage(t: Translate): ChatMessage {
  return {
    id: 'library-assistant-completed',
    role: 'assistant',
    timestamp: FixtureTimestamp + 72_000,
    blocks: [
      {
        type: 'tool-call',
        toolCallId: 'tool-typecheck-web',
        toolName: 'bash',
        args: {
          command: 'bun run scripts:run typecheck:web',
        },
        result: {
          exitCode: 0,
          stdout: 'tsc --noEmit -p tsconfig.web.json --composite false',
        },
      },
      {
        type: 'text',
        text: t('componentLibrary.chatExample.assistantCompletedBody'),
      },
    ],
  }
}

function buildStreamingAssistantMessage(t: Translate): ChatMessage {
  return {
    id: 'library-assistant-streaming',
    role: 'assistant',
    timestamp: FixtureTimestamp + 98_000,
    blocks: [
      {
        type: 'thinking',
        text: t('componentLibrary.chatExample.thinkingGateBody'),
      },
      {
        type: 'tool-call',
        toolCallId: 'tool-architecture-running',
        toolName: 'bash',
        args: {
          command: 'bun run scripts:run check:architecture',
        },
        isRunning: true,
      },
      {
        type: 'text',
        text: t('componentLibrary.chatExample.assistantStreamBody'),
      },
    ],
  }
}

export function ChatConversationMessageStatesExample(): ReactElement {
  const { t } = useI18n()
  const userMessage = buildUserMessage(t)
  const completedAssistantMessage = buildCompletedAssistantMessage(t)
  const streamingAssistantMessage = buildStreamingAssistantMessage(t)

  return (
    <div data-library-chat-sample>
      <div data-library-chat-toolbar>
        <Inline gap="sm" wrap="wrap">
          <Badge variant="secondary">{t('componentLibrary.chatExample.badgeConversation')}</Badge>
          <Badge variant="outline">{t('componentLibrary.chatExample.badgeFixtureOnly')}</Badge>
        </Inline>
      </div>
      <div data-library-chat-frame>
        <MessageBubble message={userMessage} sessionId="component-library-session" />
        <MessageBubble
          message={completedAssistantMessage}
          sessionId="component-library-session"
          runMarker={completedMarker}
          billingModel={{
            provider: 'openai',
            model: 'gpt-5.4',
          }}
          runtimeCostContexts={[]}
        />
        <MessageBubble
          message={streamingAssistantMessage}
          sessionId="component-library-session"
          isStreaming
          inlineNotice={{
            tone: 'running',
            text: t('componentLibrary.chatExample.noticeRunningArch'),
          }}
        />
      </div>
    </div>
  )
}

export function ChatInputExample(): ReactElement {
  const [value, setValue] = useState('')
  const { t } = useI18n()

  return (
    <div data-library-chat-composer>
        <ChatInput
          control={{
            input: {
              value,
              placeholder: t('componentLibrary.chatExample.chatInputPlaceholder'),
              onValueChange: setValue,
              onSend: () => undefined,
            },
            attachments: {
              files: [],
              onFilesChange: () => undefined,
            },
            features: {
              promptFeatures: [],
              availableSkills: [
                {
                  id: 'browser',
                  label: t('componentLibrary.chatExample.skillBrowserLabel'),
                  description: t('componentLibrary.chatExample.skillBrowserDescription'),
                },
              ],
              manualTestPrompts: [
                {
                  id: 'workspace-list',
                  title: t('componentLibrary.chatExample.manualWorkspaceListTitle'),
                  description: t('componentLibrary.chatExample.manualWorkspaceListDescription'),
                  prompt: t('componentLibrary.chatExample.manualWorkspaceListPrompt'),
                },
              ],
              onPromptFeaturesChange: () => undefined,
              onSelectedSkillIdsChange: () => undefined,
            },
            streaming: {
              onStop: () => undefined,
            },
          }}
        />
      </div>
  )
}

export function ChatGuidanceQueueExample(): ReactElement {
  const [value, setValue] = useState('')
  const [queuedDrafts, setQueuedDrafts] = useState<ChatInputQueuedDraft[]>([
    {
      id: 'guidance-queue-1',
      value:
        '把引导列表改成单行展示，过长内容在末尾省略，不要撑高队列项目，也不要挤压右侧的引导、编辑和删除图标按钮',
      files: [],
    },
    {
      id: 'guidance-queue-2',
      value: '编辑时退回聊天框，修改后重新排队',
      files: [],
    },
  ])
  const { t } = useI18n()

  function removeQueuedDraft(id: string): void {
    setQueuedDrafts((current) => current.filter((item) => item.id !== id))
  }

  function returnQueuedDraftToInput(id: string): void {
    const item = queuedDrafts.find((queuedDraft) => queuedDraft.id === id)
    if (!item) return

    setValue(item.value)
    removeQueuedDraft(id)
  }

  function moveQueuedDraft(id: string, direction: 'up' | 'down'): void {
    setQueuedDrafts((current) => {
      const currentIndex = current.findIndex((item) => item.id === id)
      const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
      if (currentIndex < 0 || targetIndex < 0 || targetIndex >= current.length) return current

      const next = [...current]
      ;[next[currentIndex], next[targetIndex]] = [next[targetIndex], next[currentIndex]]
      return next
    })
  }

  function queueInputDraft(): void {
    const nextValue = value.trim()
    if (!nextValue) return

    setQueuedDrafts((current) => [
      ...current,
      {
        id: `guidance-queue-${Date.now()}`,
        value: nextValue,
        files: [],
      },
    ])
    setValue('')
  }

  return (
    <div data-library-chat-composer>
        <ChatInput
          control={{
            input: {
              value,
              placeholder: t('componentLibrary.chatExample.chatInputPlaceholder'),
              onValueChange: setValue,
              onSend: queueInputDraft,
            },
            attachments: {
              files: [],
              onFilesChange: () => undefined,
            },
            queue: {
              queuedDrafts,
              onQueuedDraftMove: moveQueuedDraft,
              onQueuedDraftRemove: removeQueuedDraft,
              onQueuedDraftGuide: removeQueuedDraft,
              onQueuedDraftReturnToInput: returnQueuedDraftToInput,
            },
            streaming: {
              isStreaming: true,
              onStop: () => undefined,
            },
          }}
        />
      </div>
  )
}

export function ChatConversationRuntimeStatesExample(): ReactElement {
  const { t } = useI18n()

  return (
    <Stack gap="sm">
      <div data-library-chat-notice>
        <ChatNoticeCard
          runtime={{
            ...emptyRuntime,
            status: 'awaiting-input',
            awaitingInputQuestion: t('componentLibrary.chatExample.awaitingInputQuestion'),
          }}
        />
      </div>
      <div data-library-chat-notice>
        <ChatNoticeCard
          runtime={{
            ...emptyRuntime,
            status: 'failed',
            lastError: t('componentLibrary.chatExample.lastErrorValidation'),
          }}
        />
      </div>
    </Stack>
  )
}

export function ChatInteractionCardsExample(): ReactElement {
  const { t } = useI18n()

  return (
    <Stack gap="sm">
      <ChatAwaitingInputCard
        question={t('componentLibrary.chatExample.awaitingGenEntriesQuestion')}
        onSubmit={() => undefined}
      />
      <ChatConfirmationCard
        message={t('componentLibrary.chatExample.confirmationCardMessage')}
        onApprove={() => undefined}
        onReject={() => undefined}
      />
    </Stack>
  )
}

export function ChatConversationSkeletonExample(): ReactElement {
  return (
    <div data-library-chat-skeleton>
      <ChatConversationSkeleton variant="side" />
    </div>
  )
}

export function BrowserLinkedChatPaneExample(): ReactElement {
  return (
    <div data-library-browser-chat-sample>
      <BrowserLinkedChatPane
        isVisible
        onOpenPopout={() => undefined}
        chatPane={
          <div data-library-browser-chat-body>
            <ChatConversationSkeleton variant="side" />
          </div>
        }
      />
    </div>
  )
}
