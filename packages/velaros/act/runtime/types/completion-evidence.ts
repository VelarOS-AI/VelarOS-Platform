import type { ContextRecord } from '@velaros-ai/context'

/** @AgentView 在已授权证据中读取连续 UTF-16 范围，或查找非空字面文本。范围边界保留完整 Unicode 字符。 */
export type CompletionEvidenceQuery =
  | {
      readonly kind: 'read'
      readonly identity: string
      readonly offset: number
      readonly limit: number
    }
  | {
      readonly kind: 'find'
      readonly identity: string
      readonly literal: string
      readonly offset?: number
      readonly limit?: number
    }

/** @AgentView 一次最多 16 项；read.limit 为 1..32000 字符，find.literal 最多 256 字符、find.limit 为 1..16，offset 从 0 开始。身份只取本次目录。 */
export interface CompletionEvidenceInput {
  readonly queries: readonly CompletionEvidenceQuery[]
}

/** @AgentView 宿主读取的连续原文。sha256 对应整个来源；offset、totalChars 按 UTF-16 计，omitted 表示本片段之外仍有正文。 */
export interface CompletionEvidenceFragment {
  readonly identity: string
  readonly sha256: string
  readonly offset: number
  readonly text: string
  readonly totalChars: number
  readonly omitted: boolean
}

/** @AgentView 一项查询的结果。nextOffset 非空表示该查询尚可续读或续查；issue 保留实际缺口，不能解释为没有匹配或内容正确。 */
export interface CompletionEvidencePage {
  readonly query: CompletionEvidenceQuery
  readonly fragments: readonly CompletionEvidenceFragment[]
  readonly sha256?: string
  readonly totalChars?: number
  // @arch-guard:suspend code-style/prefer-loose-optional 理由：模型数据合同用 JSON null 明确终止，不引入 core 工具类型。
  readonly nextOffset: number | null
  readonly issue?: string
}

/** @AgentView 有界查询回执；全部片段只读，不能用来源元数据代替语义证明。 */
export interface CompletionEvidenceBatch {
  readonly pages: readonly CompletionEvidencePage[]
  readonly bytes: number
  readonly remainingQueries: number
  readonly remainingBytes: number
}

/** 本任务实际源码与回执的不可变记录目录；记录内容仅按需读取。 */
export interface CompletionExecutionEntry {
  readonly identity: string
  readonly records: readonly ContextRecord[]
}

/** 可查询的来源目录；目录摘要不代表正文已经送达模型。 */
export interface CompletionEvidenceDescriptor {
  readonly identity: string
  readonly kind: 'artifact' | 'execution'
  readonly sha256?: string
  readonly bytes?: number
  readonly description?: string
  readonly records?: ReadonlyArray<{
    readonly title: string
    readonly createdAt: string
    readonly chars: number
  }>
}
