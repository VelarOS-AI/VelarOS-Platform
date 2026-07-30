import { isEmpty,isFalse, isFunction, isPlainObject } from '@velaros-ai/core'
import {
  buildToolContractDescription,
  type DefineToolContractSurfaceInput,
  type ToolContractDescriptionSpec,
} from '@velaros-ai/core/tool-contract'
import type { ToolCategoryId } from '@velaros-ai/core/types'
import { optionalWhen } from '@velaros-ai/core/utils/optionalWhen'

import {
  buildWorkspaceMutationSkippedResult,
  prepareWorkspaceMutation,
  runWithDirectory,
} from './Helpers'
import {
  augmentPrepareEditSnapshotHints,
  augmentRevisionMismatchMessage,
  buildDiscoveryPreflight,
  buildEditPreflight,
  buildModelPreflightResult,
  buildToolErrorResult,
  requireKernel,
  runWorkspaceTool,
  transactionPreflightAdvisories,
  type WorkspaceSearchExcludePreset,
} from './KernelToolShared'
import type { VelaTool, WorkspaceToolContext } from './Types'
import type { AgentWorkspaceKernelPort } from './WorkspaceCapabilityPort'

export interface WorkspaceToolRunContext<TInput extends Record<string, any>> {
  input: TInput
  ctx: WorkspaceToolContext
  kernel: AgentWorkspaceKernelPort
}

type WorkspaceToolExecute<TInput extends Record<string, any>> =
  | VelaTool<TInput>['execute']
  | ((run: WorkspaceToolRunContext<TInput>) => Promise<unknown>)

type WorkspaceToolSurfaceOption<TInput extends Record<string, any>> =
  DefineToolContractSurfaceInput<any, TInput, WorkspaceToolContext>

export interface WorkspaceToolMiddlewareConfig<TInput extends Record<string, any>> {
  /** 工具名，用于错误归一与 preflight 文案。 */
  action: string
  /** 是否注入 kernel（默认 true）。 */
  kernel?: boolean
  /** 是否用 runWithDirectory 处理 input.cwd（默认 false）。 */
  directory?: boolean
  /** 是否经 runWorkspaceTool 归一错误（默认 true）。 */
  normalizeErrors?: boolean | { extra?: (input: TInput) => Record<string, any> }
  /** 捕获后补 revision 不一致提示；编辑类工具可再加 prepare 快照提示。 */
  revisionMismatchHints?: boolean | 'prepare'
  /** 写操作前请求工作区授权。 */
  mutation?: { operation: string }
  /** search/list_files 风险预检。 */
  discoveryPreflight?: boolean | ((input: TInput) => Parameters<typeof buildDiscoveryPreflight>[1])
  /** prepare/amend/commit 编辑风险预检。 */
  editPreflight?: boolean | ((input: TInput) => Parameters<typeof buildEditPreflight>[1])
  /** apply 事务级风险预检（confirmRisk 为 true 时跳过）。 */
  transactionPreflight?: boolean
  /** 写路径进入 Workspace 模块自己的审批作用域。 */
  approval?: boolean
}

export interface DefineWorkspaceVelaToolOptions<
  TInput extends Record<string, any>,
> extends ToolContractDescriptionSpec {
  name: string
  category: ToolCategoryId
  schema: VelaTool<TInput>['schema']
  permissions: VelaTool<TInput>['permissions']
  capabilities?: VelaTool<TInput>['capabilities']
  hideWhenUnavailable?: VelaTool<TInput>['hideWhenUnavailable']
  isAvailable?: VelaTool<TInput>['isAvailable']
  isConcurrencySafe?: VelaTool<TInput>['isConcurrencySafe']
  surfaces?: Partial<Record<string, WorkspaceToolSurfaceOption<TInput>>>
  middleware?: WorkspaceToolMiddlewareConfig<TInput>
  execute: WorkspaceToolExecute<TInput>
}

function resolveErrorExtra<TInput extends Record<string, any>>(
  input: TInput,
  normalizeErrors: WorkspaceToolMiddlewareConfig<TInput>['normalizeErrors']
): Record<string, any> {
  if (isFalse(normalizeErrors) || !isPlainObject(normalizeErrors)) return {}
  return normalizeErrors.extra?.(input) ?? {}
}

function buildWorkspaceToolDescription<TInput extends Record<string, any>>(
  options: DefineWorkspaceVelaToolOptions<TInput>
): string {
  return buildToolContractDescription(options.name, options.category, options)
}

function buildWorkspaceToolSurfaces<TInput extends Record<string, any>>(
  options: DefineWorkspaceVelaToolOptions<TInput>
): VelaTool<TInput>['surfaces'] {
  if (!options.surfaces) return undefined

  return Object.fromEntries(
    Object.entries(options.surfaces).map(([profile, surface]) => {
      if (!surface) return [profile, surface]

      return [
        profile,
        {
          description: buildToolContractDescription(
            `${options.name}.${profile}`,
            options.category,
            {
              role: surface.role,
              summary: surface.summary,
              suitable: surface.suitable,
              forbidden: surface.forbidden,
              protocol: surface.protocol,
              usage: surface.usage,
              examples: surface.examples,
              notes: surface.notes,
            }
          ),
          schema: surface.schema,
          normalize: surface.normalize,
        },
      ]
    })
  ) as VelaTool<TInput>['surfaces']
}

function annotateWorkspaceExecutionResult(result: unknown, ctx: WorkspaceToolContext): unknown {
  if (!isPlainObject(result)) return result
  const sandbox = ctx.workspaceSandbox?.current
  if (!sandbox) return result
  const rootPath = ctx.workspace.getRootPath()

  return {
    ...result,
    executionRoot: result.executionRoot ?? rootPath,
    sourceRoot: result.sourceRoot ?? sandbox.sourceRoot,
    sandboxRoot: result.sandboxRoot ?? sandbox.root,
    sandboxId: result.sandboxId ?? sandbox.id,
    sandboxed: result.sandboxed ?? true,
  }
}

