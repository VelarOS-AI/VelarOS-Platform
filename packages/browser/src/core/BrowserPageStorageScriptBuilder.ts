import { clampInteger } from './BrowserRuntimeInternals'
import type { BrowserPageStorageOptions } from './types'

/** 构造读取页面 storage/cookie 的脚本。 */
class BrowserPageStorageScriptBuilder {
  /** 根据选项读取 localStorage、sessionStorage 和 document.cookie。 */
  public buildPageStorageScript(options: BrowserPageStorageOptions): string {
    const payload = JSON.stringify({
      includeLocalStorage: options.includeLocalStorage ?? true,
      includeSessionStorage: options.includeSessionStorage ?? true,
      includeCookies: !!options.includeCookies,
      limit: clampInteger(options.limit, 1, 300, 100),
      maxValueChars: clampInteger(options.maxValueChars, 1, 50_000, 4_000),
    })

    return `(() => {
      const payload = ${payload}
      const truncate = (value) => {
        const text = String(value || '')
        return {
          value: text.length > payload.maxValueChars ? text.slice(0, payload.maxValueChars) : text,
          valueTruncated: text.length > payload.maxValueChars,
        }
      }
      const readStorage = (storage) => {
        const entries = []
        try {
          for (let index = 0; index < storage.length && entries.length < payload.limit; index += 1) {
            const name = storage.key(index)
            if (!name) continue
            entries.push({
              name,
              ...truncate(storage.getItem(name) || ''),
            })
          }
        } catch (error) {
          entries.push({
            name: '__error__',
            ...truncate(error instanceof Error ? error.message : String(error)),
          })
        }
        return entries
      }
      const readCookies = () => {
        if (!document.cookie) return []
        return document.cookie
          .split(';')
          .map((entry) => entry.trim())
          .filter(Boolean)
          .slice(0, payload.limit)
          .map((entry) => {
            const separator = entry.indexOf('=')
            const name = separator >= 0 ? entry.slice(0, separator) : entry
            const value = separator >= 0 ? entry.slice(separator + 1) : ''
            return {
              name,
              ...truncate(value),
            }
          })
      }

      return {
        url: location.href,
        ...(payload.includeLocalStorage ? { localStorage: readStorage(window.localStorage) } : {}),
        ...(payload.includeSessionStorage ? { sessionStorage: readStorage(window.sessionStorage) } : {}),
        ...(payload.includeCookies ? { cookies: readCookies() } : {}),
        capturedAt: Date.now(),
      }
    })()`
  }

}

export { BrowserPageStorageScriptBuilder }
