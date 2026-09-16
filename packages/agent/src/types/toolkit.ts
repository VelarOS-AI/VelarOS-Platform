/**
 * 工具契约的形状：本体在 `@velaros-ai/tool-contract`，这里按名转发，agent 自己与 `./tool-contract` 入口继续按原名引用。
 * 只有审批与有界读那几样留在本包：它们的签名闭包连着 agent 的确认卡与执行记录，不属于工具契约。
 */

import type { z } from 'zod'

import type { ToolConfirmationDecisionOptions } from './agent.js'
import type { ToolCodingSessionApi } from './tool-context.js'

// ── 工具契约本体：形状在 @velaros-ai/tool-contract，这里只转发名字 ──────────
export type {
  AppliedAdjustment,
  CreateToolSchemaBundleOptions,
  DefineToolContractInput,
  DefineToolContractSurfaceInput,
  DefineToolRuntimeSpecInput,
  NonEmptyDescriptionItems,
  NonEmptyToolContractList,
  StructuredParameterDescriptionSpec,
  StructuredToolDescriptionParts,
  StructuredToolDescriptionSpec,
  ToolCallableOperationsOptions,
  ToolCapabilityService,
  ToolConceptRegistry,
  ToolContextResolver,
  ToolContractDescriptionSpec,
  ToolContractExecute,
  ToolContractRole,
  ToolContractRuntimeSpec,
  ToolContractSpec,
  ToolContractSurface,
  ToolDefiner,
  ToolDefinerOptions,
  ToolDescriptionBudgetWaiver,
  ToolDescriptionBudgetWaiverReason,
  ToolDescriptionLike,
  ToolInputReuseContract,
  ToolInputReuseMigrationRequest,
  ToolKernelModuleOptions,
  ToolReadOnlyClassification,
  ToolSchemaBundle,
  ToolSchemaSource,
} from '@velaros-ai/tool-contract'

/** 一次必须由用户亲自裁决的审批请求可以填的东西：手动确认与是否记住风险分类两格由构造器补。 */
export type ManualApprovalOptions = Omit<
  ToolConfirmationDecisionOptions,
  'requireManualApproval' | 'rememberRiskScope'
>

/**
 * 无人值守审批升级的生命周期钩子：升级挂起 / 升级返回。
 *
 * 供宿主把「子 Agent 正等父线程裁决高风险操作」投影成 UI 状态（如 worker 线程状态卡）；
 * 端口本体不承载任何宿主文案，钩子只回传原始 message，格式化归宿主。
 */
export interface UnattendedApprovalEscalationHooks {
  onEscalationPending?: (message: string) => void
  onEscalationResolved?: () => void
}

/**
 * 工具描述详细程度（渐进式披露 / progressive disclosure）。
 * - full：保留作者写下的全部条目。
 * - compact：保留结构与每个分节的首条要点，作为 tier-1 精简描述，降低 token 成本。
 */
export type ToolDescriptionDetail = 'full' | 'compact'

/** 审批端口要用到的那几格会话事实：确认卡记账、任务审批记录、会话内已确认的风险分类。 */
export type ApprovalSession = Pick<ToolCodingSessionApi,
  'recordConfirmationCard' | 'recordTaskApproval' | 'getTaskApprovalDenial' |
  'hasConfirmedRiskScope' | 'grantConfirmedRiskScope'>

/** 带上界的文件读取输入。 */
export interface BoundedReadInput {
  /** 可选起始行。 */
  startLine?: number
  /** 读取结束行。 */
  endLine?: number
  /** 读取字符上限。 */
  maxChars?: number
}

/** 递归目录遍历输入。 */
export interface RecursiveTraversalInput {
  /** 是否递归进入子目录。 */
  recursive?: boolean
  /** 递归最大深度。 */
  maxDepth?: number
}

/** 一份 JSON Schema 对象。 */
export type JsonSchemaObject = Record<string, unknown>

/** 能包装成内核操作的工具要有的那几样；只给包内的内核挂载用。 */
export interface CallableToolSpec<TContext> {
  name?: string
  schema: z.ZodType
  permissions: readonly string[]
  capabilities?: { reason?: string }
  isAvailable?: (context: TContext) => boolean
  execute: (input: Record<string, unknown>, context: TContext) => unknown
}
