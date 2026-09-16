/**
 * 第一环治理管线契约，对应宪章 §2 的六个阶段。
 *
 * 阶段统一接受草稿与临时上下文，返回改写后的草稿及历史改写信号。宿主可以重排或替换单个阶段，
 * 也可通过 `session_before_compact` 整体接管语义。临时上下文保存跨阶段共享的扫描结果，例如
 * `ToolReferenceScan`；拆分后的各阶段必须复用这些结果，禁止重复执行全量扫描。
 */
import type { ModelMessage } from 'ai'

import type { ProviderHistoryRewriteSignal, ProviderRequestScratch,ToolReferenceScan } from '../../types/context.js'

import { shortHash } from './content-hash'
import { scanProviderMessages } from './message-scan'

/** 新建一份编译 pass 局部 scratch。 */
export function createProviderRequestScratch(): ProviderRequestScratch {
  return { toolReferenceScan: null }
}

/**
 * 懒取共享工具引用扫描：首次扫描落 scratch，后续命中缓存。scratch 为 pass 局部，
 * 因此只对当次编译的最终 provider 消息扫描一次。
 */
export function resolveSharedToolReferenceScan(
  scratch: ProviderRequestScratch,
  messages: readonly ModelMessage[]
): ToolReferenceScan {
  if (scratch.toolReferenceScan) return scratch.toolReferenceScan

  const scan = scanProviderMessages(messages)
  scratch.toolReferenceScan = scan
  return scan
}

/** 聚合各 stage 的历史改写签名成稳定指纹；无签名返回 undefined（对应可选字段的缺省）。 */
export function buildProviderHistoryRewriteFingerprint(
  signals: readonly ProviderHistoryRewriteSignal[]
): string | undefined {
  if (!signals.length) return undefined

  return `log-rewrite:${shortHash(JSON.stringify(signals))}`
}
