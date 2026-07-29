import { type z } from 'zod'

import { isEmpty,isString } from '@velaros-ai/core'
import type { ToolContractDescriptionSpec } from '@velaros-ai/core/tool-contract'
import {
  compactStructuredToolDescription,
  type ToolDescriptionDetail,
} from '@velaros-ai/core/utils/ToolDescription'

import type { WorkspaceKernel } from './core/workspace.js'
import type { BatchTask } from './types/batch.js'
import type { ReadInput } from './types/io.js'
import type { batchTaskSchema } from './tool-schemas.js'
import type { RunBatchToolInput } from './tool-schemas.js'
import { WorkspaceAgentToolSpecs } from './Workspace.tool.js'
export { createWorkspaceToolSchemaBundle, schemaToInputSchema } from './tool-schema.js'

export const CommitEditFinalizerCheckIds = new Set(['external.prettier', 'external.eslint'])
export const CommitEditNoDefaultValidatorCheck = '__velaros_commit_edit_no_default_finalizers__'
const DefaultAgentReadMaxChars = 500_000

type AgentReadInput = Omit<ReadInput, 'path' | 'baseRevision'> & {
  path: string | string[]
  baseRevisions?: Record<string, string>
  allowUnbounded?: boolean
}
type SchemaBatchTask = z.infer<typeof batchTaskSchema>
type AgentBatchInput = RunBatchToolInput

export interface ExecuteWorkspaceRunBatchOptions {
  rootPath?: string
}

export interface AgentToolDefinition<TInput = unknown> {
  name: string
  descriptionSpec: ToolContractDescriptionSpec
  description: string
  schema: z.ZodType<TInput>

  execute(input: TInput): Promise<unknown>
}

export interface AgentToolSpec<TInput = any> extends Omit<
  AgentToolDefinition<TInput>,
  'execute'
> {
  executeSchema?: z.ZodType<TInput>
  execute(workspace: WorkspaceKernel, input: TInput): Promise<unknown> | unknown
}

export interface CreateAgentToolsOptions {
  /** 工具描述详细程度（L4 渐进式披露）；默认 'full'，'compact' 仅保留每个分节首条要点。 */
  detail?: ToolDescriptionDetail
}

export function createAgentTools(
  workspace: WorkspaceKernel,
  options: CreateAgentToolsOptions = {}
): AgentToolDefinition[] {
  const detail = options.detail ?? 'full'
  return WorkspaceAgentToolSpecs.map(({ execute, schema, executeSchema, description, ...tool }) => ({
    ...tool,
    description: detail === 'compact' ? compactStructuredToolDescription(description) : description,
    schema,
    execute: async (input: any) => execute(workspace, (executeSchema ?? schema).parse(input ?? {})),
  }))
}

export async function executeWorkspaceRead(
  workspace: WorkspaceKernel,
  input: AgentReadInput,
  options: ExecuteWorkspaceRunBatchOptions = {}
) {
  const { path, baseRevisions, allowUnbounded: _allowUnbounded, ...rest } = input
  const paths = normalizeReadPaths(path)
  // 宽容:没给任何上界不再硬拒(真机实测这是全场最高频工具错误,27失败/20会话,
  // 且每次都引发补参重试+同文件重读)。缺上界=按安全默认上限读(结果仍有界,
  // 超大输出另有 kernel 页出兜底);allowUnbounded 语义不变。
  const appliedDefaultBound = !hasAgentReadBound(input)
  const readInput = appliedDefaultBound || (input.allowUnbounded && !input.maxBytes && !input.maxChars)
    ? { ...rest, maxChars: DefaultAgentReadMaxChars }
    : rest
  const files = await Promise.all(
    paths.map((path: string) => workspace.read({
      ...readInput,
      path,
      baseRevision: baseRevisions?.[path],
    }))
  )
  const rootPath = options.rootPath ?? (await workspace.status()).root
  return {
    rootPath,
    count: files.length,
    files,
    // 回显调整:让模型知道系统补了默认上限,而不是静默改写(可自行传 range/maxChars 收窄)。
    ...(appliedDefaultBound
      ? { appliedDefaultBound: { maxChars: DefaultAgentReadMaxChars } }
      : {}),
  }
}

function normalizeReadPaths(path: string | string[]): string[] {
  return isString(path) ? [path] : path
}

