import type {
  ToolPermission,
} from '@velaros-ai/agent/protocol'
import type {
  ApprovalPort,
  FileContextCarrier,
  ToolContractRuntimeSpec,
  ToolContractSurface,
} from '@velaros-ai/agent/tool-contract'

import type { ProjectCodeQuery } from '../project-code-query.js'
import type {
  ProjectAuthorizationDecision,
  ProjectCommandResult,
  ProjectMutationAuthorizationInput,
  ProjectRunCommandOptions,
  ProjectSandboxApplyOptions,
  ProjectSandboxApplyResult,
  ProjectSandboxCreateRequest,
  ProjectSandboxDiff,
  ProjectSandboxDiffOptions,
  ProjectSandboxDiscardResult,
  ProjectSandboxRecord,
  ProjectSandboxRunOptions,
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
  /** Optional graph analysis backend; ordinary code queries remain available independently. */
  codeAnalysisAvailable?: () => boolean
  /** 演练沙箱端口；宿主用系统能力实现（Desktop 用本地内核）。没接的宿主没有 project:sandbox。 */
  sandbox?: ProjectSandboxPort
}

/**
 * 演练沙箱端口：把项目目录镜像到临时区，镜像里跑的命令被宿主约束在镜像根之内，跑完能看差量、能把文件变化落回项目、能整个丢弃。
 * 项目工具出不了项目边界，所以在镜像里跑命令也经这个端口（runInSandbox），不走 project:run。
 */
export interface ProjectSandboxPort {
  /** 建沙箱：source 已经是项目内的绝对路径；没有约束后端时宿主拒绝，不留目录。 */
  createSandbox: (options: ProjectSandboxCreateRequest) => Promise<ProjectSandboxRecord>
  /** 在镜像根里跑一条命令，约束钉在镜像根，写到项目会失败。 */
  runInSandbox: (options: ProjectSandboxRunOptions, abortSignal?: AbortSignal) => Promise<ProjectCommandResult>
  /** 镜像相对创建时的变化。 */
  diffSandbox: (options: ProjectSandboxDiffOptions) => Promise<ProjectSandboxDiff>
  /** 把镜像里的文件变化落回项目：源文件自建沙箱以来变过整批不落；.git 永远不落。授权与确认由工具在调用前完成。 */
  applySandbox: (options: ProjectSandboxApplyOptions) => Promise<ProjectSandboxApplyResult>
  /** 删掉镜像；路径不在沙箱基目录之下时宿主拒绝。 */
  discardSandbox: (sandboxId: string) => Promise<ProjectSandboxDiscardResult>
}

export interface ProjectToolSystemApi {
  canStartBackgroundCommands: () => boolean
}

export interface ProjectToolContext extends FileContextCarrier {
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
