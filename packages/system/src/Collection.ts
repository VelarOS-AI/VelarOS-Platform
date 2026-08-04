import { structureToolDescriptionsForCategory } from '@velaros-ai/agent/tool-contract'

import { systemPrimitiveTools } from './Primitive.tool'
import { systemRuntimeTools } from './Runtime.tool'
import { SystemToolNames } from './system-tool-names'

const systemFileTools = structureToolDescriptionsForCategory({
  [SystemToolNames.read]: systemPrimitiveTools[SystemToolNames.read],
  [SystemToolNames.write]: systemPrimitiveTools[SystemToolNames.write],
  [SystemToolNames.edit]: systemPrimitiveTools[SystemToolNames.edit],
  [SystemToolNames.list]: systemPrimitiveTools[SystemToolNames.list],
  [SystemToolNames.search]: systemPrimitiveTools[SystemToolNames.search],
}, 'system-files')

const systemExecutionTools = structureToolDescriptionsForCategory({
  [SystemToolNames.run]: systemPrimitiveTools[SystemToolNames.run],
  [SystemToolNames.refreshEnvironment]: systemRuntimeTools[SystemToolNames.refreshEnvironment],
}, 'system-execution')

const systemProcessTools = structureToolDescriptionsForCategory({
  [SystemToolNames.processes]: systemPrimitiveTools[SystemToolNames.processes],
  [SystemToolNames.listTasks]: systemRuntimeTools[SystemToolNames.listTasks],
  [SystemToolNames.terminateTask]: systemRuntimeTools[SystemToolNames.terminateTask],
}, 'system-processes')

const systemDesktopTools = structureToolDescriptionsForCategory({
  [SystemToolNames.open]: systemPrimitiveTools[SystemToolNames.open],
}, 'system-desktop')

const systemTools = Object.freeze({
  ...systemFileTools,
  ...systemExecutionTools,
  ...systemProcessTools,
  ...systemDesktopTools,
})

export {
  systemDesktopTools,
  systemExecutionTools,
  systemFileTools,
  systemProcessTools,
  systemTools,
}
