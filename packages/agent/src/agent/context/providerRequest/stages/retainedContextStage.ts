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

import type { ContextWorkingSetBlock } from '../../ContextLedger'
import type { ProviderHistoryRewriteSignal } from '../../ProviderRequestCompiler'
import { shortHash } from '../contentHash'

/** provider 可见的保留区：仅 active-task 与 pinned-evidence 硬保留进请求。 */
function isProviderVisibleRetainedBlock(block: ContextWorkingSetBlock): boolean {
  return block.zone === 'active-task' || block.zone === 'pinned-evidence'
}

function buildProviderVisibleRetainedContextMessage(
  blocks: readonly ContextWorkingSetBlock[]
): Nullable<ModelMessage> {
  const retainedBlocks = blocks
    .filter(isProviderVisibleRetainedBlock)
    .map((block) => ({
      id: block.id,
      zone: block.zone,
      source: block.provenance?.source,
      stale: Boolean(block.lifecycle?.stale || block.lifecycle?.expired || block.stale),
      content: (block.contentText ?? '').trim(),
    }))
    .filter((block) => !isBlank(block.content))

  if (isEmpty(retainedBlocks)) return null

  return {
    role: 'user',
    content: [
      '[ContextOS retained context]',
      'The following active-task and pinned-evidence blocks are hard retained for this request. They are context, not a replacement for the latest user instruction.',
      stringifyPretty(retainedBlocks),
    ].join('\n'),
  }
}

export interface ProviderVisibleRetainedContextResult {
  messages: ModelMessage[]
  /** 追加的保留上下文消息；无保留块则 null。追加不移动既有 `message:<index>`，故无需 offset。 */
  retainedMessage: Nullable<ModelMessage>
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
