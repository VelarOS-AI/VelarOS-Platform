/**
 * 完成复核专用只读取证，只接受本次证据目录中的身份。查询不会运行命令、修改文件或访问网络。
 * 按需批量查找和读取已有产物或不可变的实际源码/回执对，片段保留完整来源哈希及连续范围。
 */
declare module 'velaros:completion-evidence' {
  /** 一次查询 1..16 项；read.limit 为 1..32000，find.literal 为 1..256 字符，find.limit 为 1..16。一次复核最多 4 批、64 项、131072 正文字节，每批最多 32768 字节；原文读取上限 16777216 字节。按 nextOffset 续读，issue 是缺口；目录元数据不能证明正文正确。
   */
  export function retrieve(input: CompletionEvidenceInput): Promise<CompletionEvidenceBatch>

  /** 一次最多 16 项；read.limit 为 1..32000 字符，find.literal 最多 256 字符、find.limit 为 1..16，offset 从 0 开始。身份只取本次目录。 */
  interface CompletionEvidenceInput {
    readonly queries: readonly CompletionEvidenceQuery[]
  }

  /** 有界查询回执；全部片段只读，不能用来源元数据代替语义证明。 */
  interface CompletionEvidenceBatch {
    readonly pages: readonly CompletionEvidencePage[]
    readonly bytes: number
    readonly remainingQueries: number
    readonly remainingBytes: number
  }

  /** 在已授权证据中读取连续 UTF-16 范围，或查找非空字面文本。范围边界保留完整 Unicode 字符。 */
  type CompletionEvidenceQuery =
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

  /** 一项查询的结果。nextOffset 非空表示该查询尚可续读或续查；issue 保留实际缺口，不能解释为没有匹配或内容正确。 */
  interface CompletionEvidencePage {
    readonly query: CompletionEvidenceQuery
    readonly fragments: readonly CompletionEvidenceFragment[]
    readonly sha256?: string
    readonly totalChars?: number
    // @arch-guard:suspend code-style/prefer-loose-optional 理由：模型数据合同用 JSON null 明确终止，不引入 core 工具类型。
    readonly nextOffset: number | null
    readonly issue?: string
  }

  /** 宿主读取的连续原文。sha256 对应整个来源；offset、totalChars 按 UTF-16 计，omitted 表示本片段之外仍有正文。 */
  interface CompletionEvidenceFragment {
    readonly identity: string
    readonly sha256: string
    readonly offset: number
    readonly text: string
    readonly totalChars: number
    readonly omitted: boolean
  }
}
