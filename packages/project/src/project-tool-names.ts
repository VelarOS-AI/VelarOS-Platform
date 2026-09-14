/** Canonical model-facing tool ids owned by the Project domain. */
export const ProjectToolNames = Object.freeze({
  read: 'project:read',
  list: 'project:list',
  search: 'project:search',
  file: 'project:file',
  edit: 'project:edit',
  code: 'project:code',
  change: 'project:change',
  run: 'project:run',
} as const)

/** Explicit version 1 compatibility; these names do not enter current model discovery. */
export const LegacyProjectToolNames = Object.freeze({
  read: 'project:read',
  list: 'project:list',
  search: 'project:search',
  queryCode: 'project:query-code',
  write: 'project:write',
  edit: 'project:edit',
  rollback: 'project:rollback',
  run: 'project:run',
} as const)

export type ProjectToolName = (typeof ProjectToolNames)[keyof typeof ProjectToolNames]
