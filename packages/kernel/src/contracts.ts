// 门面：`@velaros-ai/kernel/contracts` —— 可移植的契约数据与常量表。
//
// 这条入口不含任何实现，也不碰 Node 模块：渲染进程、浏览器打包、跨进程的 wire 数据都只认它。
// 需要值（造内核、写模块、起守护进程）的从根入口 `@velaros-ai/kernel` 取。
export * from './contract/constants'
export type {
  ApprovalDecision,
  ConfirmationRequestDetail,
  ManualApprovalOptions,
  TaskApprovalRecord,
  ToolApprovalRiskLevel,
  ToolConfirmationDecisionOptions,
  UserActionCard,
  UserActionCardAcknowledgeAction,
  UserActionCardAction,
  UserActionCardActionIcon,
  UserActionCardEnablePromptFeaturesAction,
  UserActionCardIcon,
  UserActionCardRejectAction,
  UserActionCardSubmitFormAction,
  UserActionCardSubmitInputAction,
  UserActionCardTextInput,
  UserActionCardTone,
  UserActionForm,
  UserActionFormField,
  UserActionFormFieldType,
  UserActionFormOption,
  UserActionFormValue,
} from './types/approval.js'
export type * from './types/kernel.js'
export type {
  ModelContextStatus,
  ModelContinuation,
  ModelDriverLimits,
  ModelHistoryMessage,
  ModelImage,
  ModelInputEstimate,
  ModelMaterial,
  ModelResponseFormat,
  ModelTurnDelta,
  ModelTurnRequest,
  ModelUserMessage,
} from './types/model.js'
export type {
  InvocationReceipt,
  InvocationRecord,
  ModuleBinding,
  ModuleCard,
  ModuleDescription,
  ModulePage,
  ModuleQuery,
  OperationCall,
  OperationDescriptor,
  OperationSchema,
  OperationSurface,
  PreparedInvocation,
} from './types/operations.js'
export type { InvocationReconciliation } from './types/operations.js'
export type { OperationRuntimeCloseOptions, PendingInvocation } from './types/operations.js'
