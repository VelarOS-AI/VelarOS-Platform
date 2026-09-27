import type { BrowserSearchEngineId } from '../../types/browser.js'
import { resolveBrowserSearchEngineId } from '../../utils/preferences.js'

/**
 * 浏览器偏好的纯策略门面：把任意持久化值宽容地解析成闭集里的一个值。
 *
 * 闭集与出厂缺省是对外约定，住在 `contract/constants.ts`（`BrowserSearchEngineIds`、
 * `DefaultBrowserSearchEngine`）；
 * 这里只负责「读盘读到什么都能给出一个合法值」，守卫与解析合成一件事，宿主不必先判再解。
 */
export interface BrowserPreferencesApi {
  /** 解析搜索引擎 id：认不出就回出厂缺省。 */
  resolveSearchEngineId(value: LooseOptional<string>): BrowserSearchEngineId
}

/** 见 {@link BrowserPreferencesApi}。 */
class BrowserPreferences implements BrowserPreferencesApi {
  public resolveSearchEngineId(value: LooseOptional<string>): BrowserSearchEngineId {
    return resolveBrowserSearchEngineId(value)
  }
}

/** 整个进程共用的偏好策略实例。 */
export const browserPreferences: BrowserPreferencesApi = new BrowserPreferences()
