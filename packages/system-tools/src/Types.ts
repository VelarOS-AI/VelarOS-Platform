import {
  type ApprovalPort,
  defineToolRuntimeSpec,
  type DefineToolRuntimeSpecInput,
  type ToolContractRuntimeSpec,
} from '@velaros-ai/core/tool-contract'
import type {
  AgentDeveloperContext,
  ToolCategoryId,
  ToolExecutionApi,
  ToolPermission,
} from '@velaros-ai/core/types'

import type {
  SystemActiveProjectInference,
  SystemBackgroundTaskQueryOptions,
  SystemBackgroundTaskRecord,
  SystemBackgroundTaskTerminateRequest,
  SystemBackgroundTaskTerminateResult,
  SystemCommandResult,
  SystemCommandRunQueryOptions,
  SystemCommandRunRecord,
  SystemDevEnvironmentSummary,
  SystemDevEnvironmentSummaryOptions,
  SystemDevRuntimeDiagnosis,
  SystemDevRuntimeDiagnosisOptions,
  SystemDiscoveredProject,
  SystemEnvironmentInspection,
  SystemGlobalSearchOptions,
  SystemGlobalSearchResult,
  SystemMetricsSnapshot,
  SystemOpenApplicationOptions,
  SystemOpenApplicationResult,
  SystemOpenPathResult,
  SystemOpenPortInfo,
  SystemOpenPortQueryOptions,
  SystemOverview,
  SystemProcessInfo,
  SystemProcessProjectAssociation,
  SystemProcessProjectAssociationOptions,
  SystemProcessQueryOptions,
  SystemProjectContextOptions,
  SystemProjectContextSummary,
  SystemProjectDiscoveryOptions,
  SystemRecentLogEntry,
  SystemRecentLogQueryOptions,
  SystemRecentProjectEntry,
  SystemRevealPathResult,
  SystemRunCommandOptions,
  SystemShellEnvironmentRefreshResult,
  SystemToolInstallRequest,
  SystemToolInstallResult,
  SystemToolInstallSuggestion,
  SystemToolPromptHint,
} from './SystemContracts'

export interface SystemToolCodingSessionApi {
  enableToolCategories?: (categories: ToolCategoryId[], reason?: string) => ToolCategoryId[]
  getEnabledToolCategories?: () => ToolCategoryId[]
}

/**
 * 系统层能力契约(全仓唯一权威;app 的 SystemContextTypes.ts 以 extends 扩展宿主专属能力)。
 *
 * 注意:LocalSystemKernel(CLI)implements 本接口——给它加必选成员会 break CLI;
 * Electron 宿主专属能力(如 sendNotification)放 app 侧 ToolSystemApi extends,别塞回来。
 * terminateBackgroundTask 用 Omit<…,'sessionId'> 是诚实契约:该 API 已绑定 session,
 * 适配层会覆盖调用方传入的 sessionId。
 */
