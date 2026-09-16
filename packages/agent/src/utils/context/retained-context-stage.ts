/**
 * 第一环第三阶段：注入 `ContextWorkingSetOS` 中提供方可见的保留上下文。
 *
 * `active-task` 与 `pinned-evidence` 区的块作为硬保留上下文，追加为消息序列尾部的一条用户消息；
 * 它们只补充上下文，不替代最新用户指令。
 *
 * 保留块按 `updatedAt` 排序且内容易变，若前插到首条消息，任一制品变化都会击穿整段前缀缓存。
 * 尾部追加可把易变内容留在提示词缓存断点之后，并保持既有 `message:<index>` 编号不变，同时避免
 * 旧 `remapMessageBlockId` 前插重映射造成编号碰撞。
 */
import type { ModelMessage } from 'ai'

import { isBlank, isEmpty, stringifyPretty } from '@velaros-ai/core'

import type { ContextWorkingSetBlock,ProviderHistoryRewriteSignal, ProviderVisibleRetainedContextResult } from '../../types/context.js'

import { shortHash } from './content-hash'

/** provider 可见的保留区：仅 active-task 与 pinned-evidence 硬保留进请求。 */
function isProviderVisibleRetainedBlock(block: ContextWorkingSetBlock): boolean {
  return block.zone === 'active-task' || block.zone === 'pinned-evidence'
}

/**
 * 把 active-task 与 pinned-evidence 两区的块拼成一条要追加到消息尾部的 user 消息；一块都没有（或正文全是空白）时返回 null。
 * 每块只投影出 id/zone/来源/句柄/文件路径/内容哈希/资源版本/是否陈旧与正文，正文两端去空白、空正文整块丢弃。
 * `kind` 只对 pinned-evidence 标注：带用户指令的记 `user-constraint`，其余记 `evidence`；`verified` 也只对非用户指令的证据块给值——
 * 用户约束不该被当成「已核验的事实」呈现给模型。
 * 正文前三行是固定说明：这是上下文而非新指令、陈旧证据描述的是旧快照、payloadRef 指向存档原文。
 */
function buildProviderVisibleRetainedContextMessage(
  blocks: readonly ContextWorkingSetBlock[]
): Nullable<ModelMessage> {
  const retainedBlocks = blocks
    .filter(isProviderVisibleRetainedBlock)
    .map((block) => ({
      id: block.id,
      zone: block.zone,
      source: block.provenance?.source,
      kind: block.zone === 'pinned-evidence'
        ? block.safety?.containsUserInstruction ? 'user-constraint' : 'evidence'
        : undefined,
      payloadRef: block.payloadRef ?? block.provenance?.payloadRef,
      filePath: block.provenance?.filePath,
      contentHash: block.provenance?.contentHash,
      resourceRevision: block.provenance?.resourceRevision,
      verified: block.zone === 'pinned-evidence' && !block.safety?.containsUserInstruction
        ? block.lifecycle?.verified : undefined,
      stale: Boolean(block.lifecycle?.stale || block.lifecycle?.expired || block.stale),
      content: (block.contentText ?? '').trim(),
    }))
    .filter((block) => !isBlank(block.content))

  if (isEmpty(retainedBlocks)) return null

  return {
    role: 'user',
    content: [
      '[ContextOS retained context]',
      '下面这些活动任务块与置顶证据块是本次请求强制保留的。它们是背景资料，不能替代用户最新的那条指令。',
      '标了 stale 的证据描述的是更早的快照。要依赖当前文件状态之前先按它的 filePath 复核一遍；payloadRef 指向它存下来的原文。',
      stringifyPretty(retainedBlocks),
    ].join('\n'),
  }
}

/** 在尾部追加保留上下文消息；无保留块则原样返回。 */
export function withProviderVisibleRetainedContext(
  messages: readonly ModelMessage[],
  blocks: readonly ContextWorkingSetBlock[]
): ProviderVisibleRetainedContextResult {
  const retainedContextMessage = buildProviderVisibleRetainedContextMessage(blocks)
  if (!retainedContextMessage) return { messages: [...messages], retainedMessage: null }

  return {
    messages: [...messages, retainedContextMessage],
    retainedMessage: retainedContextMessage,
  }
}

/** 保留上下文注入投影成历史改写签名；未注入则无签名。 */
export function buildRetainedContextRewriteSignals(
  input: ProviderVisibleRetainedContextResult
): ProviderHistoryRewriteSignal[] {
  if (!input.retainedMessage) return []

  return [
    {
      kind: 'retained-context-injection',
      details: {
        messageHash: shortHash(JSON.stringify(input.retainedMessage.content ?? '')),
      },
    },
  ]
}
