// 门面：执行观测域（宪章 §11 可观测性重构 / §14 执行账本）。
// span 数据契约单源在 `@velaros-ai/agent/protocol`（本域装配件直引其门面，非本地再定义）；本域 = 录制器 +
// 旁账本写入器 + 树投影 + **生产侧 scope 端口/账本工厂**，并把契约随门面转出便于消费面一处引入。阶段 B
// 已接生产接线：SoloLoop runner 产 run/turn/model span、ToolExecutor 产 tool span（经可选 `spanRecorder`
// 端口，缺省 no-op）。阶段 C 片 1 补 model/tool span 富化 + `projectExecutionSpanDebug`（span 树 → get_debug
// 观测面投影，additive 重定向消费）；片 2 补子 Agent QueryLoop 独立顶层 run span 接线（run span 带
// agentName/dispatchSource 可辨识标注）；片 3 补 D3 prompt 审计侧信道（`prompt-audit.ts`，重内容独立文件、
// span 靠 fingerprint 关联、绝不进会话账本）+ 通用宿主 capability observation span。`turns` 整段迁
// span（退役面耦合 WS2）/ UI 执行时间线随片 4+ 接。
export type {
  CapabilitySpan,
  ExecutionSpan,
  ExecutionSpanCategory,
  ExecutionSpanMetrics,
  ExecutionSpanStatus,
  ModelSpan,
  PolicySpan,
  RunSpan,
  ToolSpan,
  TurnSpan,
} from '../../protocol'
export {
  CapabilitySpanSchema,
  emptyExecutionSpanMetrics,
  ExecutionSpanCategorySchema,
  ExecutionSpanMetricsSchema,
  ExecutionSpanSchema,
  ExecutionSpanStatusSchema,
  ModelSpanSchema,
  PolicySpanSchema,
  RunSpanSchema,
  ToolSpanSchema,
  TurnSpanSchema,
} from '../../protocol'
export {
  parseSpanLedgerText,
  readSpanLedgerFile,
  serializeSpanLine,
  SPAN_LEDGER_LINE_SEPARATOR,
  type SpanLedgerReadResult,
} from './execution-ledger-file'
export {
  type ExecutionSpanDebugCapability,
  type ExecutionSpanDebugPolicy,
  type ExecutionSpanDebugProjection,
  type ExecutionSpanDebugPromptAudit,
  type ExecutionSpanDebugRun,
  type ExecutionSpanDebugTool,
  type ExecutionSpanDebugTurn,
  projectExecutionSpanDebug,
} from './execution-span-debug'
export {
  type CapabilitySpanInput,
  type ExecutionCapabilitySpanRecorder,
  type ExecutionSpanScopeFactory,
  LedgerExecutionSpanScopeFactory,
  type LedgerExecutionSpanScopeFactoryDeps,
  type ModelSpanHandle,
  type ModelSpanOutcome,
  NOOP_TOOL_OPENER,
  type RunSpanScope,
  type ToolSpanHandle,
  type ToolSpanOpener,
  type ToolSpanOutcome,
  type TurnSpanScope,
} from './execution-span-scope'
export {
  buildExecutionSpanTree,
  type ExecutionSpanTree,
  type ExecutionSpanTreeNode,
  spanPathToRoot,
} from './execution-span-tree'
export {
  ExecutionSpanLedger,
  type SpanLedgerWarn,
} from './ExecutionSpanLedger'
export {
  type ExecutionSpanOutcome,
  ExecutionSpanRecorder,
  type ExecutionSpanRecorderDeps,
  type ExecutionSpanStart,
  OpenExecutionSpan,
} from './ExecutionSpanRecorder'
export {
  parsePromptAuditText,
  PromptAuditLedger,
  type PromptAuditReadResult,
  type PromptAuditRecord,
  readPromptAuditFile,
  serializePromptAuditLine,
} from './prompt-audit'
