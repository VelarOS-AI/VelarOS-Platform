import { projectChange } from './tools/change'
import { projectCode } from './tools/code'
import { projectEdit } from './tools/edit'
import { projectFile } from './tools/file'
import { projectList } from './tools/list'
import { projectRead } from './tools/read'
import { projectRun } from './tools/run'
import { projectSearch } from './tools/search'
import type { ProjectToolCollection } from './tools/shared'

export { defineProjectTool, runInProjectDirectory, scopeProjectListPatterns } from './tools/shared'

export const projectFileTools: ProjectToolCollection = Object.freeze({
  [projectRead.name]: projectRead,
  [projectList.name]: projectList,
  [projectSearch.name]: projectSearch,
})
export const projectChangeTools: ProjectToolCollection = Object.freeze({
  [projectFile.name]: projectFile,
  [projectEdit.name]: projectEdit,
  [projectChange.name]: projectChange,
})
export const projectExecutionTools: ProjectToolCollection = Object.freeze({ [projectRun.name]: projectRun })
export const projectCodeTools: ProjectToolCollection = Object.freeze({ [projectCode.name]: projectCode })

/** Version 2 model contract. Domain SDK and persisted version 1 tools have explicit adapters. */
export const projectTools: ProjectToolCollection = Object.freeze({
  ...projectFileTools,
  [projectFile.name]: projectFile,
  [projectEdit.name]: projectEdit,
  ...projectCodeTools,
  [projectChange.name]: projectChange,
  ...projectExecutionTools,
})
