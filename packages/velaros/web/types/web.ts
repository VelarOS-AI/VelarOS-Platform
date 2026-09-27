/**
 * 可移植数据：`velaros:web` 的入参与结果，以及宿主报给本单元的搜索引擎。
 * 不 import 任何东西、不带函数、不用 Node 类型，浏览器和渲染进程都能用；从 `@velaros-ai/velaros/web/contracts` 取。
 */

// ── 搜索 ────────────────────────────────────────────────────────

/** @AgentView 搜索引擎：用户在设置里选的那个，或者搜不通时换上的另一个。 */
export type WebSearchEngineId = 'google' | 'bing'

/** @AgentView 搜什么：query 是搜索词（最多 1000 个字符）；limit 最多要几条结果，默认 8 条、最多 20 条。 */
export interface WebSearchInput {
  query: string
  limit?: number
}

/**
 * @AgentView
 * 一条结果：url 是目标地址，搜索引擎的跳转链接已经解开（个别解不开的是 google.com/goto 跳转，read 照样读得到跳过去的那一页）；
 * snippet 是搜索引擎给的摘要，可能是空字符串。
 */
export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * @AgentView
 * engine 是这次实际用的搜索引擎（用户选的那个搜不通时换成了另一个）。
 * results 按搜索引擎排的顺序，重复的地址只留第一条；是空数组就是没搜到，换个说法再搜。
 */
export interface WebSearchResults {
  query: string
  engine: WebSearchEngineId
  results: WebSearchResult[]
}

// ── 读网页 ──────────────────────────────────────────────────────

/**
 * @AgentView
 * 读哪个网页：url 要 http 或 https（最多 4096 个字符，没写协议按 https）。
 * offset 从正文的第几个字符读起，不给就从头读；maxChars 这次最多读多少个字符，默认 8000、最多 20000。
 */
export interface WebReadInput {
  url: string
  offset?: number
  maxChars?: number
}

/**
 * @AgentView
 * 读出来的一段正文。url 是跳转之后的最终地址，title 是网页标题（纯文本文件没有标题，是空字符串）。
 * text 是整页正文从 offset 起的一段：网页的行内空白并成一个、段落之间空一行；纯文本文件（源码、Markdown、JSON 这类）原样交回，缩进和空行都在。
 * totalChars 是整页正文一共多少个字符。
 * nextOffset 不是 null 就是还没读完，拿它当 offset 再调一次 read 接着读；是 null 就读到头了。
 */
export interface WebPageText {
  url: string
  title: string
  text: string
  offset: number
  totalChars: number
  nextOffset: Nullable<number>
}
