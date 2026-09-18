import type { MemorySealedContentV2 } from './storage.js'

/**
 * 记忆树 v2 彻底清除 saga 的数据形状：擦除目标、牵连闭包、请求状态与身份接续。
 * 树 v2 是包内子系统，这些类型不出包。
 */

/** 能被擦除的七类目标。 */
export type MemoryErasureTargetTypeV2 =
  | 'evidence'
  | 'concept'
  | 'episode'
  | 'claim'
  | 'relation'
  | 'identity_epoch'
  | 'tree_node'

/** 一个擦除目标。 */
export interface MemoryErasureTargetV2 {
  /** 目标种类。 */
  readonly type: MemoryErasureTargetTypeV2
  /** 目标 id（tree_node 用节点的 stableKey）。 */
  readonly id: string
}

/** 从一个目标算出来的全部牵连对象，每组都按码元序排好去重。 */
export interface MemoryErasureClosureV2 {
  /** 格式身份，固定 `velaros.memory.erasure-closure.v2`。 */
  readonly format: 'velaros.memory.erasure-closure.v2'
  /** 这次擦除的起点。 */
  readonly target: MemoryErasureTargetV2
  /** 牵连到的证据 id。 */
  readonly evidenceIds: readonly string[]
  /** 牵连到的概念 id。 */
  readonly conceptIds: readonly string[]
  /** 牵连到的情节 id。 */
  readonly episodeIds: readonly string[]
  /** 牵连到的主张 id。 */
  readonly claimIds: readonly string[]
  /** 牵连到的关系 id。 */
  readonly relationIds: readonly string[]
  /** 牵连到的身份纪元 id。 */
  readonly identityEpochIds: readonly string[]
  /** 牵连到的树节点 stableKey。 */
  readonly treeStableKeys: readonly string[]
  /** 要 crypto-shred 的全部 blob id。 */
  readonly blobIds: readonly string[]
}

/** 擦除预览：闭包、它的摘要与各类计数。摘要用于确认时核对闭包没变。 */
export interface MemoryErasurePreviewV2 {
  /** 算出来的牵连闭包。 */
  readonly closure: MemoryErasureClosureV2
  /** 闭包 canonical 字节的 sha256。 */
  readonly digest: string
  /** 各类目标的条数。 */
  readonly counts: Readonly<Record<string, number>>
}

/** 第一段（权威提交）完成后的回执。 */
export interface MemoryErasureConfirmedV2 {
  /** 这次擦除请求的 id。 */
  readonly requestId: string
  /** 落 redact 的那个树版本。 */
  readonly redactVersion: number
  /** 这次推进到的隐私代。 */
  readonly privacyGeneration: number
  /** 固定为 confirmed。 */
  readonly state: 'confirmed'
}

/** 一次擦除请求的当前状态。 */
export interface MemoryErasureStatusV2 {
  /** 请求 id。 */
  readonly requestId: string
  /** 状态：已确认 / 正在清除 / 已验证 / 卡住。 */
  readonly state: 'confirmed' | 'purging' | 'verified' | 'stalled'
  /** 落 redact 的那个树版本。 */
  readonly redactVersion: number
  /** 这次推进到的隐私代。 */
  readonly privacyGeneration: number
  /** 验证通过的时刻（毫秒）；还没验证就是 null。 */
  readonly verifiedAt: Nullable<number>
}

/** `memory_erasure_requests` 的行形状。 */
export interface MemoryErasureRequestRowV2 {
  /** 请求 id。 */
  id: string
  /** canonical 序列化的闭包。 */
  closure_json: string
  /** 落 redact 的树版本。 */
  redact_version: number
  /** 推进到的隐私代。 */
  privacy_generation: number
  /** 当前状态。 */
  state: MemoryErasureStatusV2['state']
  /** 验证通过的时刻。 */
  verified_at: Nullable<number>
}

/** 当前生效身份纪元的行形状（算闭包与接续身份要用）。 */
export interface ActiveIdentityRowV2 {
  /** 纪元 id。 */
  id: string
  /** 纪元序号。 */
  sequence: number
  /** 支撑它的概念 id（JSON 数组）。 */
  supporting_concept_ids_json: string
  /** 支撑它的情节 id（JSON 数组）。 */
  supporting_episode_ids_json: string
  /** 支撑它的主张 id（JSON 数组）。 */
  supporting_claim_ids_json: string
}

/** 擦掉当前身份后要顶上去的中性接续身份（正文已经封好）。 */
export interface ReplacementIdentityV2 {
  /** 新纪元 id。 */
  id: string
  /** 新纪元序号。 */
  sequence: number
  /** 被它接续的纪元 id；本来就没有身份时为 null。 */
  predecessorId: Nullable<string>
  /** 封好的身份陈述。 */
  statement: MemorySealedContentV2
  /** 封好的全局主线。 */
  globalMainline: MemorySealedContentV2
}

/** 算闭包时按实体分好的几组 id。 */
export interface MemoryErasureClosureSetsV2 {
  /** 证据 id。 */
  readonly evidence: ReadonlySet<string>
  /** 概念 id。 */
  readonly concepts: ReadonlySet<string>
  /** 情节 id。 */
  readonly episodes: ReadonlySet<string>
  /** 主张 id。 */
  readonly claims: ReadonlySet<string>
  /** 身份纪元 id。 */
  readonly identities: ReadonlySet<string>
}

/** 第一段权威提交参与者要的全部材料。 */
export interface MemoryErasureFirstPhaseInputV2 {
  /** 这次擦除请求的 id。 */
  readonly requestId: string
  /** 牵连闭包。 */
  readonly closure: MemoryErasureClosureV2
  /** 这次要落到的树版本。 */
  readonly nextVersion: number
  /** 提交前的隐私代（CAS 用）。 */
  readonly currentPrivacyGeneration: number
  /** 提交后的隐私代。 */
  readonly privacyGeneration: number
  /** 要顶上去的接续身份；不需要换身份时为 null。 */
  readonly replacement: Nullable<ReplacementIdentityV2>
  /** 确认时刻（毫秒）。 */
  readonly confirmedAt: number
}

/** 只取 id 一列的通用行形状。 */
export interface MemoryIdRowV2 {
  /** 这一行的 id。 */
  readonly id: string
}

/** 算闭包时扫身份纪元支撑集用的行形状。 */
export interface MemoryIdentitySupportRowV2 {
  /** 纪元 id。 */
  readonly id: string
  /** 支撑它的概念 id（JSON 数组）。 */
  readonly supporting_concept_ids_json: string
  /** 支撑它的情节 id（JSON 数组）。 */
  readonly supporting_episode_ids_json: string
  /** 支撑它的主张 id（JSON 数组）。 */
  readonly supporting_claim_ids_json: string
}

/** 扫候选账本时用的行形状。 */
export interface MemoryCandidateLedgerRowV2 {
  /** 候选账本的密文引用。 */
  readonly blob_ref: string
  /** 候选账本的承诺。 */
  readonly commitment: string
}
