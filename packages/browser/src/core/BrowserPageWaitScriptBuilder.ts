import { isEmpty,isString, toNullable } from '@velaros-ai/core'

import { precheckBrowserInlineScriptSyntax } from './BrowserEvaluateScriptBuilder'
import { clampInteger } from './BrowserRuntimeInternals'
import type { BrowserPageWaitOptions } from './types'

/** 构造页面等待脚本。 */
class BrowserPageWaitScriptBuilder {
  public buildPageWaitScript(options: BrowserPageWaitOptions): string {
    const functionExpression = this.normalizeString(options.functionExpression)
    const payload = JSON.stringify({
      durationMs: clampInteger(options.durationMs, 0, 60_000, 0),
      loadState: toNullable(options.loadState),
      timeoutMs: clampInteger(options.timeoutMs, 1, 60_000, 5_000),
      urlPattern: this.normalizeString(options.urlPattern),
      functionExpression,
      text: this.normalizeString(options.text),
    })
    // 表达式内联进脚本源码而不是页面内 new Function（撞站点 CSP 的 unsafe-eval）；
    // 语法坏掉的表达式退化为 null runner，并把编译错误落进 functionResult。
    const functionSyntaxError = functionExpression
      ? precheckBrowserInlineScriptSyntax(`return ( ${functionExpression} );`)
      : null
    const functionRunnerSource = functionExpression && !functionSyntaxError
      ? `async function () { return ( ${functionExpression} ); }`
      : 'null'
    const initialFunctionResult = functionSyntaxError
      ? JSON.stringify({ error: functionSyntaxError })
      : 'null'

    return `(() => {
      const payload = ${payload}
      const startedAt = Date.now()
      const regexSpecialChars = new Set(['.', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\\\'])
      const escapeRegExp = (value) =>
        value.split('').map((char) => regexSpecialChars.has(char) ? '\\\\' + char : char).join('')
      const createUrlPatternRegExp = (pattern) =>
        new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$')
      const readBodyText = () =>
        String((document.body && (document.body.innerText || document.body.textContent)) || '')
      const describeElement = (node) => {
        if (!(node instanceof Element)) return null
        const attributes = {}
        for (const attr of ['id', 'class', 'name', 'type', 'href', 'role', 'aria-label', 'data-testid']) {
          const value = node.getAttribute(attr)
          if (value) attributes[attr] = value
        }
        return {
          nodeType: 'Element',
          tagName: node.tagName.toLowerCase(),
          text: String(node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
          attributes,
        }
      }
      const simplifyFunctionResult = (value) => {
        if (value == null || value === undefined) return value
        const type = typeof value
        if (type === 'string' || type === 'number' || type === 'boolean') return value
        if (type === 'bigint' || type === 'symbol' || type === 'function') return String(value)
        if (value instanceof Element) return describeElement(value)
        if (Array.isArray(value)) return value.slice(0, 20).map(simplifyFunctionResult)
        if (type === 'object') return Object.prototype.toString.call(value)
        return String(value)
      }
      const functionRunner = ${functionRunnerSource}
      let lastFunctionMatched = !payload.functionExpression
      let lastFunctionResult = ${initialFunctionResult}
      const matchesUrl = () => {
        if (!payload.urlPattern) return true
        const currentUrl = location.href
        if (payload.urlPattern.includes('*')) {
          return createUrlPatternRegExp(payload.urlPattern).test(currentUrl)
        }

        return currentUrl.includes(payload.urlPattern)
      }
      const matchesText = () => {
        if (!payload.text) return true
        return readBodyText().includes(payload.text)
      }
      const evaluateFunctionExpression = () => {
        if (!payload.functionExpression) {
          lastFunctionMatched = true
          lastFunctionResult = null
          return Promise.resolve(true)
        }
        if (!functionRunner) {
          lastFunctionMatched = false
          return Promise.resolve(false)
        }

        return Promise.resolve()
          .then(() => functionRunner.call(window))
          .then((value) => {
            lastFunctionMatched = !!value
            lastFunctionResult = simplifyFunctionResult(value)
            return lastFunctionMatched
          })
          .catch((error) => {
            lastFunctionMatched = false
            lastFunctionResult = {
              error: error instanceof Error ? error.message : String(error),
            }
            return false
          })
      }
      const matchesLoadState = () => {
        if (payload.loadState === 'domcontentloaded') return document.readyState !== 'loading'
        if (payload.loadState === 'load') return document.readyState === 'complete'
        return true
      }
      const awaitReadyState = () => new Promise((resolve) => {
        if (matchesLoadState()) {
          resolve(false)
          return
        }
        let settled = false
        let timeout = null
        const finish = (timedOut) => {
          if (settled) return
          settled = true
          document.removeEventListener('DOMContentLoaded', check)
          window.removeEventListener('load', check)
          if (timeout) clearTimeout(timeout)
          resolve(timedOut)
        }
        const check = () => {
          if (matchesLoadState()) finish(false)
        }
        document.addEventListener('DOMContentLoaded', check)
        window.addEventListener('load', check)
        timeout = setTimeout(() => finish(!matchesLoadState()), payload.timeoutMs)
        check()
      })
      const awaitUrlPattern = () => new Promise((resolve) => {
        if (matchesUrl()) {
          resolve(false)
          return
        }
        let settled = false
        let interval = null
        let timeout = null
        const finish = (timedOut) => {
          if (settled) return
          settled = true
          if (interval) clearInterval(interval)
          if (timeout) clearTimeout(timeout)
          resolve(timedOut)
        }
        const check = () => {
          if (matchesUrl()) finish(false)
        }
        interval = setInterval(check, 50)
        timeout = setTimeout(() => finish(!matchesUrl()), payload.timeoutMs)
        check()
      })
      const awaitText = () => new Promise((resolve) => {
        if (matchesText()) {
          resolve(false)
          return
        }
        let settled = false
        let interval = null
        let timeout = null
        const finish = (timedOut) => {
          if (settled) return
          settled = true
          if (interval) clearInterval(interval)
          if (timeout) clearTimeout(timeout)
          resolve(timedOut)
        }
        const check = () => {
          if (matchesText()) finish(false)
        }
        interval = setInterval(check, 50)
        timeout = setTimeout(() => finish(!matchesText()), payload.timeoutMs)
        check()
      })
      const awaitFunctionExpression = () => new Promise((resolve) => {
        if (!payload.functionExpression) {
          resolve(false)
          return
        }
        if (!functionRunner) {
          resolve(false)
          return
        }
        let settled = false
        let interval = null
        let timeout = null
        const finish = (timedOut) => {
          if (settled) return
          settled = true
          if (interval) clearInterval(interval)
          if (timeout) clearTimeout(timeout)
          resolve(timedOut)
        }
        const check = () => {
          void evaluateFunctionExpression().then((matched) => {
            if (matched) finish(false)
          })
        }
        interval = setInterval(check, 50)
        timeout = setTimeout(() => finish(!lastFunctionMatched), payload.timeoutMs)
        check()
      })
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

      return Promise.all([awaitReadyState(), awaitUrlPattern(), awaitText(), awaitFunctionExpression()]).then(([loadTimedOut, urlTimedOut, textTimedOut, functionTimedOut]) =>
        delay(payload.durationMs).then(() => ({
          url: location.href,
          loadState: document.readyState,
          requestedLoadState: payload.loadState,
          urlPattern: payload.urlPattern,
          functionExpression: payload.functionExpression,
          functionResult: lastFunctionResult,
          text: payload.text,
          matched: matchesLoadState() && matchesUrl() && matchesText() && lastFunctionMatched,
          durationMs: payload.durationMs,
          timeoutMs: payload.timeoutMs,
          elapsedMs: Date.now() - startedAt,
          timedOut: !!loadTimedOut || !!urlTimedOut || !!textTimedOut || !!functionTimedOut,
          capturedAt: Date.now(),
        }))
      )
    })()`
  }


  private normalizeString(value: string | undefined): Nullable<string> {
    if (!isString(value)) return null
    const trimmed = value.trim()
    return isEmpty(trimmed) ? null : trimmed
  }
}

export { BrowserPageWaitScriptBuilder }
