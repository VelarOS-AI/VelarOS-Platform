import { createNodeRuntime, type NodeRuntimeOptions } from '@velaros-ai/velaros/node'
import {
  createProjectKernel,
  createProjectCapabilityModule,
  type ProjectSpacePort,
} from '@velaros-ai/capabilities/project'

declare const projectModule: ReturnType<typeof createProjectCapabilityModule>
const modules: NonNullable<NodeRuntimeOptions['modules']> = [projectModule]
export type Consumer = { project: ProjectSpacePort; options: NodeRuntimeOptions }
void [createProjectKernel, createProjectCapabilityModule, createNodeRuntime, modules]
