import type { ToolPermission } from '@velaros-ai/agent/protocol'
import {
  type ApprovalPort,
  defineToolRuntimeSpec,
  type DefineToolRuntimeSpecInput,
  type ToolContractRuntimeSpec,
} from '@velaros-ai/agent/tool-contract'

import { SystemToolCategoryByName, type SystemToolName } from './system-tool-names'
import type {
  SystemBackgroundTaskQueryOptions,
  SystemBackgroundTaskRecord,
  SystemBackgroundTaskTerminateRequest,
  SystemBackgroundTaskTerminateResult,
  SystemCommandResult,
  SystemGlobalSearchOptions,
  SystemGlobalSearchResult,
  SystemOpenApplicationOptions,
  SystemOpenApplicationResult,
  SystemOpenPathResult,
  SystemOpenPortInfo,
  SystemOpenPortQueryOptions,
  SystemProcessInfo,
  SystemProcessQueryOptions,
  SystemRevealPathResult,
  SystemRunCommandOptions,
  SystemShellEnvironmentRefreshResult,
} from './SystemContracts'

/**
 * 系统层能力契约(全仓唯一权威;app 的 SystemContextTypes.ts 以 extends 扩展宿主专属能力)。
 *
 * LocalSystemKernel implements 本接口；Electron 宿主专属能力（如通知和安装建议）
 * 放在 app 侧扩展，不进入通用 System 工具端口。
 * terminateBackgroundTask 用 Omit<…,'sessionId'> 是诚实契约:该 API 已绑定 session,
 * 适配层会覆盖调用方传入的 sessionId。
 */
export interface SystemToolSystemApi {
  /** 在系统范围搜索文件。 */
  globalSearch: (
    options: SystemGlobalSearchOptions,
    abortSignal?: AbortSignal
  ) => Promise<SystemGlobalSearchResult>
  /** 列出进程。 */
  listProcesses: (options?: SystemProcessQueryOptions) => Promise<SystemProcessInfo[]>
  /** 列出开放端口。 */
  listOpenPorts: (options?: SystemOpenPortQueryOptions) => Promise<SystemOpenPortInfo[]>
  /** 查询后台任务记录。 */
  listBackgroundTasks: (
    options?: SystemBackgroundTaskQueryOptions
  ) => Promise<SystemBackgroundTaskRecord[]>
  /** 终止当前会话可控制的后台任务。 */
  terminateBackgroundTask: (
    request: Omit<SystemBackgroundTaskTerminateRequest, 'sessionId'>
  ) => SystemBackgroundTaskTerminateResult | Promise<SystemBackgroundTaskTerminateResult>
  /** 刷新 shell 环境变量缓存。 */
  refreshShellEnvironment: () => Promise<SystemShellEnvironmentRefreshResult>
  /** 用系统默认方式打开路径。 */
  openPath: (path: string) => Promise<SystemOpenPathResult>
  /** 在文件管理器中定位路径。 */
  revealPath: (path: string) => Promise<SystemRevealPathResult>
  /** 打开指定应用。 */
  openApplication: (
    application: string,
    options?: SystemOpenApplicationOptions
  ) => Promise<SystemOpenApplicationResult>
  /** 在系统层运行命令，可能会进入后台任务管理。 */
  runCommand: (
    command: string,
    options?: SystemRunCommandOptions,
    allowDangerous?: boolean,
    abortSignal?: AbortSignal
  ) => Promise<SystemCommandResult>
  /** 当前平台是否支持刷新 shell 环境。 */
  canRefreshShellEnvironment: () => boolean
  /** 当前平台是否支持启动后台命令。 */
  canStartBackgroundCommands: () => boolean
}

export interface SystemToolContext {
  abortSignal: AbortSignal
  system: SystemToolSystemApi
  // 审批通道由宿主注入且始终存在；无人值守宿主应提供默认拒绝端口。
  // 需审批的敏感操作在没有交互执行通道时仍必须拒绝。
  approval: ApprovalPort
}

export type ToolContext = SystemToolContext

export type VelaTool<TInput extends Record<string, unknown> = Record<string, unknown>> =
  ToolContractRuntimeSpec<TInput, SystemToolContext, unknown, ToolPermission>

type DefineSystemToolInput<TInput extends Record<string, unknown>> = Omit<
  DefineToolRuntimeSpecInput<TInput, SystemToolContext, unknown, ToolPermission>,
  'category'
> & { name: SystemToolName }

export function defineSystemTool<TInput extends Record<string, unknown>>(
  input: DefineSystemToolInput<TInput>
): VelaTool<TInput> {
  return defineToolRuntimeSpec({
    ...input,
    category: SystemToolCategoryByName[input.name],
  })
}
