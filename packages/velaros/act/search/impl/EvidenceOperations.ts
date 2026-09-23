/**
 * 搜索会话里的来源检索与证据读取（`velaros:evidence`）：`EvidenceOperations` 与整个进程唯一的 `evidenceOperations`。
 * 接口 `EvidenceOperationsApi` 在本文件的类上方。两个操作补上缺省的条数与字节数，再交给调用上下文里本搜索会话的证据入口；授权、预算与上限由它核对。
 */

import { SearchLimits } from '../contract/constants.js'
import type { EvidenceOperationContext } from '../contract/requires.js'
import type {
  EvidenceCandidates,
  EvidenceQueryInput,
  EvidenceReadInput,
  SearchDraft,
  SearchEvidence,
  SearchReportReceipt,
} from '../types.js'

/**
 * @AgentView
 * 只在搜索会话里可用：在本轮授权的来源里按字面检索候选，再读真实资源、登记成不可变的证据，最后用 report 交付结论；都只能在 execute 里调用，检索与读取各自计入这次搜索的预算。
 * 收尾阶段不能再检索或读取，直接用已有证据 report。
 */
export interface EvidenceOperationsApi {
  /** @AgentView 在一个来源里按字面检索候选；source 用本轮实际授权的来源。
   * @OperationEffect none
   * @OperationModes execute
   */
  query(input: EvidenceQueryInput, ctx: EvidenceOperationContext): Promise<EvidenceCandidates>
  /** @AgentView 读一个资源并登记成证据：返回证据 id、原文引用与读到的版本。
   * @OperationEffect none
   * @OperationModes execute
   */
  read(input: EvidenceReadInput, ctx: EvidenceOperationContext): Promise<SearchEvidence>
  /** @AgentView 交付这次搜索的结论；受理之后声明完成。结论不合约定时报错，修正后再交。
   * @OperationEffect none
   * @OperationModes execute
   */
  report(input: SearchDraft, ctx: EvidenceOperationContext): Promise<SearchReportReceipt>
}

export class EvidenceOperations implements EvidenceOperationsApi {
  public async query(
    input: EvidenceQueryInput,
    ctx: EvidenceOperationContext
  ): Promise<EvidenceCandidates> {
    ctx.abortSignal.throwIfAborted()
    return ctx.activation.query(
      input.source,
      input.query,
      input.limit ?? SearchLimits.defaultCandidates,
      ctx.abortSignal
    )
  }

  public async read(
    input: EvidenceReadInput,
    ctx: EvidenceOperationContext
  ): Promise<SearchEvidence> {
    ctx.abortSignal.throwIfAborted()
    return ctx.activation.inspect(
      input.target,
      input.maxBytes ?? SearchLimits.defaultReadBytes,
      ctx.abortSignal
    )
  }

  public async report(
    input: SearchDraft,
    ctx: EvidenceOperationContext
  ): Promise<SearchReportReceipt> {
    ctx.abortSignal.throwIfAborted()
    return ctx.activation.report(input, ctx.abortSignal)
  }
}

/** 整个进程只有一份的证据操作；装配时把本搜索会话的证据入口塞进每次调用的上下文。 */
export const evidenceOperations: EvidenceOperationsApi = new EvidenceOperations()
