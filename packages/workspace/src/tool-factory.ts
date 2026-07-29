import { type z } from 'zod'

import {
  buildToolContractDescription,
  type NonEmptyToolContractList,
  type ToolContractDescriptionSpec,
  ToolContractExampleRegistry,
} from '@velaros-ai/core/tool-contract'
import type { ToolCategoryId } from '@velaros-ai/core/types'

import type { AgentToolSpec } from './agent-tools.js'

type WorkspaceToolRole = 'inspect' | 'edit' | 'execute'

const RoleToCategoryId: Record<WorkspaceToolRole, ToolCategoryId> = {
  inspect: 'workspace-inspect',
  edit: 'workspace-edit',
  execute: 'workspace-execute',
}

export interface WorkspaceToolDescriptionSpec extends Omit<ToolContractDescriptionSpec, 'role' | 'examples'> {
  role: WorkspaceToolRole
  examples: NonEmptyToolContractList<Record<string, unknown>>
}

interface DefineWorkspaceToolInput<TInput> extends WorkspaceToolDescriptionSpec {
  name: string
  schema: z.ZodType<TInput>
  executeSchema?: z.ZodType<TInput>
  execute: AgentToolSpec<TInput>['execute']
}

const WorkspaceToolExampleRegistry = new ToolContractExampleRegistry()

export function buildToolDescription(name: string, spec: WorkspaceToolDescriptionSpec): string {
  return buildToolContractDescription(
    name,
    RoleToCategoryId[spec.role],
    spec,
    WorkspaceToolExampleRegistry
  )
}

export function defineWorkspaceTool<TInput extends Record<string, unknown>>(
  input: DefineWorkspaceToolInput<TInput>
): AgentToolSpec<TInput> {
  const {
    name,
    schema,
    executeSchema,
    execute,
    ...descriptionSpec
  } = input

  return {
    name,
    descriptionSpec,
    description: buildToolDescription(name, descriptionSpec),
    schema,
    executeSchema,
    execute,
  }
}

export function getWorkspaceToolExampleInputs(): ReadonlyMap<string, ReadonlyArray<Record<string, unknown>>> {
  return WorkspaceToolExampleRegistry.snapshot()
}
