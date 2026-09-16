import type { BrowserSearchEngineId } from '../../types/browser.js'
import {
  buildBrowserSearchUrl,
  getBrowserSiteHost,
  getBrowserUrlCandidate,
  isLocalBrowserUrl,
  resolveBrowserNavigationInput,
  resolveBrowserSearchFallbackUrl,
  resolveBrowserSearchOrNavigationInput,
} from '../../utils/address.js'

/**
 * 地址栏的纯策略门面：一段输入是网址还是搜索词、搜什么引擎、站点主机名怎么取。
 *
 * 逻辑全是无状态的纯函数（住在 `utils/address.ts`），这里只把它们收成一件能力交给宿主——
 * 主进程与渲染进程用的是同一份判据，地址栏与工具的导航不会对同一段输入给出两种结论。
 */
export interface BrowserAddressApi {
  /** 从一段用户输入里取出可能的网址（去掉首尾空白与包裹符号）。 */
  urlCandidate(value: string): string
  /** 把一段输入解析成导航地址；不像网址时返回 undefined。 */
  resolveNavigationInput(value: string): LooseOptional<string>
  /** 把一段输入解析成导航地址或搜索地址，两者都给不出时返回 undefined。 */
  resolveSearchOrNavigationInput(
    value: LooseOptional<string>,
    searchEngine?: BrowserSearchEngineId
  ): LooseOptional<string>
  /** Google 搜索加载失败时的 Bing 兜底地址；不是 Google 搜索就返回 undefined。 */
  searchFallbackUrl(url: LooseOptional<string>): LooseOptional<string>
  /** 按选定的搜索引擎把一段关键词拼成搜索地址。 */
  searchUrl(query: string, searchEngine?: BrowserSearchEngineId): string
  /** 取站点工作区用的主机名（去掉 www 与多段公共后缀）；取不出时返回 null。 */
  siteHost(hostname: string): Nullable<string>
  /** 这个地址是不是本机地址（localhost / 回环）。 */
  isLocalUrl(url: URL): boolean
}

/** 见 {@link BrowserAddressApi}。 */
class BrowserAddress implements BrowserAddressApi {
  public urlCandidate(value: string): string {
    return getBrowserUrlCandidate(value)
  }

  public resolveNavigationInput(value: string): LooseOptional<string> {
    return resolveBrowserNavigationInput(value)
  }

  public resolveSearchOrNavigationInput(
    value: LooseOptional<string>,
    searchEngine?: BrowserSearchEngineId
  ): LooseOptional<string> {
    return resolveBrowserSearchOrNavigationInput(value, { searchEngine })
  }

  public searchFallbackUrl(url: LooseOptional<string>): LooseOptional<string> {
    return resolveBrowserSearchFallbackUrl(url)
  }

  public searchUrl(query: string, searchEngine?: BrowserSearchEngineId): string {
    return buildBrowserSearchUrl(query, searchEngine)
  }

  public siteHost(hostname: string): Nullable<string> {
    return getBrowserSiteHost(hostname)
  }

  public isLocalUrl(url: URL): boolean {
    return isLocalBrowserUrl(url)
  }
}

/** 整个进程共用的地址栏策略实例。 */
export const browserAddress: BrowserAddressApi = new BrowserAddress()
