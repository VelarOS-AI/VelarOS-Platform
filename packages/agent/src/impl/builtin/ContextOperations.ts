import type { HandoffContextInput, RecallContextInput } from '../../types/builtin.js'
import type { KernelToolContext } from '../../types/tool-context.js'
import { findRecallArchiveRecord, presentHistoricalFile, recallByQuery, recallByRef } from '../../utils/builtin/context-tools'
import { FileSnapshotToolName } from '../../utils/context/file-snapshot-archive'
import { fileContextRegistry } from '../context/FileContextRegistry'

/**
 * 上下文两个工具（`context:recall`、`context:handoff`）的执行面。
 *
 * 只认工具上下文这一条注入口：召回要么走宿主的会话检索端口，要么走文件快照协调器；
 * 交接只是把请求转给宿主的交接卡，批不批由用户定。整个进程一份，自身不持有状态。
 */
export interface ContextOperationsApi {
  /**
   * 按 ref 或 query 召回本会话已经产生过的上下文。
   *
   * 传了 `path` 或文件快照 ref 走历史文件那条路；传了别的 ref 按前缀判别种类后回读对应载荷；
   * 只传 query 时同时搜会话历史与终端日志。取不到时返回 `found:false` 加中文原因，不抛错。
   */
  recall(input: RecallContextInput, ctx: KernelToolContext): Promise<unknown>
  /**
   * 请宿主弹出会话交接卡，等用户批准或拒绝。
   *
   * 宿主没接交接端口时返回 `requested:false` 并说明原因，不抛错——交接是可选能力，缺席不该让这一轮失败。
   */
  handoff(input: HandoffContextInput, ctx: KernelToolContext): Promise<unknown>
}

class ContextOperations implements ContextOperationsApi {
  /** velar:project 的读取凭据（fileRef、续读页）前缀：召回这里直接回绝，免得模型把当前源码当历史载荷读。 */
  private static readonly ProjectOwnedRefPattern = /^(?:source|view|read-page):/u
  /** 运行时内部记录的工具名前缀；只有用户超长正文那一条是例外。 */
  private static readonly InternalRecordPrefix = '__'

  public async recall(input: RecallContextInput, ctx: KernelToolContext): Promise<unknown> {
    if (input.ref && ContextOperations.ProjectOwnedRefPattern.test(input.ref)) return {
      kind: 'internal-reference', found: false,
      reason: '这是 velar:project 的读取凭据（fileRef、续读），只在程序里原样交给 velar:project 用；要看当前源码，在程序里用 velar:project 的 read 读。',
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

  public async handoff(input: HandoffContextInput, ctx: KernelToolContext): Promise<unknown> {
    ctx.abortSignal.throwIfAborted()
    const requestHandoff = ctx.conversation.requestHandoff
    if (!requestHandoff) return {
      requested: false,
      sessionId: ctx.sessionId,
      reason: input.reason,
      unavailableReason: '当前宿主不支持会话交接卡。',
    }

    return requestHandoff({ reason: input.reason })
  }

}

/** 进程内唯一一份上下文执行面；工具文件按它一行委托。 */
export const contextOperations: ContextOperationsApi = new ContextOperations()
