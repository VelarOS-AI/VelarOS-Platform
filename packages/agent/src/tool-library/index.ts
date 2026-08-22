// tool-library：host 无关的 generic 工具库顶域（核心面契约 + 工具定义入口 + generic 工具集合）。
// 可被 web 桥 / serve / 任意 host 消费；不 import 或解释任何具体能力包。

export * from './builtin/ActiveDirectives'
export * from './builtin/ActiveDirectives.tool'
// agentWorkflowSchema：check-schemas.mjs 契约门消费的权威 schema（agent:run_workflow）。
export { agentWorkflowSchema } from './builtin/AgentWorkflow'
export * from './builtin/AgentWorkflow.tool'
export * from './builtin/BackgroundJobs.tool'
export * from './builtin/Categories.tool'
export * from './builtin/ContextDistill.tool'
export * from './builtin/ContextHandoff.tool'
export * from './builtin/ContextRetrieval.tool'
export * from './builtin/DispatchAgent.tool'
export * from './builtin/Goals.tool'
export * from './builtin/Plans.tool'
export * from './defineVelaTool'
export * from './KernelToolContext'
export * from './network/FetchSafety'
