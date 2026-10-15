import type { CompletionEvidenceOperationContext } from '../contract/requires.js'
import type {
  CompletionEvidenceBatch,
  CompletionEvidenceInput,
} from '../types/completion-evidence.js'
import { completionEvidenceInput } from '../utils/completion-evidence.js'

/**
 * @AgentView
 * 完成复核专用只读取证，只接受本次证据目录中的身份。查询不会运行命令、修改文件或访问网络。
 * 按需批量查找和读取已有产物或不可变的实际源码/回执对，片段保留完整来源哈希及连续范围。
 */
export interface CompletionEvidenceOperationsApi {
  /** @AgentView 一次查询 1..16 项；read.limit 为 1..32000，find.literal 为 1..256 字符，find.limit 为 1..16。一次复核最多 4 批、64 项、131072 正文字节，每批最多 32768 字节；原文读取上限 16777216 字节。按 nextOffset 续读，issue 是缺口；目录元数据不能证明正文正确。
   * @OperationEffect none
   */
  retrieve(
    input: CompletionEvidenceInput,
    ctx: CompletionEvidenceOperationContext
  ): Promise<CompletionEvidenceBatch>
}

/** 原生复核接收门与生成合同共用唯一入口，调用上下文只能读取当前冻结证据。 */
export class CompletionEvidenceOperations implements CompletionEvidenceOperationsApi {
  public retrieve(
    input: CompletionEvidenceInput,
    ctx: CompletionEvidenceOperationContext
  ): Promise<CompletionEvidenceBatch> {
    ctx.abortSignal.throwIfAborted()
    return ctx.evidence.retrieve(completionEvidenceInput(input), ctx.abortSignal)
  }
}
