import { type ReactElement, useState } from 'react'

import {
  TaskDetail,
  TaskDetailHeader,
  TaskDetailRow,
  TaskDetailSection,
  TaskDetailSections,
  TaskList,
  TaskListRow,
  TaskWorkspace,
  TaskWorkspacePane,
  TaskWorkspaceRail,
} from '@velaros-ai/ui/product/layout/TaskWorkspace'

const Tasks = [
  { id: 'review', title: 'Review release notes', metadata: 'Desktop', status: 'Ready' },
  { id: 'verify', title: 'Verify package consumers', metadata: 'Platform', status: 'Running' },
] as const

export function TaskWorkspaceExample(): ReactElement {
  const [selectedId, setSelectedId] = useState<(typeof Tasks)[number]['id']>('verify')
  const selectedTask = Tasks.find((task) => task.id === selectedId) ?? Tasks[0]

  return (
    <TaskWorkspace detailOpen>
      <TaskWorkspaceRail>
        <TaskList>
          {Tasks.map((task) => (
            <TaskListRow
              key={task.id}
              leading={<span aria-hidden="true">•</span>}
              title={task.title}
              metadata={task.metadata}
              trailing={task.status}
              selected={task.id === selectedId}
              onSelect={() => setSelectedId(task.id)}
              selectLabel={`Open ${task.title}`}
            />
          ))}
        </TaskList>
      </TaskWorkspaceRail>
      <TaskWorkspacePane ariaLabel={selectedTask.title}>
        <TaskDetail>
          <TaskDetailHeader>{selectedTask.title}</TaskDetailHeader>
          <TaskDetailSections>
            <TaskDetailSection>
              <TaskDetailRow label="Workspace" value={selectedTask.metadata} />
              <TaskDetailRow label="Status" value={selectedTask.status} />
            </TaskDetailSection>
          </TaskDetailSections>
        </TaskDetail>
      </TaskWorkspacePane>
    </TaskWorkspace>
  )
}
