/** Canonical model-facing tool ids owned by the Project domain. */
const ProjectToolNames = Object.freeze({
  read: 'project:read',
  list: 'project:list',
  search: 'project:search',
  write: 'project:write',
  edit: 'project:edit',
  rollback: 'project:rollback',
  run: 'project:run',
} as const)

type ProjectToolName = (typeof ProjectToolNames)[keyof typeof ProjectToolNames]

export { ProjectToolNames }
export type { ProjectToolName }
