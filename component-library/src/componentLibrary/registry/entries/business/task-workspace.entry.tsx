import { TaskWorkspaceExample } from '@catalog/examples/TaskWorkspaceExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.businessCandidates,
  entryOrder: 12,
  entry: {
    id: 'task-workspace',
    name: 'Task Workspace',
    layer: 'Business',
    status: 'ready',
    domain: 'Tasks',
    source: '@velaros-ai/ui/product/layout/TaskWorkspace',
    origin: 'packages/ui/src/product/layout/TaskWorkspace',
    exampleMode: 'interactive',
    usage:
      'Use for task-management surfaces that pair a selectable task list with a detail or replay pane.',
    avoid:
      'Do not pass product contracts or routing into the shared shell; project titles, status and actions as content.',
    apiComponents: ['TaskWorkspace', 'TaskWorkspacePane', 'TaskListRow', 'TaskDetailRow'],
    examples: [
      {
        id: 'task-workspace-interactive',
        label: 'Interactive: list and detail pane',
        node: <TaskWorkspaceExample />,
      },
    ],
  },
})
