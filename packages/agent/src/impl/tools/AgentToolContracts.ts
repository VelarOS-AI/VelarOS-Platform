// 写工具时用得到、但没有搬进 @velaros-ai/tool-contract 的那几件：审批请求的构造与入参边界。
import { type z } from 'zod'

import type { ApprovalPort } from '../../contract/requires'
import type { ToolCatalogEntry, ToolConfirmationDecisionOptions } from '../../types/agent.js'
import type { ApprovalSession, BoundedReadInput, ManualApprovalOptions, RecursiveTraversalInput } from '../../types/toolkit'
import { createManualApprovalOptions } from '../../utils/toolkit/approval'
import { readToolSchemaDiscoveryNames,ToolContractDiscoveryDescriptors } from '../../utils/toolkit/discovery'
import { createApprovalOperationKey, createTaskApprovalPort } from '../../utils/toolkit/task-approval'
import { applyDefaultRecursiveMaxDepth, optionalReadEndLine, optionalReadMaxChars, optionalReadStartLine, refineBoundedReadInput, requiredNonNegativeMaxDepth, requiredPositiveMaxDepth, requiredResultLimit, withReadBoundJsonSchemaConstraints } from '../../utils/toolkit/tool-input-bounds'

/**
 * Agent 侧的工具契约补充件。
 *
 * 通用的工具定义、说明渲染、schema 打包、宽容入参、身份判定都在 `@velaros-ai/tool-contract`；
 * 留在这里的是跟 Agent 审批语义与读取类工具入参边界绑定的那几件。无状态，进程内共用一份。
 */
export interface AgentToolContractsApi {
  /** 两条自恢复工具的目录描述：随每份工具目录常驻，模型在 schema 漂移后还能靠它们找回路。 */
  readonly discoveryDescriptors: readonly ToolCatalogEntry[]
  /** 构造一次必须由用户亲自裁决、且永不复用历史答案的审批请求。 */
  createManualApprovalOptions(options?: ManualApprovalOptions): ToolConfirmationDecisionOptions
  /** 按动作种类与取值算一次审批的操作键（同键的答案才可复用）。 */
  createApprovalOperationKey(kind: string, value: unknown): string
  /** 把宿主的任务确认口包成工具执行链认识的审批端口。 */
  createTaskApprovalPort(delegate: ApprovalPort, session: ApprovalSession, policy: {
    shouldAutoApprove(options: ToolConfirmationDecisionOptions): boolean
    rejectionReason?(options: ToolConfirmationDecisionOptions): Nullable<string>
  }): ApprovalPort
  /** 结果条数上限的入参 schema：缺省按 max 兜底，超限钳到 max。 */
  requiredResultLimit(max: number, description: string): z.ZodDefault<z.ZodPipe<z.ZodNumber, z.ZodTransform<number, number>>>
  /** 正整数递归深度的入参 schema，超限钳制（至少进入一层）。 */
  requiredPositiveMaxDepth(max: number, description: string): z.ZodPipe<z.ZodNumber, z.ZodTransform<number, number>>
  /** 非负递归深度的入参 schema，超限钳制（0 表示只处理当前层）。 */
  requiredNonNegativeMaxDepth(max: number, description: string): z.ZodPipe<z.ZodNumber, z.ZodTransform<number, number>>
  /** 可选起始行的入参 schema（正整数）。 */
  optionalReadStartLine(description: string): z.ZodOptional<z.ZodNumber>
  /** 可选结束行的入参 schema（正整数）。 */
  optionalReadEndLine(description: string): z.ZodOptional<z.ZodNumber>
  /** 可选字符上限的入参 schema，超上限钳到 max 而不是拒绝。 */
  optionalReadMaxChars(max: number, description: string): z.ZodOptional<z.ZodPipe<z.ZodNumber, z.ZodTransform<number, number>>>
  /** 校验读取类工具的行号顺序；倒置时指向 endLine 报错。 */
  refineBoundedReadInput(value: BoundedReadInput, refinementContext: z.RefinementCtx): void
  /** recursive=true 但没给 maxDepth 时补一个有界的默认深度。 */
  applyDefaultRecursiveMaxDepth<T extends RecursiveTraversalInput>(value: T): T
  /** 给读取类工具的 JSON Schema 补上行号与字符上限的联合约束。 */
  withReadBoundJsonSchemaConstraints(value: unknown): unknown
  /** 从 schema 自恢复工具的入参里读出要查的工具名单（去重并截到上限）。 */
  readSchemaDiscoveryNames(input: Record<string, unknown>): string[]
}

/** 方法逐个转调 utils/toolkit 里的纯函数；这里只负责把它们收成一件对外能力。 */
class AgentToolContracts implements AgentToolContractsApi {
  public readonly discoveryDescriptors: readonly ToolCatalogEntry[] = ToolContractDiscoveryDescriptors

  public createManualApprovalOptions(options?: ManualApprovalOptions): ToolConfirmationDecisionOptions {
    return createManualApprovalOptions(options)
  }

  public createApprovalOperationKey(kind: string, value: unknown): string {
    return createApprovalOperationKey(kind, value)
  }

  public createTaskApprovalPort(delegate: ApprovalPort, session: ApprovalSession, policy: {
    shouldAutoApprove(options: ToolConfirmationDecisionOptions): boolean
    rejectionReason?(options: ToolConfirmationDecisionOptions): Nullable<string>
  }): ApprovalPort {
    return createTaskApprovalPort(delegate, session, policy)
  }

  public requiredResultLimit(max: number, description: string): z.ZodDefault<z.ZodPipe<z.ZodNumber, z.ZodTransform<number, number>>> {
    return requiredResultLimit(max, description)
  }

  public requiredPositiveMaxDepth(max: number, description: string): z.ZodPipe<z.ZodNumber, z.ZodTransform<number, number>> {
    return requiredPositiveMaxDepth(max, description)
  }

  public requiredNonNegativeMaxDepth(max: number, description: string): z.ZodPipe<z.ZodNumber, z.ZodTransform<number, number>> {
    return requiredNonNegativeMaxDepth(max, description)
  }

  public optionalReadStartLine(description: string): z.ZodOptional<z.ZodNumber> {
    return optionalReadStartLine(description)
  }

  public optionalReadEndLine(description: string): z.ZodOptional<z.ZodNumber> {
    return optionalReadEndLine(description)
  }

  public optionalReadMaxChars(max: number, description: string): z.ZodOptional<z.ZodPipe<z.ZodNumber, z.ZodTransform<number, number>>> {
    return optionalReadMaxChars(max, description)
  }

  public refineBoundedReadInput(value: BoundedReadInput, refinementContext: z.RefinementCtx): void {
    return refineBoundedReadInput(value, refinementContext)
  }

  public applyDefaultRecursiveMaxDepth<T extends RecursiveTraversalInput>(value: T): T {
    return applyDefaultRecursiveMaxDepth(value)
  }

  public withReadBoundJsonSchemaConstraints(value: unknown): unknown {
    return withReadBoundJsonSchemaConstraints(value)
  }

  public readSchemaDiscoveryNames(input: Record<string, unknown>): string[] {
    return readToolSchemaDiscoveryNames(input)
  }
}

/** Agent 侧的工具契约补充件（无状态，进程内共用一份）。 */
export const agentToolContracts: AgentToolContractsApi = new AgentToolContracts()
