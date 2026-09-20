import type { RecallContextInput } from '../../types/builtin.js'
import type { KernelToolContext } from '../../types/tool-context.js'
import { findRecallArchiveRecord, presentHistoricalFile, recallByQuery, recallByRef } from '../../utils/builtin/context-tools'
import { FileSnapshotToolName } from '../../utils/context/file-snapshot-archive'
import { fileContextRegistry } from '../context/FileContextRegistry'

/** 会话历史与文件快照的只读检索实现。 */
export interface ContextOperationsApi {
  /**
   * 按 ref 或 query 召回本会话已经产生过的上下文。
   *
   * 传了 `path` 或文件快照 ref 走历史文件那条路；传了别的 ref 按前缀判别种类后回读对应载荷；
   * 只传 query 时同时搜会话历史与终端日志。取不到时返回 `found:false` 加中文原因，不抛错。
   */
  recall(input: RecallContextInput, ctx: KernelToolContext): Promise<unknown>

}

class ContextOperations implements ContextOperationsApi {
  /** velaros:project 的读取凭据（fileRef、续读页）前缀：召回这里直接回绝，免得模型把当前源码当历史载荷读。 */
  private static readonly ProjectOwnedRefPattern = /^(?:source|view|read-page):/u
  /** 运行时内部记录的工具名前缀；只有用户超长正文那一条是例外。 */
  private static readonly InternalRecordPrefix = '__'

  public async recall(input: RecallContextInput, ctx: KernelToolContext): Promise<unknown> {
    if (input.ref && ContextOperations.ProjectOwnedRefPattern.test(input.ref)) return {
      kind: 'internal-reference', found: false,
      reason: '这是 velaros:project 的读取凭据（fileRef、续读），只在程序里原样交给 velaros:project 用；要看当前源码，在程序里用 velaros:project 的 read 读。',
    }
    const archiveRecord = await findRecallArchiveRecord(input, ctx)
    // 历史文件走文件快照协调器；宿主没接快照存储时如实说取不到。
    if (input.path || input.refKind === 'file-snapshot' || archiveRecord?.toolName === FileSnapshotToolName) {
      const files = fileContextRegistry.for(ctx)
      return files ? presentHistoricalFile(await files.recall({ ...input, ref: archiveRecord?.payloadRef ?? input.ref }))
        : { kind: 'file-snapshot', found: false, reason: '当前宿主没有接文件快照存储，取不到历史版本。' }
    }
    if (archiveRecord?.toolName.startsWith(ContextOperations.InternalRecordPrefix)
      && archiveRecord.toolName !== '__context_user_text__') return {
      kind: 'internal-reference', found: false,
      reason: '这是运行时的内部记录，不是通用的对话载荷。请用产生它的那个工具去读。',
    }

    return input.ref ? recallByRef(input, ctx) : recallByQuery(input, ctx)
  }


}

/** 会话检索服务共享的只读历史解析器。 */
export const contextOperations: ContextOperationsApi = new ContextOperations()
