import type {
  ToolPermission,
} from '@velaros-ai/agent/protocol'
import type {
  ApprovalPort,
  ToolContractRuntimeSpec,
  ToolContractSurface,
} from '@velaros-ai/agent/tool-contract'

import type { ProjectCodeQuery } from '../project-code-query.js'
import type {
  ProjectAuthorizationDecision,
  ProjectCommandResult,
  ProjectMutationAuthorizationInput,
  ProjectRunCommandOptions,
} from '../project-contracts.js'

import type { AgentProjectKernelPort } from './ProjectKernelPort'

export type { ProjectAuthorizationDecision }

export interface ProjectToolApi {
  getRootPath: () => string
  runInDirectory: <T>(path: string, action: () => Promise<T>) => Promise<T>
  kernel: () => Promise<AgentProjectKernelPort>
  runWithApproval: <T>(action: () => Promise<T>) => Promise<T>
  prepareMutation: (
    input: ProjectMutationAuthorizationInput
  ) => Promise<ProjectAuthorizationDecision>
  runCommand: (
    command: string,
    options?: ProjectRunCommandOptions,
    allowDangerous?: boolean,
    abortSignal?: AbortSignal
  ) => Promise<ProjectCommandResult>
  /** Project 内置代码理解入口；宿主可用 CodeGraph 覆盖同一 action 面的增强查询。 */
  queryCode: (input: ProjectCodeQuery, context: ProjectToolContext) => Promise<unknown>
}

export interface ProjectToolSystemApi {
  canStartBackgroundCommands: () => boolean
}

export interface ProjectToolContext {
  abortSignal: AbortSignal
  project: ProjectToolApi
  system: ProjectToolSystemApi
  approval: ApprovalPort
}

export type ToolContext = ProjectToolContext

export type VelaToolSurface<
  TSurfaceInput extends Record<string, any> = Record<string, any>,
  TBaseInput extends Record<string, any> = Record<string, any>,
> = ToolContractSurface<TSurfaceInput, TBaseInput, ProjectToolContext>

export type VelaTool<TInput extends Record<string, any> = Record<string, any>> =
  ToolContractRuntimeSpec<TInput, ProjectToolContext, any, ToolPermission>
