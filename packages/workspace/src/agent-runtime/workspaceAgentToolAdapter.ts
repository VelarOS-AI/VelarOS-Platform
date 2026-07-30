import { isFunction } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ToolContractDescriptionSpec } from '@velaros-ai/core/tool-contract'
import type { ToolCategoryId } from '@velaros-ai/core/types'

import type { AgentToolSpec } from '../agent-tools.js'
import { WorkspaceAgentToolSpecs } from '../Workspace.tool.js'
import type { WorkspaceKernelToolName } from '../workspace-tool-names.js'

import {
  defineWorkspaceVelaTool,
  type DefineWorkspaceVelaToolOptions,
  type WorkspaceToolRunContext,
} from './workspaceToolMiddleware'

type WorkspaceAgentToolSpecFor<TInput extends Record<string, any>> = AgentToolSpec<TInput>
type WorkspaceAgentDescriptionPatch = Partial<Omit<ToolContractDescriptionSpec, 'role'>>

type WorkspaceAgentToolOptions<TInput extends Record<string, any>> = Omit<
  DefineWorkspaceVelaToolOptions<TInput>,
  | 'name'
  | 'category'
  | 'role'
  | 'summary'
  | 'suitable'
  | 'forbidden'
  | 'protocol'
  | 'usage'
  | 'examples'
  | 'notes'
  | 'execute'
> & {
  descriptionPatch?:
    | WorkspaceAgentDescriptionPatch
    | ((spec: WorkspaceAgentToolSpecFor<TInput>) => WorkspaceAgentDescriptionPatch)
  execute: (run: WorkspaceToolRunContext<TInput>) => Promise<unknown>
}

const WorkspaceRoleToCategory: Partial<Record<ToolContractDescriptionSpec['role'], ToolCategoryId>> = {
  inspect: 'workspace-inspect',
  edit: 'workspace-edit',
  execute: 'workspace-execute',
}

const WorkspaceAgentToolSpecsByName = new Map<string, AgentToolSpec>(
  WorkspaceAgentToolSpecs.map((spec) => [spec.name, spec])
)

export function validateWorkspaceAgentToolExamples(
  toolName: string,
  schema: AgentToolSpec<Record<string, any>>['schema'],
  examples: ReadonlyArray<Record<string, unknown>>
): void {
  for (const example of examples) {
    const parsed = schema.safeParse(example)
    if (parsed.success) {
      continue
    }

    const issues = parsed.error.issues
      .map((issue) => {
        const path = issue.path.map(String).join('.') || '<root>'
        return `${path}: ${issue.message}`
      })
      .join('; ')

    throw new AppError(
      'INVARIANT',
      `Workspace tool ${toolName} description example does not satisfy Agent schema: ${JSON.stringify(example)} (${issues})`
    )
  }
}

export function getWorkspaceAgentToolSpec(toolName: WorkspaceKernelToolName): AgentToolSpec {
  const spec = WorkspaceAgentToolSpecsByName.get(toolName)
  if (!spec) {
    throw new AppError('INVARIANT', `Missing @velaros-ai/workspace agent tool spec for ${toolName}`)
  }
  return spec
}

export function defineWorkspaceAgentTool<TInput extends Record<string, any>>(
  toolName: WorkspaceKernelToolName,
  options: WorkspaceAgentToolOptions<TInput>
) {
  const spec = getWorkspaceAgentToolSpec(toolName) as WorkspaceAgentToolSpecFor<TInput>
  const patch = isFunction(options.descriptionPatch)
    ? options.descriptionPatch(spec)
    : options.descriptionPatch
  const descriptionSpec: ToolContractDescriptionSpec = {
    ...spec.descriptionSpec,
    ...patch,
  }
  validateWorkspaceAgentToolExamples(toolName, options.schema, descriptionSpec.examples)
  for (const [surfaceName, surface] of Object.entries(options.surfaces ?? {})) {
    if (!surface) continue
    validateWorkspaceAgentToolExamples(`${toolName}.${surfaceName}`, surface.schema, surface.examples)
  }
  const category = WorkspaceRoleToCategory[descriptionSpec.role]
  if (!category) {
    throw new AppError('INVARIANT', `Unsupported workspace tool role: ${descriptionSpec.role}`)
  }

  return defineWorkspaceVelaTool({
    ...options,
    name: toolName,
    category,
    ...descriptionSpec,
  })
}
