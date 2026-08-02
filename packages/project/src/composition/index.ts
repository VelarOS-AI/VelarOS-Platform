import { projectTools } from '../agent/Project.tool.js'
import { createProjectKernel, type CreateProjectKernelOptions, type ProjectKernel } from '../core/project-kernel.js'

export * from './approval.js'
export * from './mod.js'

type CreateProjectSpaceOptions = CreateProjectKernelOptions

interface ProjectSpace {
  readonly id: 'project'
  readonly kernel: ProjectKernel
  readonly tools: typeof projectTools
}

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
export type { CreateProjectSpaceOptions, ProjectSpace }