export interface SystemToolSystemApi {
  /** 获取系统总览，包括环境、工作区、进程等摘要。 */
  getOverview: () => SystemOverview
  /** 检查 shell、PATH、常用命令是否可用。 */
  inspectEnvironment: (commands?: string[]) => Promise<SystemEnvironmentInspection>
  /** 在系统范围搜索项目、文件或应用线索。 */
  globalSearch: (
    options: SystemGlobalSearchOptions,
    abortSignal?: AbortSignal
  ) => Promise<SystemGlobalSearchResult>
  /** 读取 CPU/内存等系统指标快照。 */
  getSystemMetrics: () => Promise<SystemMetricsSnapshot>
  /** 扫描本机可识别的项目目录。 */
  discoverProjects: (options?: SystemProjectDiscoveryOptions) => Promise<SystemDiscoveredProject[]>
  /** 列出最近使用的项目。 */
  listRecentProjects: (
    options?: SystemProjectDiscoveryOptions
  ) => Promise<SystemRecentProjectEntry[]>
  /** 根据窗口、进程、路径等信息推断当前活跃项目。 */
  inferActiveProject: (
    options?: SystemProjectDiscoveryOptions
  ) => Promise<SystemActiveProjectInference>
  /** 获取某个项目的结构化上下文摘要。 */
  getProjectContext: (
    options?: SystemProjectContextOptions
  ) => Promise<Nullable<SystemProjectContextSummary>>
  /** 读取最近系统日志。 */
  readRecentLogs: (options?: SystemRecentLogQueryOptions) => Promise<SystemRecentLogEntry[]>
  /** 将运行中进程和已发现项目做关联。 */
  associateProcessesWithProjects: (
    options?: SystemProcessProjectAssociationOptions
  ) => Promise<SystemProcessProjectAssociation[]>
  /** 汇总当前开发环境。 */
  summarizeCurrentDevEnvironment: (
    options?: SystemDevEnvironmentSummaryOptions
  ) => Promise<SystemDevEnvironmentSummary>
  /** 诊断开发运行时，例如包管理器、脚本和端口占用。 */
  diagnoseDevRuntime: (
    options?: SystemDevRuntimeDiagnosisOptions
  ) => Promise<SystemDevRuntimeDiagnosis>
  /** 列出进程。 */
  listProcesses: (options?: SystemProcessQueryOptions) => Promise<SystemProcessInfo[]>
  /** 列出开放端口。 */
  listOpenPorts: (options?: SystemOpenPortQueryOptions) => Promise<SystemOpenPortInfo[]>
  /** 查询历史命令执行记录。 */
  listCommandRuns: (options?: SystemCommandRunQueryOptions) => SystemCommandRunRecord[]
  /** 查询后台任务记录。 */
  listBackgroundTasks: (
    options?: SystemBackgroundTaskQueryOptions
  ) => Promise<SystemBackgroundTaskRecord[]>
  /** 终止当前会话可控制的后台任务。 */
  terminateBackgroundTask: (
    request: Omit<SystemBackgroundTaskTerminateRequest, 'sessionId'>
  ) => SystemBackgroundTaskTerminateResult
  /** 刷新 shell 环境变量缓存。 */
  refreshShellEnvironment: () => Promise<SystemShellEnvironmentRefreshResult>
  /** 获取系统工具安装/修复提示。 */
  getSystemToolPromptHints: () => Promise<SystemToolPromptHint[]>
  /** 根据命令和原因生成工具安装建议。 */
  createSystemToolInstallSuggestion: (input: {
    command: string
    reason: string
    scope: 'workspace' | 'system'
  }) => Nullable<SystemToolInstallSuggestion>
  /** 执行系统工具安装建议。 */
  installSystemTool: (request: SystemToolInstallRequest) => Promise<SystemToolInstallResult>
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
  developerContext?: LooseOptional<AgentDeveloperContext>
  hasWorkspaceRoot?: () => boolean
  codingSession?: SystemToolCodingSessionApi
  system: SystemToolSystemApi
  // 审批通道由宿主注入且始终存在；无人值守宿主应提供默认拒绝端口。
  // 需审批的敏感操作在没有交互执行通道时仍必须拒绝。
  approval: ApprovalPort
  execution: Nullable<ToolExecutionApi>
}

export type ToolContext = SystemToolContext

export type VelaTool<TInput extends Record<string, unknown> = Record<string, unknown>> =
  ToolContractRuntimeSpec<TInput, SystemToolContext, unknown, ToolPermission>

type DefineSystemToolInput<TInput extends Record<string, unknown>> = Omit<
  DefineToolRuntimeSpecInput<TInput, SystemToolContext, unknown, ToolPermission>,
  'category'
>

export function defineSystemTool<TInput extends Record<string, unknown>>(
  input: DefineSystemToolInput<TInput>
): VelaTool<TInput> {
  return defineToolRuntimeSpec({ ...input, category: 'system-control' })
}
