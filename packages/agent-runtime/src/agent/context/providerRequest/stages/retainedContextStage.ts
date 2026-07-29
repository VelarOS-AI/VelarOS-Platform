/**
 * Ring 1 stage ③——retained-context（ContextWorkingSetOS 的 provider-visible blocks）。
 *
 * active-task 与 pinned-evidence 区的块作为「硬保留上下文」**追加**在消息序列尾部一条 user 消息：
 * 它们是上下文，不替代最新用户指令。
 *
 * 为什么追加而非前插：保留块按 updatedAt 排序、内容易变，前插 message[0] 会让任一 artifact 触碰
 * 即击穿整段消息前缀缓存——与注意力粘滞「稳定前缀」目标自相矛盾。追加在尾部把易变内容留在
 * prompt-cache 断点之后（与 turn-context 同侧），既有 `message:<index>` 号一律不动（offset=0），
 * 顺带消除旧 `remapMessageBlockId` 前插重映射的档位碰撞（注入块与原 message[0] 都映射到
 * `message:0`）。
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
