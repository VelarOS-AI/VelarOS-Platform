import type { CompletionValidationOperationContext } from '../contract/requires.js'
import type {
  CompletionValidationInput,
  CompletionValidationReceipt,
} from '../types/completion-validation.js'

/** @AgentView 完成复核的独立验证入口；只执行本次固定文件副本上的有界 Node.js ESM 代码。 */
export interface CompletionValidationOperationsApi {
  /** @AgentView 本次复核最多两次。通过 JSON.parse(process.env.VELAR_REVIEW_INPUTS) 取得所选身份对应的只读文件 URL，再 import 或读取。仅临时工作目录可写；网络、子进程和副本外文件不可用，依赖须在所选文件中。回执只证明本次断言；区分产品反例、断言错误和环境缺口。
   * @OperationEffect write
   */
  execute(
    input: CompletionValidationInput,
    ctx: CompletionValidationOperationContext
  ): Promise<CompletionValidationReceipt>
}

/** 模型操作交给同一接收门；不接收宿主命令或自由环境变量。 */
export class CompletionValidationOperations implements CompletionValidationOperationsApi {
  public execute(
    input: CompletionValidationInput,
    ctx: CompletionValidationOperationContext
  ): Promise<CompletionValidationReceipt> {
    return ctx.validation.execute(input, ctx.abortSignal)
  }
}
