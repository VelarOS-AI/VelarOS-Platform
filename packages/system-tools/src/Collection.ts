import { structureToolDescriptionsForCategory } from '@velaros-ai/core/utils/ToolDescription'

import { systemOverviewTools } from './Overview.tool'
import { systemPrimitiveTools } from './Primitive.tool'
import { systemProjectDiscoveryTools } from './ProjectDiscovery.tool'
import { systemProjectRuntimeTools } from './ProjectRuntime.tool'
import { systemRuntimeTools } from './Runtime.tool'

const systemProjectExtensionTools = {
  discover_projects: systemProjectDiscoveryTools.discover_projects,
  list_recent_projects: systemProjectDiscoveryTools.list_recent_projects,
  infer_active_project: systemProjectDiscoveryTools.infer_active_project,
  get_project_context: systemProjectDiscoveryTools.get_project_context,
  associate_processes_with_projects: systemProjectRuntimeTools.associate_processes_with_projects,
  summarize_current_dev_environment: systemProjectRuntimeTools.summarize_current_dev_environment,
  diagnose_dev_runtime: systemProjectRuntimeTools.diagnose_dev_runtime,
}

/**
 * 默认系统控制工具集合。
 *
 * 默认模型工具面收敛为少量正交基础工具。高层项目发现、运行时诊断留在
 * 扩展工具面单独启用；旧原子工具名已经退出注册面。
 *
 * 注意：系统控制里的 shell 基础工具为兼容旧契约仍命名 bash，但会按宿主选择
 * cmd.exe 或 POSIX shell；项目工作区命令使用 ws_run_command。
 */
const rawSystemTools = {
  ...systemPrimitiveTools,
  get_system_overview: systemOverviewTools.get_system_overview,
  refresh_shell_environment: systemRuntimeTools.refresh_shell_environment,
  list_background_tasks: systemRuntimeTools.list_background_tasks,
  terminate_background_task: systemRuntimeTools.terminate_background_task,
}

const rawSystemExtensionTools = {
  ...systemOverviewTools,
  ...systemProjectExtensionTools,
  ...systemRuntimeTools,
}

export const systemTools = structureToolDescriptionsForCategory(rawSystemTools, 'system-control')
// 项目发现 + 开发现场诊断工具：作为 loadable 接入 system-control（默认面只放正交基础工具，
// 这组按需 page-in），让模型在系统空间能发现/理解本机项目，而不只是列已登记的 root。
export const systemProjectTools = structureToolDescriptionsForCategory(
  systemProjectExtensionTools,
  'system-control'
)
export const systemExtensionTools = structureToolDescriptionsForCategory(
  rawSystemExtensionTools,
  'system-control'
)
