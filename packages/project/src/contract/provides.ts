/** Read-only consumer contract used by Editors, Workbenches and audit views. */
import type { AgentModManifest, ToolCategoryDefinition, ToolPermission } from '@velaros-ai/agent/protocol'
import type { ToolContractRuntimeSpec,ToolContractSurface } from '@velaros-ai/agent/tool-contract'
import type { KernelCallableCapabilityService } from '@velaros-ai/kernel/contracts/abi'

import type { ProjectKernel } from '../impl/kernel/LocalProjectKernel.js'
import type { ProjectChangeListener,ProjectChangeListOptions, ProjectChangeRecord } from '../types/change-feed.js'
import type { ApplyResult, RollbackResult } from '../types/edit.js'
import type { ProjectTransactionInput } from '../types/transaction.js'

import type { ProjectModId } from './constants.js'
import type { ProjectToolContext } from './requires.js'

export type VelaToolSurface<
  TSurfaceInput extends Record<string, any> = Record<string, any>,
  TBaseInput extends Record<string, any> = Record<string, any>,
> = ToolContractSurface<TSurfaceInput, TBaseInput, ProjectToolContext>

export type VelaTool<TInput extends Record<string, any> = Record<string, any>> =
  ToolContractRuntimeSpec<TInput, ProjectToolContext, any, ToolPermission>

export type ProjectToolCollection = Readonly<Record<string, VelaTool<any>>>

export interface ProjectBundledModDefinition {
  readonly id: typeof ProjectModId
  readonly specifier: string
  readonly defaultEnabled: true
  readonly manifest: AgentModManifest
  readonly bindings: {
    readonly tools: ProjectToolCollection
    readonly toolCategories: Readonly<Record<string, ToolCategoryDefinition>>
  }
}

/**
 * The complete transaction surface intended for Desktop and Editor consumers.
 * Root paths, persistence paths, policies, providers and edit preparation stay
 * on the host-owned ProjectKernel and cannot cross this boundary by accident.
 */
export interface ProjectTransactionController extends ProjectChangeFeed {
  apply(input: ProjectTransactionInput): Promise<ApplyResult>
  rollback(input: ProjectTransactionInput): Promise<RollbackResult>
}

export interface ProjectSpace {
  readonly id: 'project'
  readonly kernel: ProjectKernel
  readonly tools: ProjectToolCollection
}

export interface ProjectCapabilityService extends KernelCallableCapabilityService {
  readonly tools: Readonly<ProjectToolCollection>
}

export interface ProjectChangeFeed {
  list(options?: ProjectChangeListOptions): readonly ProjectChangeRecord[]
  get(transactionId: string): ProjectChangeRecord | undefined
  subscribe(listener: ProjectChangeListener): () => void
}
