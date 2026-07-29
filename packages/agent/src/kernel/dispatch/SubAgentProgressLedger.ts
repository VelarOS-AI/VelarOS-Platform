import { isBlank, isEmpty,isPresent, truncate } from '@velaros-ai/core'

const SubAgentFindingsMaxCharsEach = 480
const SubAgentFindingsMaxRecords = 8
const SubAgentMaxIdenticalDispatches = 3
const SubAgentMaxRoundsPerTarget = 4

/** 类型键：内置类型名或自定义 agent id。 */
type SubAgentTypeKey = string

/** 一次派发的归一化指纹，用于"无进展"判定与目标分组。 */
interface DispatchSignature {
  type: SubAgentTypeKey
  /** 归一化提示词指纹（type:hash），用于硬拦截「完全冗余的重复派发」。 */
  promptFingerprint: string
  /** 目标归一化键（description 优先，否则归一化提示词），用于探测同目标反复横跳。 */
  targetKey: string
}

/** 派发判定：直接放行 / 放行但追加收口提醒 / 直接拒跑。 */
type DispatchDecision =
  | { kind: 'run'; note: null }
  | { kind: 'soft-nudge'; note: string }
  | { kind: 'hard-stop'; note: string }

interface LedgerEntry {
  type: SubAgentTypeKey
  promptFingerprint: string
  targetKey: string
}

interface FindingRecord {
  type: SubAgentTypeKey
  title: string
  summary: string
}

/** 账本条目上限（远大于派发硬上限 16，仅作内存安全兜底）。 */
const MaxLedgerEntries = 32

/** 归一化文本：小写 + 折叠空白 + 去首尾，使「语义相同、排版不同」的提示词命中同一指纹。 */
function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** djb2 字符串散列，仅用于把长提示词压成紧凑、稳定的指纹键（非加密用途）。 */
function hashText(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

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
class SubAgentProgressLedger {
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
    if (identicalCount + 1 >= SubAgentMaxIdenticalDispatches) return {
        kind: 'hard-stop',
        note: `已就几乎相同的子任务（类型 ${signature.type}）派发 ${identicalCount} 次，未见新进展。请不要再重复派发，改为综合现有信息自行完成，或换一个明显不同的拆分角度。`,
      }

    const targetEntries = entries.filter((entry) => entry.targetKey === signature.targetKey)
    const typesOnTarget = new Set<SubAgentTypeKey>(targetEntries.map((entry) => entry.type))
    typesOnTarget.add(signature.type)
    if (targetEntries.length + 1 >= SubAgentMaxRoundsPerTarget && typesOnTarget.size >= 2) return {
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
    if (entries.length > MaxLedgerEntries) {
      entries.splice(0, entries.length - MaxLedgerEntries)
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
      summary: truncate(summary, SubAgentFindingsMaxCharsEach),
    })
    if (records.length > SubAgentFindingsMaxRecords) {
      records.splice(0, records.length - SubAgentFindingsMaxRecords)
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
export type { DispatchDecision, DispatchSignature }
