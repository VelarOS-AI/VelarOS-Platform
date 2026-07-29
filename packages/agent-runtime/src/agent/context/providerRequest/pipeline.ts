/**
 * Ring 1 治理管线契约（宪章 §2 六 stage）。
 *
 * stage 统一形态：`(draft, scratch) → draft + rewriteSignals`——host 可整序重排 / 替换单
 * stage / 经 session_before_compact 语义整体接管（本批不建扩展宿主，类型上可插拔即可）。
 * scratch 是跨 stage 的共享上下文：单体现在共享的中间扫描结果（ToolReferenceScan 等）落此，
 * 拆分后各 stage 从 scratch 取用，禁止重复全量扫描（红队点名的性能悬崖）。
 */
import type { ModelMessage } from 'ai'

import type { ProviderHistoryRewriteSignal } from '../ProviderRequestCompiler'

import { shortHash } from './contentHash'
import { scanProviderMessages, type ToolReferenceScan } from './messageScan'

/** 管线内流转的请求草稿：当前 provider 消息序列。 */
export interface ProviderRequestDraft {
  messages: ModelMessage[]
}

/** stage 输出：改写后的草稿消息 + 本 stage 贡献的历史改写签名。 */
export interface ProviderRequestStageOutput {
  messages: ModelMessage[]
  rewriteSignals: readonly ProviderHistoryRewriteSignal[]
}

/**
 * 跨 stage 共享上下文。每次编译单开一份（编译 pass 局部），承载会被多 stage 复用的
 * 中间扫描结果，避免各 stage 各扫一遍。
 */
export interface ProviderRequestScratch {
  /** provider 消息单次扫描结果，懒填充一次后复用（出核地板指纹与诊断共享）。 */
  toolReferenceScan: Nullable<ToolReferenceScan>
}

/**
 * stage 统一契约类型：治理管线的可插拔 seam。四个消息改写 stage
 * （tool-result-rewrite / history-sanitize / attention / retained-context）语义贴合此形态；
 * compaction 的回收阶梯是 pass 间驱动、budget 是出核前的终态装配，签名各自贴合数据流。
 */
export type ProviderRequestStage = (
  draft: ProviderRequestDraft,
  scratch: ProviderRequestScratch
) => ProviderRequestStageOutput

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
