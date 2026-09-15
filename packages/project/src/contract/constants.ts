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
  sandbox: 'project:sandbox',
} as const)

export type ProjectToolName = (typeof ProjectToolNames)[keyof typeof ProjectToolNames]

/** 项目空间作为官方内置 mod 的身份。 */
export const ProjectModId = 'velaros.project' as const

/** 项目空间自己的身份，mod 清单里声明的空间用它。 */
export const ProjectSpaceId = 'project' as const

/** 模型面工具入参契约的版本：失败调用的入参复用只在同一版本内进行。 */
export const ProjectToolContract = Object.freeze({
  /** 当前模型面工具入参的契约版本。 */
  inputVersion: 2,
})
