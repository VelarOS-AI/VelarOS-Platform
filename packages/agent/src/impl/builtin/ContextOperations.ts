import { toNullable } from '@velaros-ai/core'

import type { HandoffContextInput, RecallContextInput } from '../../types/builtin.js'
import type { KernelToolContext } from '../../types/tool-context.js'
import { inferRecallRefKind } from '../../utils/builtin/context-retrieval'
import { presentHistoricalFile } from '../../utils/builtin/context-tools'
import { FileSnapshotToolName } from '../../utils/context/file-snapshot-archive'
import { fileContextFor } from '../context/FileContextCoordinator'

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
  /** 归项目工具消费的引用前缀：召回这里直接回绝，免得模型把当前源码当历史载荷读。 */
  private static readonly ProjectOwnedRefPattern = /^(?:source|view|read-page):/u
  /** 运行时内部记录的工具名前缀；只有用户超长正文那一条是例外。 */
  private static readonly InternalRecordPrefix = '__'

  public async recall(input: RecallContextInput, ctx: KernelToolContext): Promise<unknown> {
    if (input.ref && ContextOperations.ProjectOwnedRefPattern.test(input.ref)) return {
      kind: 'internal-reference', found: false,
      reason: '这个引用归项目工具消费。当前源码用 project:read 读；历史源码用 path 加 revision 召回。',
    }
    const archiveRecord = await this.findArchiveRecord(input, ctx)
    if (input.path || input.refKind === 'file-snapshot' || archiveRecord?.toolName === FileSnapshotToolName) return this.recallHistoricalFile(input, ctx, archiveRecord?.payloadRef)
    if (archiveRecord?.toolName.startsWith(ContextOperations.InternalRecordPrefix)
      && archiveRecord.toolName !== '__context_user_text__') return {
      kind: 'internal-reference', found: false,
      reason: '这是运行时的内部记录，不是通用的对话载荷。请用产生它的那个工具去读；历史文件用 path 加 revision。',
    }

    return input.ref ? this.recallByRef(input, ctx) : this.recallByQuery(input, ctx)
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

  /** ref 指向本会话已落盘的载荷时把归档记录取出来，用于判断它到底是文件快照还是内部记录。 */
  private async findArchiveRecord(input: RecallContextInput, ctx: KernelToolContext) {
    const payloadPrefix = `ctx-payload:${encodeURIComponent(ctx.sessionId)}:`
    const archiveHash = input.ref?.startsWith(payloadPrefix) ? input.ref.slice(payloadPrefix.length)
      : input.ref?.startsWith('file-snapshot:') ? input.ref.slice('file-snapshot:'.length) : undefined
    return archiveHash ? ctx.contextPayloadStore?.findByHash(ctx.sessionId, archiveHash) : undefined
  }

  /** 走文件快照协调器读历史版本；宿主没接快照存储时如实说取不到。 */
  private async recallHistoricalFile(
    input: RecallContextInput,
    ctx: KernelToolContext,
    payloadRef: LooseOptional<string>
  ): Promise<unknown> {
    const files = fileContextFor(ctx)
    return files ? presentHistoricalFile(await files.recall({ ...input, ref: payloadRef ?? input.ref }))
      : { kind: 'file-snapshot', found: false, reason: '当前宿主没有接文件快照存储，取不到历史版本。' }
  }

  /** 按 ref 精确取回：refKind 省略时按 ref 前缀判别，reason 省略时给个兜底，不硬拒。 */
  private async recallByRef(input: RecallContextInput, ctx: KernelToolContext): Promise<unknown> {
    const conversation = ctx.conversation
    const maxChars = toNullable(input.maxChars)
    const refKind = input.refKind ?? inferRecallRefKind(input.ref!)
    const reason = input.reason?.trim() || '(未说明)'
    switch (refKind) {
      case 'evidence':
        return {
          kind: refKind,
          result: await conversation.readEvidence({
            sessionId: ctx.sessionId,
            evidenceId: input.ref!,
            maxChars,
          }),
        }
      case 'tool-payload':
        return {
          kind: refKind,
          result: await conversation.readToolPayload({
            sessionId: ctx.sessionId,
            toolCallId: input.ref,
            jsonPath: input.jsonPath,
            offset: input.offset,
            reason,
            maxChars,
          }),
        }
      case 'payload-ref':
        return {
          kind: refKind,
          result: await conversation.readToolPayload({
            sessionId: ctx.sessionId,
            payloadRef: input.ref,
            jsonPath: input.jsonPath,
            offset: input.offset,
            reason,
            maxChars,
          }),
        }
      default:
        return {
          kind: refKind,
          result: await conversation.retrieveContextPayload({
            sessionId: ctx.sessionId,
            handleId: input.ref!,
            // 分页参数必须跟着走:模型手里的 ref 很多时候就是 tool:*(搜索结果的 handleId、
            // 未命中时的自纠样本都是这个形态),漏传等于每次都回第一页,模型照提示加 offset
            // 重试拿到逐字相同的内容直到熔断（审计 U9）。
            jsonPath: input.jsonPath,
            offset: input.offset,
            reason,
            maxChars,
          }),
        }
    }
  }

  /** 按 query 搜索：kind 缺省 all，会话历史与终端日志各出一份结果。 */
  private async recallByQuery(input: RecallContextInput, ctx: KernelToolContext): Promise<unknown> {
    const conversation = ctx.conversation
    const maxChars = toNullable(input.maxChars)
    const query = input.query!.trim()
    const kind = input.kind ?? 'all'
    const maxResults = toNullable(input.maxResults)
    const results = []

    if (kind === 'all' || kind === 'conversation') {
      results.push({
        kind: 'conversation',
        result: await conversation.searchConversationHistory({
          sessionId: ctx.sessionId,
          query,
          maxResults,
          maxChars,
        }),
      })
    }

    if (kind === 'all' || kind === 'terminal') {
      results.push({
        kind: 'terminal',
        result: await conversation.searchTerminalOutput({
          sessionId: ctx.sessionId,
          query,
          maxResults,
          maxChars,
        }),
      })
    }

    return { kind, query, results }
  }
}

/** 进程内唯一一份上下文执行面；工具文件按它一行委托。 */
export const contextOperations: ContextOperationsApi = new ContextOperations()
