import { isBlank, isEmpty, isPresent, truncate } from '@velaros-ai/core'

import type { DispatchDecision, DispatchSignature, FindingRecord, LedgerEntry, SubAgentTypeKey } from '../../types/delegation.js'
import { hashText, normalizeText } from '../../utils/delegation/sub-agent-progress-ledger'
import { AgentTuning } from '../../utils/tuning'

/**
 * 子智能体派发进展账本（按执行隔离）。
 *
 * 同时承载两件事：
 * - A 无进展熔断：记录每次派发的 (类型 + 提示词指纹 + 目标键)，据此判定本次该放行、
 *   软提醒还是硬拦截，遏制「改→不够→查→反复横跳」的编排级活锁。
 * - B 发现复用：留存每个子智能体的产出摘要，下一次派发时注入指令前缀，避免被重新
 *   派发的 explore/edit 从零重探（弥补移除黑板后的跨派发信息断层）。
 *
 * 纯内存、无副作用、可独立单测；生命周期与 dispatchCountByExecution 对齐，由 clear() 回收。
 */
export interface SubAgentProgressLedgerApi {
  /**
   * 把一次派发的原始入参压成归一化指纹（类型 + 提示词指纹 + 目标键），后续判重全看它。
   *
   * 提示词先小写、折空白再散列，所以排版不同、语义相同的两次派发命中同一指纹；
   * 有 description 时用它做目标键（同一个目标换不同角度也能认出来），没有就退回提示词。
   */
  buildSignature(
    type: SubAgentTypeKey,
    prompt: string,
    description: LooseOptional<string>
  ): DispatchSignature
  /**
   * 判这次该不该派：`run` 放行、`soft-nudge` 放行但附一句收口提醒、`hard-stop` 拒派并退回引导文案。
   *
   * **只判不记**（记账走 `recordDispatch`），所以可以先问再决定。
   * 同一 (类型 + 提示词) 攒到上限 = 纯重复，硬拦；同一目标往返到阈值且换过 ≥2 种子 Agent 类型 = 典型横跳，软提醒。
   */
  evaluate(executionKey: string, signature: DispatchSignature): DispatchDecision
  /** 记一次「确定要跑」的派发；条目超上限时从最早的开始丢（只是内存兜底，远大于派发硬上限）。 */
  recordDispatch(executionKey: string, signature: DispatchSignature): void
  /**
   * 子 Agent 收尾后留一条发现摘要（标题截断到 80 字、正文 480 字，每次执行只留最近 8 条）。
   *
   * 摘要空白时不记。留它是为了下一次派发能把「前面已经查到什么」带给新 worker。
   */
  recordFinding(
    executionKey: string,
    finding: { type: SubAgentTypeKey; title: string; summary: string }
  ): void
  /**
   * 把本次执行已留存的发现拼成一段「已知上下文」前缀，注入新派 worker 的指令；一条发现都没有时返回 null。
   *
   * 只给**新派**的 worker——续跑的 worker 自己的历史里已经有这些了，再塞一遍是纯浪费。
   */
  buildPriorFindingsBriefing(executionKey: string): Nullable<string>
  /** 回收某次执行的两本账（派发记录 + 发现摘要）；顶层执行收尾时调，避免跨执行串味与无界增长。 */
  clear(executionKey: string): void
}

class SubAgentProgressLedger implements SubAgentProgressLedgerApi {
  /** 单条发现的最大字符数。 */
  private static readonly SubAgentFindingsMaxCharsEach = AgentTuning.delegation.findingsMaxCharsEach
  /** 每次执行最多留几条发现。 */
  private static readonly SubAgentFindingsMaxRecords = AgentTuning.delegation.findingsMaxRecords
  /** 同一条任务描述最多重复派发几次。 */
  private static readonly SubAgentMaxIdenticalDispatches = AgentTuning.delegation.maxIdenticalDispatches
  /** 针对同一个目标最多跑几轮。 */
  private static readonly SubAgentMaxRoundsPerTarget = AgentTuning.delegation.maxRoundsPerTarget
  /** 账本条目上限（远大于派发硬上限，仅作内存安全兜底）。 */
  private static readonly MaxLedgerEntries = AgentTuning.delegation.maxLedgerEntries

  private readonly dispatches = new Map<string, LedgerEntry[]>()
  private readonly findings = new Map<string, FindingRecord[]>()

