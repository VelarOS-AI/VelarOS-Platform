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

const SystemToolCategoryByName = Object.freeze({
  [SystemToolNames.read]: 'system-files',
  [SystemToolNames.write]: 'system-files',
  [SystemToolNames.edit]: 'system-files',
  [SystemToolNames.list]: 'system-files',
  [SystemToolNames.search]: 'system-files',
  [SystemToolNames.run]: 'system-execution',
  [SystemToolNames.refreshEnvironment]: 'system-execution',
  [SystemToolNames.processes]: 'system-processes',
  [SystemToolNames.listTasks]: 'system-processes',
  [SystemToolNames.terminateTask]: 'system-processes',
  [SystemToolNames.open]: 'system-desktop',
} as const)

type SystemToolCategoryId = (typeof SystemToolCategoryByName)[SystemToolName]

export { SystemToolCategoryByName, SystemToolNames }
export type { SystemToolCategoryId, SystemToolName }
