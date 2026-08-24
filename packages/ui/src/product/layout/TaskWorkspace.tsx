/**
 * 任务管理页的通用工作区骨架：主列表、详情侧栏、执行回放侧栏与统一任务行。
 *
 * 只负责展示结构与交互状态，不持有任务契约、路由、IPC 或执行语义；具体产品把
 * 标题、状态、动作与正文作为 ReactNode 注入。
 */
import { memo, type ReactElement, type ReactNode } from 'react'

interface TaskContainerProps {
  children?: ReactNode
}

export interface TaskWorkspaceProps extends TaskContainerProps {
  detailOpen?: boolean
}

export const TaskWorkspace = memo(function TaskWorkspace({
  detailOpen = false,
  children,
}: TaskWorkspaceProps): ReactElement {
  return (
    <div className="velar-task-workspace" data-task-detail-open={detailOpen || undefined}>
      {children}
    </div>
  )
})

export const TaskWorkspaceRail = memo(function TaskWorkspaceRail({
  children,
}: TaskContainerProps): ReactElement {
  return <div className="velar-task-workspace-rail">{children}</div>
})

export interface TaskWorkspacePaneProps extends TaskContainerProps {
  ariaLabel: string
  size?: 'detail' | 'replay'
}

export const TaskWorkspacePane = memo(function TaskWorkspacePane({
  ariaLabel,
  size = 'detail',
  children,
}: TaskWorkspacePaneProps): ReactElement {
  return (
    <aside
      aria-label={ariaLabel}
      className={
        size === 'replay'
          ? 'velar-task-workspace-pane velar-task-workspace-pane-replay'
          : 'velar-task-workspace-pane velar-task-workspace-pane-detail'
      }
    >
      {children}
    </aside>
  )
})

export const TaskList = memo(function TaskList({ children }: TaskContainerProps): ReactElement {
  return (
    <div className="velar-task-list-scroll-area">
      <div className="velar-task-list">{children}</div>
    </div>
  )
})

export interface TaskListRowProps {
  leading: ReactNode
  title: ReactNode
  metadata?: ReactNode
  trailing?: ReactNode
  actions?: ReactNode
  selected?: boolean
  subdued?: boolean
  forceActionsVisible?: boolean
  onSelect: () => void
  selectLabel?: string
}

export const TaskListRow = memo(function TaskListRow({
  leading,
  title,
  metadata,
  trailing,
  actions,
  selected = false,
  subdued = false,
  forceActionsVisible = false,
  onSelect,
  selectLabel,
}: TaskListRowProps): ReactElement {
  const rowClassName = [
    'velar-task-list-row',
    selected ? 'velar-task-list-row-active' : null,
    subdued ? 'velar-task-list-row-subdued' : null,
  ]
    .filter(Boolean)
    .join(' ')
  const actionsClassName = forceActionsVisible
    ? 'velar-task-list-row-actions velar-task-list-row-actions-fixed'
    : 'velar-task-list-row-actions'

  return (
    <div className={rowClassName} aria-current={selected ? 'page' : undefined}>
      <button
        type="button"
        className="velar-task-list-row-select"
        onClick={onSelect}
        aria-label={selectLabel}
      >
        {leading}
        <span className="velar-task-list-row-main">
          <span className="velar-task-list-row-title">{title}</span>
          {!!metadata && <span className="velar-task-list-row-metadata">{metadata}</span>}
        </span>
        {!!trailing && <span className="velar-task-list-row-trailing">{trailing}</span>}
      </button>

      {!!actions && <div className={actionsClassName}>{actions}</div>}
    </div>
  )
})

export const TaskDetail = memo(function TaskDetail({
  children,
}: TaskContainerProps): ReactElement {
  return <div className="velar-task-detail">{children}</div>
})

export const TaskDetailActions = memo(function TaskDetailActions({
  children,
}: TaskContainerProps): ReactElement {
  return <div className="velar-task-detail-actions">{children}</div>
})

export const TaskDetailActionGroup = memo(function TaskDetailActionGroup({
  children,
}: TaskContainerProps): ReactElement {
  return <div className="velar-task-detail-action-group">{children}</div>
})

export const TaskDetailHeader = memo(function TaskDetailHeader({
  children,
}: TaskContainerProps): ReactElement {
  return <header className="velar-task-detail-header">{children}</header>
})

export const TaskDetailSections = memo(function TaskDetailSections({
  children,
}: TaskContainerProps): ReactElement {
  return <div className="velar-task-detail-sections">{children}</div>
})

export const TaskDetailSection = memo(function TaskDetailSection({
  children,
}: TaskContainerProps): ReactElement {
  return <section className="velar-task-detail-section">{children}</section>
})

export interface TaskDetailRowProps {
  label: ReactNode
  value: ReactNode
}

export function TaskDetailRow({ label, value }: TaskDetailRowProps): ReactElement {
  return (
    <div className="velar-task-detail-row">
      <span className="velar-task-detail-label">{label}</span>
      <span className="velar-task-detail-value">{value}</span>
    </div>
  )
}

export const TaskReplay = memo(function TaskReplay({
  children,
}: TaskContainerProps): ReactElement {
  return <div className="velar-task-replay">{children}</div>
})

export const TaskReplayHeader = memo(function TaskReplayHeader({
  children,
}: TaskContainerProps): ReactElement {
  return <div className="velar-task-replay-header">{children}</div>
})

export const TaskReplayBody = memo(function TaskReplayBody({
  children,
}: TaskContainerProps): ReactElement {
  return <div className="velar-task-replay-body">{children}</div>
})
