const SystemToolNames = Object.freeze({
  read: 'system:read',
  write: 'system:write',
  edit: 'system:edit',
  list: 'system:list',
  search: 'system:search',
  run: 'system:run',
  processes: 'system:processes',
  open: 'system:open',
  refreshEnvironment: 'system:refresh-environment',
  listTasks: 'system:list-tasks',
  terminateTask: 'system:terminate-task',
} as const)

type SystemToolName = (typeof SystemToolNames)[keyof typeof SystemToolNames]

export { SystemToolNames }
export type { SystemToolName }
