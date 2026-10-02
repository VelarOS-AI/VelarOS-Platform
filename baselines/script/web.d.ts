/**
 * 网上查资料：search 用搜索引擎搜，read 把一个网页读成文字。都在一个不显示的浏览器里跑：用户看不到，不留浏览痕迹，也碰不到用户的登录。
 * 搜索引擎按用户的设置（Google 或 Bing）；它打不开、被拦成验证页或认不出结果时自动换另一个，结果里的 engine 写着实际用的是哪个。
 * 搜索结果只是线索：要紧的事读原文核对，交给用户时带上出处（url）。
 * 要在网页上动手（登录、填表、点按钮）、看页面长什么样、读登录之后才看得到的内容，用浏览器（velaros:browser），不用这个。
 * 失败抛的错误带 code：WEB_SEARCH_FAILED 两个搜索引擎都搜不了（message 写着两边各自为什么）；
 * WEB_PAGE_UNREACHABLE 网页打不开（连不上、加载出错，或者超时了什么都没出来）；WEB_PAGE_UNREADABLE 打开了却读不成文字（比如是 PDF）。入参不对是 VALIDATION。
 */
declare module 'velaros:web' {
  /** 用搜索引擎搜一次，交回前几条结果的标题、真实地址与摘要（默认 8 条、最多 20 条）。
   */
  export function search(input: WebSearchInput): Promise<WebSearchResults>

  /** 打开一个网页、等它渲染完，读出正文（去掉脚本、导航、页眉页脚、侧栏与表单；源码、Markdown、JSON 这类纯文本文件原样读出），按字符分段交回：默认一次 8000 个字符、最多 20000 个字符。
   * 每次 read 都重新打开网页，长网页一次多读一些。
   */
  export function read(input: WebReadInput): Promise<WebPageText>

  /** 搜什么：query 是搜索词（最多 1000 个字符）；limit 最多要几条结果，默认 8 条、最多 20 条。 */
  interface WebSearchInput {
    query: string
    limit?: number
  }

  /**
   * engine 是这次实际用的搜索引擎（用户选的那个搜不通时换成了另一个）。
   * results 按搜索引擎排的顺序，重复的地址只留第一条；是空数组就是没搜到，换个说法再搜。
   */
  interface WebSearchResults {
    query: string
    engine: WebSearchEngineId
    results: WebSearchResult[]
  }

  /**
   * 读哪个网页：url 要 http 或 https（最多 4096 个字符，没写协议按 https）。
   * offset 从正文的第几个字符读起，不给就从头读；maxChars 这次最多读多少个字符，默认 8000、最多 20000。
   */
  interface WebReadInput {
    url: string
    offset?: number
    maxChars?: number
  }

  /**
   * 读出来的一段正文。url 是跳转之后的最终地址，title 是网页标题（纯文本文件没有标题，是空字符串）。
   * text 是整页正文从 offset 起的一段：网页的行内空白并成一个、段落之间空一行；纯文本文件（源码、Markdown、JSON 这类）原样交回，缩进和空行都在。
   * totalChars 是整页正文一共多少个字符。
   * nextOffset 不是 null 就是还没读完，拿它当 offset 再调一次 read 接着读；是 null 就读到头了。
   */
  interface WebPageText {
    url: string
    title: string
    text: string
    offset: number
    totalChars: number
    nextOffset: number | null
  }

  /** 搜索引擎：用户在设置里选的那个，或者搜不通时换上的另一个。 */
  type WebSearchEngineId = 'google' | 'bing'

  /**
   * 一条结果：url 是目标地址，搜索引擎的跳转链接已经解开（个别解不开的是 google.com/goto 跳转，read 照样读得到跳过去的那一页）；
   * snippet 是搜索引擎给的摘要，可能是空字符串。
   */
  interface WebSearchResult {
    title: string
    url: string
    snippet: string
  }
}
