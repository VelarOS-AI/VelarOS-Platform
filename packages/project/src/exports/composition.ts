import { createProjectKernel, type CreateProjectKernelOptions, type ProjectKernel } from '../impl/kernel/project-kernel.js'
import { projectTools } from '../impl/ProjectTools.js'

export * from '../impl/composition/approval.js'
export * from '../impl/composition/code-analysis.js'
export * from '../impl/composition/mod.js'

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
