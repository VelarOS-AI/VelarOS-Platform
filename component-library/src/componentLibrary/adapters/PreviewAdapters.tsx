import {
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  CodeIcon,
  FolderOpenIcon,
  GitBranchIcon,
  PlusIcon,
  SidebarSimpleIcon,
} from '@phosphor-icons/react'
import type { ReactElement, ReactNode } from 'react'

import { ChatInteractionNotice } from '@velaros-ai/ui'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Badge } from '@velaros-ai/ui/primitives/display/Badge'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@velaros-ai/ui/primitives/layout/Tabs'

import './previewAdapters.css'

export interface DisclosureItem {
  id: string
  timestamp: number
  tone: 'success' | 'running' | 'warning' | 'error' | 'neutral'
  title: ReactNode
  description?: ReactNode
  content?: ReactNode
}

export function WorkspaceSessionControlPreview(): ReactElement {
  return (
    <Inline gap="xs" align="center" wrap="wrap">
      <Button size="sm" variant="outline">
        <FolderOpenIcon size={15} />
        VelarOS-UI
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="添加工作区">
        <PlusIcon size={15} />
      </Button>
    </Inline>
  )
}

export function WorkspaceGitCommitControlPreview({
  additions = 24,
  branch = 'main',
  changedFiles = 2,
  deletions = 8,
}: {
  additions?: number
  branch?: string
  changedFiles?: number
  deletions?: number
}): ReactElement {
  return (
    <Button size="sm" variant="outline">
      <GitBranchIcon size={15} />
      <span>{branch}</span>
      <Badge variant="secondary">{changedFiles}</Badge>
      <span className="catalog-preview-additions">+{additions}</span>
      <span className="catalog-preview-deletions">−{deletions}</span>
    </Button>
  )
}

export function WorkspaceAutoApprovalNoticeCard({
  onDismiss,
}: {
  onDismiss?: () => void
}): ReactElement {
  return (
    <ChatInteractionNotice
      tone="warning"
      title="工作区自动批准已启用"
      description="当前会话可在已授权工作区内直接执行低风险文件操作。"
      actions={
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          知道了
        </Button>
      }
    />
  )
}

export function SidebarPreview(): ReactElement {
  return (
    <div className="catalog-sidebar-preview">
      <header>
        <span className="catalog-sidebar-preview-mark">
          <SidebarSimpleIcon size={15} weight="fill" />
        </span>
        <strong>VelarOS</strong>
      </header>
      <nav aria-label="侧栏示例">
        <button type="button" data-active="true">
          <span>今天</span>
          <small>3</small>
        </button>
        <button type="button">
          <span>组件库收尾</span>
          <small className="catalog-sidebar-preview-status" aria-label="运行中" />
        </button>
        <button type="button">
          <span>发布检查</span>
          <CheckCircleIcon size={13} />
        </button>
      </nav>
      <footer>
        <FolderOpenIcon size={14} />
        <span>VelarOS-UI</span>
      </footer>
    </div>
  )
}

export function BrowserLinkedChatPane({
  chatPane,
  isVisible,
  onOpenPopout,
}: {
  chatPane: ReactNode
  isVisible: boolean
  onOpenPopout: () => void
}): ReactElement | null {
  if (!isVisible) return null

  return (
    <section className="catalog-browser-chat-pane">
      <header>
        <div>
          <span className="catalog-browser-chat-dot" />
          <strong>浏览器会话</strong>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="在独立窗口打开" onClick={onOpenPopout}>
          <CodeIcon size={14} />
        </Button>
      </header>
      {chatPane}
    </section>
  )
}

export function ChatDebugTimeline({ items }: { items: DisclosureItem[] }): ReactElement {
  return (
    <Stack gap="xs" className="catalog-debug-timeline">
      {items.map((item) => (
        <article key={item.id} data-tone={item.tone}>
          <span className="catalog-debug-timeline-rail">
            {item.tone === 'running' ? <ClockIcon size={13} /> : <CheckIcon size={13} />}
          </span>
          <div>
            <header>
              <strong>{item.title}</strong>
              <time>
                {new Intl.DateTimeFormat('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                }).format(item.timestamp)}
              </time>
            </header>
            {!!item.description && <Text tone="secondary">{item.description}</Text>}
            {!!item.content && <div className="catalog-debug-timeline-content">{item.content}</div>}
          </div>
        </article>
      ))}
    </Stack>
  )
}

export interface SettingsTabItem {
  value: string
  label: string
}

export function SettingsTabsFrame({
  children,
  onValueChange,
  tabs,
  title,
  value,
}: {
  children: ReactNode
  onValueChange: (value: string) => void
  tabs: SettingsTabItem[]
  title: ReactNode
  value: string
}): ReactElement {
  return (
    <ScrollArea className="catalog-settings-tabs-frame">
      <Tabs value={value} onValueChange={onValueChange}>
        <header>
          <h3>{title}</h3>
          <TabsList>
            {tabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </header>
        {children}
      </Tabs>
    </ScrollArea>
  )
}
