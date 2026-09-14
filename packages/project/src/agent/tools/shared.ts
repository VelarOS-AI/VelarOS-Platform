import type { ToolCategoryId } from '@velaros-ai/agent/protocol'
import { defineToolRuntimeSpec, resolveToolInputReuse, withToolInputReuse } from '@velaros-ai/agent/tool-contract'

import { migrateProjectReusedInput, ProjectInputContractVersion, projectInputReuseSourceTools } from '../../compatibility/input-migration'
import { runWithProjectExecutionGate } from '../ProjectExecutionGate'
import type { ProjectToolApi, ProjectToolContext, VelaTool } from '../Types'

export type ProjectToolCollection = Readonly<Record<string, VelaTool<any>>>

export function defineProjectTool<TInput extends Record<string, any>>(input: {
  name: string
  inputContractVersion?: number
  category: ToolCategoryId
  role: 'inspect' | 'edit' | 'execute'
  summary: string
  suitable?: readonly [string, ...string[]]
  forbidden?: readonly [string, ...string[]]
  protocol?: readonly [string, ...string[]]
  usage?: readonly [string, ...string[]]
  examples: readonly [Record<string, unknown>, ...Array<Record<string, unknown>>]
  notes?: readonly [string, ...string[]]
  schema: VelaTool<TInput>['schema']
  permissions: VelaTool<TInput>['permissions']
  capabilities?: VelaTool<TInput>['capabilities']
  exposure?: VelaTool<TInput>['exposure']
  hideWhenUnavailable?: VelaTool<TInput>['hideWhenUnavailable']
  isAvailable?: VelaTool<TInput>['isAvailable']
  isConcurrencySafe?: VelaTool<TInput>['isConcurrencySafe']
  execute: VelaTool<TInput>['execute']
}): VelaTool<any> {
  const {
    name,
    category,
    role,
    summary,
    suitable,
    forbidden,
    protocol,
    usage,
    examples,
    notes,
    ...tool
  } = input
  const inputContractVersion = input.inputContractVersion ?? ProjectInputContractVersion
  const inputReuseSourceTools = inputContractVersion === 2 ? projectInputReuseSourceTools(name) : undefined
  const migrateReusedInput = inputContractVersion === 2 && inputReuseSourceTools
    ? (request: Parameters<typeof migrateProjectReusedInput>[1], context: ProjectToolContext) => migrateProjectReusedInput(name, request, context)
    : undefined
  const defined = defineToolRuntimeSpec({
    name,
    category,
    role,
    summary,
    suitable: suitable ?? ['需要完成该工具职责所描述的项目操作。'],
    forbidden: forbidden ?? ['目标不属于当前项目边界。'],
    protocol: protocol ?? ['只使用当前项目上下文解析路径和执行操作。'],
    usage: usage ?? ['参数必须来自当前请求或前序工具结果。'],
    examples,
    notes: notes ?? ['返回值是当前操作的权威结果。'],
    ...tool,
    inputContractVersion, inputReuseSourceTools, migrateReusedInput,
  })
  const execute = (args: Record<string, unknown>, context: ProjectToolContext) => {
    const run = async () =>
      tool.execute(tool.schema.parse(await resolveToolInputReuse(context, name, args, context.toolCallId, {
        inputContractVersion, inputReuseSourceTools,
        migrateReusedInput: migrateReusedInput ? (request) => migrateReusedInput(request, context) : undefined,
      })), context)
    // 后台命令的进程生命周期由宿主 job manager 管理，不能将启动回执当作任务结束。
    if (role !== 'inspect') return run()
    return runWithProjectExecutionGate(
      context.project.getRootPath(),
      false,
      context.abortSignal,
      run
    )
  }
  if (role !== 'edit')
    return Object.freeze({ ...defined, execute })
  return Object.freeze({ ...defined, schema: withToolInputReuse(tool.schema), execute })
}

export function runInProjectDirectory<T>(
  context: { project: Pick<ProjectToolApi, 'runInDirectory'> },
  cwd: LooseOptional<string>,
  action: () => Promise<T>
): Promise<T> {
  return cwd ? context.project.runInDirectory(cwd, action) : action()
}

/**
 * Agent callers naturally express include/exclude globs relative to the directory being listed.
 * The Project kernel intentionally matches portable project-root-relative paths. Accept both forms
 * at the Agent boundary so `path: "scripts/build", include: ["*.mjs"]` does not silently return an
 * empty list while callers that already provide `scripts/build/*.mjs` retain identical behavior.
 */
export function scopeProjectListPatterns(
  path: LooseOptional<string>,
  patterns: LooseOptional<readonly string[]>
): Optional<string[]> {
  if (!patterns) return undefined
  const base = path?.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!base || base === '.' || base.startsWith('/') || /^[a-zA-Z]:\//.test(base))
    return [...patterns]
  return patterns.map((pattern) => {
    const portable = pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '')
    if (
      !portable ||
      portable.startsWith('/') ||
      portable === base ||
      portable.startsWith(`${base}/`)
    )
      return portable
    return `${base}/${portable}`
  })
}