  /** 根据原始入参构造归一化指纹。 */
  public buildSignature(
    type: SubAgentTypeKey,
    prompt: string,
    description: LooseOptional<string>
  ): DispatchSignature {
    const normalizedPrompt = normalizeText(prompt)
    const trimmedDescription = description?.trim()
    const targetSource = isPresent(trimmedDescription) && !isBlank(trimmedDescription)
      ? `d:${hashText(normalizeText(trimmedDescription))}`
      : `p:${hashText(normalizedPrompt)}`
    return {
      type,
      promptFingerprint: `${type}:${hashText(normalizedPrompt)}`,
      targetKey: targetSource,
    }
  }

  /**
   * 判定本次派发。不修改状态（记账由 recordDispatch 显式完成）。
   * - hard-stop：同一 (类型+prompt) 已达上限次——纯冗余重复，拒跑并退回引导。
   * - soft-nudge：同一目标往返达阈值且出现过 ≥2 种类型（典型 explore↔edit 横跳）——放行但提醒收口。
   */
  public evaluate(executionKey: string, signature: DispatchSignature): DispatchDecision {
    const entries = this.dispatches.get(executionKey) ?? []

    const identicalCount = entries.filter(
      (entry) => entry.promptFingerprint === signature.promptFingerprint
    ).length
    if (identicalCount + 1 >= SubAgentProgressLedger.SubAgentMaxIdenticalDispatches) return {
        kind: 'hard-stop',
        note: `已就几乎相同的子任务（类型 ${signature.type}）派发 ${identicalCount} 次，未见新进展。请不要再重复派发，改为综合现有信息自行完成，或换一个明显不同的拆分角度。`,
      }

    const targetEntries = entries.filter((entry) => entry.targetKey === signature.targetKey)
    const typesOnTarget = new Set<SubAgentTypeKey>(targetEntries.map((entry) => entry.type))
    typesOnTarget.add(signature.type)
    if (targetEntries.length + 1 >= SubAgentProgressLedger.SubAgentMaxRoundsPerTarget && typesOnTarget.size >= 2) return {
        kind: 'soft-nudge',
        note: `提示：该目标已在多个子智能体之间往返 ${targetEntries.length + 1} 次（含 ${[...typesOnTarget].join('/')}）。若仍未收敛，请停止继续派发、综合已有发现自行收口，避免反复横跳空耗。`,
      }

    return { kind: 'run', note: null }
  }

  /** 记录一次"将真正运行"的派发。 */
  public recordDispatch(executionKey: string, signature: DispatchSignature): void {
    const entries = this.dispatches.get(executionKey) ?? []
    entries.push({
      type: signature.type,
      promptFingerprint: signature.promptFingerprint,
      targetKey: signature.targetKey,
    })
    if (entries.length > SubAgentProgressLedger.MaxLedgerEntries) {
      entries.splice(0, entries.length - SubAgentProgressLedger.MaxLedgerEntries)
    }
    this.dispatches.set(executionKey, entries)
  }

  /** 子智能体完成后留存一条发现摘要（截断 + 仅保留最近若干条）。 */
  public recordFinding(
    executionKey: string,
    finding: { type: SubAgentTypeKey; title: string; summary: string }
  ): void {
    const summary = finding.summary.trim()
    if (isBlank(summary)) return
    const records = this.findings.get(executionKey) ?? []
    records.push({
      type: finding.type,
      title: truncate(finding.title.trim(), 80),
      summary: truncate(summary, SubAgentProgressLedger.SubAgentFindingsMaxCharsEach),
    })
    if (records.length > SubAgentProgressLedger.SubAgentFindingsMaxRecords) {
      records.splice(0, records.length - SubAgentProgressLedger.SubAgentFindingsMaxRecords)
    }
    this.findings.set(executionKey, records)
  }

  /** 构造注入子智能体指令的「已知发现」前缀；无可用发现时返回 null。 */
  public buildPriorFindingsBriefing(executionKey: string): Nullable<string> {
    const records = this.findings.get(executionKey) ?? []
    if (isEmpty(records)) return null
    const lines = records.map(
      (record) => `- [${record.type}] ${record.title}：${record.summary}`
    )
    return [
      '【已知上下文（来自本次执行先前子任务，避免重复探索）】',
      ...lines,
      '（以上为先前子智能体的产出摘要；请在此基础上推进，不要从零重复已完成的探索/改动。）',
    ].join('\n')
  }

  /** 回收某次执行的账本，避免跨执行串味与无界增长。 */
  public clear(executionKey: string): void {
    this.dispatches.delete(executionKey)
    this.findings.delete(executionKey)
  }
}

export { SubAgentProgressLedger }
