import type { ProjectSpace } from '../contract/provides.js'
import { createProjectKernel, type CreateProjectKernelOptions } from '../impl/kernel/LocalProjectKernel.js'
import { projectTools } from '../impl/ProjectTools.js'

export * from '../impl/composition/approval.js'
export * from '../impl/composition/code-analysis.js'
export * from '../impl/composition/mod.js'

type CreateProjectSpaceOptions = CreateProjectKernelOptions

async function createProjectSpace(
  options: CreateProjectSpaceOptions
): Promise<ProjectSpace> {
  const kernel = await createProjectKernel(options)
  return Object.freeze({
    id: 'project',
    kernel,
    tools: projectTools,
  })
}

export { createProjectSpace }
export type { CreateProjectSpaceOptions }
export type { ProjectSpace } from '../contract/provides.js'
export type { ProjectBundledModDefinition } from '../contract/provides.js'