function applyRevisionHints(
  error: unknown,
  revisionMismatchHints: WorkspaceToolMiddlewareConfig<any>['revisionMismatchHints']
) {
  if (!revisionMismatchHints) return
  augmentRevisionMismatchMessage(error)
  if (revisionMismatchHints === 'prepare') augmentPrepareEditSnapshotHints(error)
}

/** 用声明式中间件链构建 VelaTool，统一 abort/目录/kernel/错误归一/审批。 */
export function defineWorkspaceVelaTool<TInput extends Record<string, any>>(
  options: DefineWorkspaceVelaToolOptions<TInput>
) {
  const middleware = options.middleware
  // role 必须随工具对象透出:ExecutionPolicy 的方案模式门禁按 descriptor.role==='inspect' 放行
  // 只读工具,漏带会让 ws_read/ws_search 等只读工具在方案模式被误拦(模型被迫盲写提案)。
  if (!middleware)
    return {
      description: buildWorkspaceToolDescription(options),
      schema: options.schema,
      role: options.role,
      permissions: options.permissions,
      capabilities: options.capabilities,
      hideWhenUnavailable: options.hideWhenUnavailable,
      isAvailable: options.isAvailable,
      isConcurrencySafe: options.isConcurrencySafe,
      surfaces: buildWorkspaceToolSurfaces(options),
      execute: options.execute as VelaTool<TInput>['execute'],
    }
  const useKernel = middleware?.kernel ?? true
  const normalizeErrors = middleware?.normalizeErrors ?? true

  const execute = async (input: TInput, ctx: WorkspaceToolContext): Promise<unknown> => {
    ctx.abortSignal.throwIfAborted()
    const annotate = (result: unknown) => annotateWorkspaceExecutionResult(result, ctx)

    if (middleware?.discoveryPreflight) {
      const preflightInput = isFunction(middleware.discoveryPreflight)
        ? middleware.discoveryPreflight(input)
        : (input as Parameters<typeof buildDiscoveryPreflight>[1])
      const preflight = buildDiscoveryPreflight(middleware.action, preflightInput)
      if (preflight) return annotate(preflight)
    }

    if (middleware?.editPreflight) {
      // editPreflight:true 表示整个工具输入即 edit-preflight 输入；input 已由工具 schema 校验，
      // 此处只做泛型 TInput → 具体 edit 输入的类型桥接（经 unknown 中介单次断言，非 as-unknown-as 跳板）。
      const editWidened: unknown = input
      const preflightInput = isFunction(middleware.editPreflight)
        ? middleware.editPreflight(input)
        : (editWidened as Parameters<typeof buildEditPreflight>[1])
      const preflight = buildEditPreflight(middleware.action, preflightInput)
      if (preflight) return annotate(preflight)
    }

    if (middleware?.mutation) {
      const denied = await prepareWorkspaceMutation(ctx, {
        cwd: (input as { cwd?: string }).cwd,
        operation: middleware.mutation.operation,
      })
      if (denied) return annotate(buildWorkspaceMutationSkippedResult(denied))
    }

    const runBody = async (): Promise<unknown> => {
      const kernel = useKernel ? await requireKernel(ctx) : await ctx.workspace.kernel()

      if (middleware?.transactionPreflight && !(input as { confirmRisk?: boolean }).confirmRisk) {
        const transactionId = (input as { transactionId?: string }).transactionId
        if (transactionId) {
          const advisories = transactionPreflightAdvisories(kernel.getTransaction(transactionId))
          if (!isEmpty(advisories))
            return annotate(buildModelPreflightResult(middleware.action, advisories))
        }
      }

      const run = () =>
        (options.execute as (run: WorkspaceToolRunContext<TInput>) => Promise<unknown>)({
          input,
          ctx,
          kernel,
        })

      if (middleware?.approval) return annotate(
          await ctx.workspace.runWithApproval(run)
        )
      return annotate(await run())
    }

    const runScoped = async (): Promise<unknown> => {
      if (middleware?.directory)
        return runWithDirectory(ctx, (input as { cwd?: string }).cwd, runBody)
      return runBody()
    }

    if (!middleware || isFalse(normalizeErrors)) {
      try {
        return annotate(await runScoped())
      } catch (error) {
        applyRevisionHints(error, middleware?.revisionMismatchHints)
        if (isFalse(normalizeErrors)) throw error
        return annotate(
          buildToolErrorResult(
            middleware?.action ?? 'workspace',
            error,
            resolveErrorExtra(input, middleware?.normalizeErrors)
          )
        )
      }
    }

    return annotate(
      await runWorkspaceTool(
        middleware.action,
        runScoped,
        resolveErrorExtra(input, middleware.normalizeErrors),
        optionalWhen(middleware.revisionMismatchHints === 'prepare', {
          beforeErrorReturn: augmentPrepareEditSnapshotHints,
        })
      )
    )
  }

  const description = buildWorkspaceToolDescription(options)
  const surfaces = buildWorkspaceToolSurfaces(options)

  return {
    description,
    schema: options.schema,
    role: options.role,
    permissions: options.permissions,
    capabilities: options.capabilities,
    hideWhenUnavailable: options.hideWhenUnavailable,
    isAvailable: options.isAvailable,
    isConcurrencySafe: options.isConcurrencySafe,
    surfaces,
    execute,
  }
}

export type { WorkspaceSearchExcludePreset }
