import type { ContextRef } from '@velaros-ai/context'
import type { ModelHistoryMessage } from '@velaros-ai/kernel'

import type { VolumeNarrative } from '../../system/types/history.js'

/** 段内一条冻结的历史：第一次随已接受的帧送达时实际发送的正文，同一段后续帧逐字复用。 */
export interface SegmentEntry {
  /** 原始记录的引用 id。 */
  readonly ref: string
  readonly sequence: number
  readonly role: 'user' | 'assistant'
  /** 冻结正文所在的存储对象。 */
  readonly objectId: string
  readonly chars: number
}

/** 为什么开始新的一段或重建底座。 */
export type SegmentReason =
  'start' | 'runway' | 'boundary' | 'organize' | 'provider' | 'overflow' | 'renew' | 'rebase'

/** 当前段：底座、延续的结果与冻结条目；封段时整体换新，重建底座只换底座。 */
export interface ContextSegment {
  readonly id: string
  /** 段号，每个授权代次从 1 开始。 */
  readonly index: number
  /** 底座重建次数；变化时请求前缀从底座起失效。 */
  readonly revision: number
  /** 序号大于它的记录属于本段历史。 */
  readonly from: number
  /** 渲染好的底座正文。 */
  readonly base: { readonly objectId: string; readonly chars: number }
  /** 切点之前产生、租约仍有效的结果，作为本段最前面的历史条目。 */
  readonly carried: readonly string[]
  /** 底座笔记快照：段起点的全部驻留笔记；shown 表示底座列了卡片，bodyIncluded 表示卡片带正文。 */
  readonly notes: ReadonlyArray<{
    readonly key: string
    readonly revision: number
    readonly ref: string
    readonly shown: boolean
    readonly bodyIncluded: boolean
  }>
  readonly entries: readonly SegmentEntry[]
  /** 段起点时计划里的下一目标，用于判断章节边界。 */
  readonly objective: string
  /** 段起点时已有的任务目标数，用于判断段内是否来了新的用户输入。 */
  readonly goals: number
  /** 渲染底座时生效的投影策略记录；策略换了就重建底座。 */
  readonly policy: Nullable<string>
  /** 底座目录里的卷数。 */
  readonly volumes: number
  readonly reason: SegmentReason
  /** 自动封成、只有骨架的上一卷：那一段做了很多事却没改笔记和计划，等整理支线在下一个请求边界补写叙事。 */
  readonly narrate: Nullable<ContextRef>
  /** 本段笔记的份额上限，封段时按上一段的缺页调整；旧的段记录没有这一项，按宿主配置。 */
  readonly workspaceShare?: number
}

/** 主循环看到的段状态：据此判断增长是否可比、封段是否发生。 */
export interface SegmentStatus {
  readonly id: string
  readonly index: number
  readonly revision: number
  readonly volumes: number
  /** 段内已有的模型响应数。 */
  readonly turns: number
  /** 本段读回上一帧因容量不够只给了引用的材料的次数。 */
  readonly faults: number
}

/** 封成的一卷：历史区间的规则骨架，写入后不再修改；叙事另行记录。 */
export interface ContextVolume {
  /** 1 是一次封段的卷，更高的级别由同级旧卷合并而成。 */
  readonly level: number
  readonly from: number
  readonly through: number
  readonly turns: number
  readonly results: number
  readonly failures: number
  /** 有写效果（已提交、部分或未知）的能力调用数。 */
  readonly effects: number
  /** 改过的笔记，形如 key@revision。 */
  readonly notes: readonly string[]
  readonly inputs: number
  /** 逐轮一行的规则骨架；合并卷为空。 */
  readonly skeleton: string
  /** 合并卷的组成卷。 */
  readonly parts?: readonly ContextRef[]
}

/** 一条卷叙事记录：记录引用、写给哪一卷、叙事内容。 */
export interface VolumeNarrativeRecord {
  readonly ref: ContextRef
  readonly volume: ContextRef
  readonly narrative: VolumeNarrative
}

/** 底座里的一张长期单：最新的在前；超出条数上限的只计数，并保留它们出处的引用。 */
export interface LedgerList {
  readonly items: readonly string[]
  readonly omitted: number
  readonly sources: readonly ContextRef[]
}

/** 底座里的长期单：跨卷累积的否定尝试、最新叙事里的未解问题、输入摘要里的用户约束。 */
export interface SegmentLedgers {
  readonly negativeAttempts: LedgerList
  readonly unresolved: LedgerList
  readonly constraints: LedgerList
}

/** 段起点之前提出的任务目标：底座只列第一行、引用和输入摘要引用，最新的在前。 */
export interface FoldedGoals {
  readonly items: ReadonlyArray<{
    readonly ref: ContextRef
    readonly sequence: number
    readonly line: string
    readonly summaryRef: Nullable<ContextRef>
  }>
  readonly omitted: number
}

/** 当前授权代次内仍在目录里的一卷及其最新叙事。 */
export interface VolumeView {
  readonly ref: ContextRef
  readonly volume: ContextVolume
  readonly narrative?: VolumeNarrative
}

/** 段内历史的一次投影：消息正文与送达情况，以及本帧新渲染、待接受后冻结的条目。 */
export interface SegmentHistory {
  readonly messages: readonly ModelHistoryMessage[]
  readonly items: ReadonlyArray<{
    readonly ref: string
    readonly sequence: number
    readonly role: 'user' | 'assistant'
    readonly bodyIncluded: boolean
    readonly representation: 'full' | 'excerpt' | 'reference'
  }>
  readonly fresh: readonly SegmentEntry[]
}

/** 段内历史要渲染的结果：ProgramContext 渲染好的当前租约正文。 */
export interface SegmentLeasedResult {
  readonly ref: string
  readonly sourceRef?: string
  readonly text?: string
  readonly source?: string
  readonly structuredOutput?: boolean
}
