/**
 * 实现自己的工作类型，不出单元：核对过的入参、页面脚本交回的原始数据、一次搜索引擎尝试的结局、切出来的一段正文。
 * 页面脚本交回的东西先经 `utils/scans.ts` 收成这里的形状，操作只和收过的打交道。
 */

import type { WebSearchEngineId, WebSearchResult } from './web.js'

/** 核对过的一次搜索：搜索词去掉了首尾空白，条数已经定下来。 */
export interface WebSearchRequest {
  query: string
  limit: number
}

/** 核对过的一次读网页：地址已经补齐协议并规范成 URL 的写法。 */
export interface WebReadRequest {
  url: string
  offset: number
  maxChars: number
}

/** 结果页里抓到的一条原始结果：链接还没解开（可能是搜索引擎的跳转链接），文字已经并好空白。 */
export interface WebRawHit {
  title: string
  href: string
  snippet: string
}

/** 结果页脚本交回的东西：抓到的原始结果、正文开头一段（认验证页用）、搜索引擎有没有明说「没有结果」。 */
export interface WebSearchScan {
  hits: WebRawHit[]
  text: string
  noResults: boolean
}

/** 等渲染时看一眼页面：文档加载到哪一步（document.readyState）、正文现在多少个字符。 */
export interface WebSettleProbe {
  ready: string
  length: number
}

/** 读正文的页面脚本交回的东西：网页标题、正文（innerText 原样，还没收拾空白）、文档的媒体类型。 */
export interface WebReadableScan {
  title: string
  text: string
  contentType: string
}

/**
 * 加载一页的结局：加载完了；到了时限还在加载（已经出来的内容照读）；到了落下时限连一个文档都没落下（打不开，不再等）；
 * 宿主报加载出错（带宿主的原话）。
 */
export type WebLoadOutcome =
  { kind: 'loaded' } | { kind: 'slow' } | { kind: 'silent' } | { kind: 'failed'; message: string }

/** 用一个搜索引擎试一次的结局：搜通了交回整理好的结果，搜不通交回一句为什么。 */
export type WebEngineAttempt =
  { ok: true; results: WebSearchResult[] } | { ok: false; reason: string }

/** 一个搜索引擎为什么没搜成：两边都失败时拼进报错给模型看。 */
export interface WebEngineFailure {
  engine: WebSearchEngineId
  reason: string
}

/** 从正文里切出来的一段：这一段的文字、实际的起点（落在码点边界上）、下一段的起点（读到头了是 null）。 */
export interface WebTextSlice {
  text: string
  start: number
  nextOffset: Nullable<number>
}