function hasAgentReadBound(input: AgentReadInput): boolean {
  return Boolean(
    input.range?.endLine ||
    input.maxBytes ||
    input.maxChars ||
    input.allowUnbounded
  )
}

export async function executeWorkspaceRunBatch(
  workspace: WorkspaceKernel,
  input: AgentBatchInput,
  options: ExecuteWorkspaceRunBatchOptions = {}
) {
  return workspace.runBatch({
    ...input,
    tasks: input.tasks.map((task) => normalizeAgentBatchTask(workspace, task, options)),
  })
}

function normalizeAgentBatchTask(
  workspace: WorkspaceKernel,
  task: SchemaBatchTask,
  options: ExecuteWorkspaceRunBatchOptions
): BatchTask {
  const { id, dependsOn } = task
  switch (task.op.kind) {
    case 'read': {
      const input = task.op.input
      return {
        id,
        dependsOn,
        resources: normalizeReadPaths(input.path),
        op: {
          kind: 'custom',
          run: () => executeWorkspaceRead(workspace, input, options),
        },
      }
    }
    case 'search':
      return { id, dependsOn, op: { kind: 'search', input: task.op.input } }
    case 'resolve':
      return { id, dependsOn, op: { kind: 'resolve', input: task.op.input } }
    case 'prepare':
      return { id, dependsOn, op: { kind: 'prepare', input: task.op.input } }
    case 'apply':
      return { id, dependsOn, op: { kind: 'apply', input: task.op.input } }
    case 'validate':
      return { id, dependsOn, op: { kind: 'validate', input: task.op.input } }
    case 'rollback':
      return { id, dependsOn, op: { kind: 'rollback', input: task.op.input } }
    default: {
      const unknownOp: never = task.op
      throw new Error(`未知批处理操作: ${(unknownOp as { kind: string }).kind}`)
    }
  }
}

export async function executeWorkspaceCommitEdit(workspace: WorkspaceKernel, input: any) {
  const { autoApply = true, checks, postconditions, ...prepareInput } = input
  const { checks: validationChecks, deferredFinalizerChecks } =
    await resolveCommitValidationChecks(workspace, checks)
  const tx = await workspace.prepareEdit(prepareInput)
  const validation = await workspace.validate({
    transactionId: tx.transactionId,
    checks: validationChecks,
    postconditions,
  })
  const {
    patches,
    diff: _diff,
    baseSnapshots: _baseSnapshots,
    metadata: _metadata,
    status: _preparedStatus,
    ...transactionSummary
  } = tx
  const baseResult = {
    ...transactionSummary,
    patchCount: patches.length,
    validation,
    ...(!isEmpty(deferredFinalizerChecks)
      ? {
          deferredFinalizerChecks,
          finalizerNote:
            'commit_edit 默认跳过 Prettier/ESLint；这些检查应在最终整理阶段运行，或显式通过 checks 请求。',
        }
      : {}),
  }
  if (!validation.ok) return { ...baseResult, status: 'validation_failed', changed: false, applied: false }
  if (!autoApply) return { ...baseResult, status: 'validated', changed: false, applied: false }
  const apply = await workspace.applyEdit({ transactionId: tx.transactionId })
  return {
    ...baseResult,
    ...apply,
    changed: true,
    applied: true,
  }
}

/**
 * 解析 commit_edit 的默认校验器集合（单一事实来源，供包侧与消费端共享）：
 * 显式 checks 直接透传；否则用 status().validators 去掉 Prettier/ESLint 收尾校验，
 * 把它们挪到 deferredFinalizerChecks，避免每次编辑都触发重格式化。
 */
export async function resolveCommitValidationChecks(
  workspace: WorkspaceKernel,
  checks: string[] | undefined
): Promise<{ checks?: string[]; deferredFinalizerChecks: string[] }> {
  if (checks?.length) return { checks, deferredFinalizerChecks: [] }

  const status = await workspace.status()
  const checksWithoutFinalizers = status.validators.filter(
    (validator) => !CommitEditFinalizerCheckIds.has(validator)
  )
  const deferredFinalizerChecks = status.validators.filter((validator) =>
    CommitEditFinalizerCheckIds.has(validator)
  )
  return {
    checks:
      !isEmpty(checksWithoutFinalizers) ? checksWithoutFinalizers : [CommitEditNoDefaultValidatorCheck],
    deferredFinalizerChecks,
  }
}
