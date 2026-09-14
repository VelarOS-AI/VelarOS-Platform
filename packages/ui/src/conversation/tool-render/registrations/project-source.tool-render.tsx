import { lazy } from 'react'

import type { ToolRenderRegistration } from '../ToolRenderRegistry'

const ProjectSourceToolRender = lazy(async () => import('../projectSource/ProjectSourceToolRender').then((module) => ({ default: module.ProjectSourceToolRender })))

const registration: ToolRenderRegistration = {
  toolNames: ['project:read', 'project:search', 'project:code'],
  component: ProjectSourceToolRender,
}
export default registration
