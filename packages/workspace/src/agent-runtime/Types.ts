import type {
  ApprovalPort,
  ToolContractRuntimeSpec,
  ToolContractSurface,
} from '@velaros-ai/core/tool-contract'
import type {
  ToolPermission,
} from '@velaros-ai/core/types'

import type { WorkspaceSandboxPort } from '../types/sandbox.js'
import type {
  WorkspaceAuthorizationDecision,
  WorkspaceCommandResult,
  WorkspaceFileEntry,
  WorkspaceFindFilesOptions,
  WorkspaceGitDiffOptions,
  WorkspaceGitDiffResult,
  WorkspaceGitFileStatusEntry,
  WorkspaceGitStatusResult,
  WorkspaceListOptions,
  WorkspaceMutationAuthorizationInput,
  WorkspaceProjectInfo,
  WorkspaceRootEntry,
  WorkspaceRunCommandOptions,
  WorkspaceRunVerificationOptions,
  WorkspaceSearchMatch,
  WorkspaceSearchOptions,
  WorkspaceToolInstallSuggestion,
  WorkspaceVerificationRunResult,
  WorkspaceVerificationStatus,
} from '../workspace-contracts.js'

import type { AgentWorkspaceKernelPort } from './WorkspaceCapabilityPort'

export type { WorkspaceAuthorizationDecision }

export interface CodingVerificationFailure {
  command: string
  status: 'failed' | 'timed-out'
  issues: string[]
}

export type ToolWorkspaceSandboxApi = WorkspaceSandboxPort

export interface CodingSessionSnapshot {
  modifiedPaths: string[]
  hasWorkspaceEdits: boolean
  hasWorkspaceInspection: boolean
  needsChangeInspection: boolean
  needsVerificationCommand: boolean
  reminderIssuedForCurrentEdits: boolean
  verificationReminderIssuedForCurrentEdits?: boolean
  latestVerificationStatus: Nullable<WorkspaceVerificationStatus>
  activeVerificationFailure: Nullable<CodingVerificationFailure>
}

export interface WorkspaceToolCodingSessionApi {
  getSnapshot: () => CodingSessionSnapshot
  getRecentFileChanges: () => Array<{
    toolName: string
    path: string
    created: boolean
    added: number
    removed: number
    changeId: string
  }>
  /** 本轮模型输入侧可用窗口（token）；未知时为 null。供 commit_edit 编辑预算门控读取。 */
  getUsableContextWindowTokens?: () => Nullable<number>
}

export type WorkspaceToolRoot = WorkspaceRootEntry

export interface WorkspaceToolWorkspaceApi {
  getRootPath: () => string
  listRoots: () => WorkspaceToolRoot[]
  runInDirectory: <T>(path: string, action: () => Promise<T>) => Promise<T>
  kernel: () => Promise<AgentWorkspaceKernelPort>
  kernelForRoot: (rootPath: string) => Promise<AgentWorkspaceKernelPort>
  runWithApproval: <T>(action: () => Promise<T>) => Promise<T>
  prepareMutationWorkspace: (
    input: WorkspaceMutationAuthorizationInput
  ) => Promise<WorkspaceAuthorizationDecision>
  listFiles: (options?: WorkspaceListOptions) => Promise<WorkspaceFileEntry[]>
  findFiles: (options: WorkspaceFindFilesOptions) => Promise<WorkspaceFileEntry[]>
  getProjectInfo: () => Promise<WorkspaceProjectInfo>
  getProjectInfoForRoot: (rootPath: string) => Promise<WorkspaceProjectInfo>
  runVerificationPlan: (
    options?: WorkspaceRunVerificationOptions,
    abortSignal?: AbortSignal
  ) => Promise<WorkspaceVerificationRunResult>
  searchInFiles: (options: WorkspaceSearchOptions) => Promise<WorkspaceSearchMatch[]>
  getGitStatus: () => Promise<WorkspaceGitStatusResult>
  listChangedFiles: () => Promise<WorkspaceGitFileStatusEntry[]>
  getGitDiff: (options?: WorkspaceGitDiffOptions) => Promise<WorkspaceGitDiffResult>
  runCommand: (
    command: string,
    options?: WorkspaceRunCommandOptions,
    allowDangerous?: boolean,
    abortSignal?: AbortSignal
  ) => Promise<WorkspaceCommandResult>
}

export interface WorkspaceToolSystemApi {
  discoverProjects?: (options?: {
    rootPaths?: string[]
    maxDepth?: number
    limit?: number
    refresh?: boolean
  }) => Promise<any[]>
  canStartBackgroundCommands: () => boolean
  createSystemToolInstallSuggestion?: (input: {
    command: string
    reason: string
    scope: 'workspace' | 'system'
  }) => Nullable<WorkspaceToolInstallSuggestion>
}

export interface WorkspaceToolContext {
  abortSignal: AbortSignal
  codingSession: WorkspaceToolCodingSessionApi
  workspace: WorkspaceToolWorkspaceApi
  workspaceSandbox?: ToolWorkspaceSandboxApi
  system: WorkspaceToolSystemApi
  approval: ApprovalPort
}

export type ToolContext = WorkspaceToolContext

export type VelaToolSurface<
  TSurfaceInput extends Record<string, any> = Record<string, any>,
  TBaseInput extends Record<string, any> = Record<string, any>,
> = ToolContractSurface<TSurfaceInput, TBaseInput, WorkspaceToolContext>

export type VelaTool<TInput extends Record<string, any> = Record<string, any>> =
  ToolContractRuntimeSpec<TInput, WorkspaceToolContext, any, ToolPermission>
