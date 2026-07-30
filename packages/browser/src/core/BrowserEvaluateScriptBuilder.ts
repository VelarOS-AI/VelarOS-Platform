import { clampInteger } from './BrowserRuntimeInternals'
import type { BrowserEvaluateScriptOptions } from './types'

/**
 * 只编译不执行的用户脚本语法预检；返回错误消息，语法合法时返回 null。
 *
 * 页面内不能 new Function/eval（撞站点 CSP 的 unsafe-eval），用户脚本必须内联进
 * executeJavaScript 源码；主进程侧用与内联完全相同的 async 包装形状先行编译，
 * 把语法错误转成结构化结果，避免拼接后炸掉整个包装脚本。
 */
function precheckBrowserInlineScriptSyntax(functionBody: string): Nullable<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 仅编译校验语法，绝不调用。
    new Function(`return (async function () {\n${functionBody}\n})`)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** 构造页面内自定义脚本执行器。 */
class BrowserEvaluateScriptBuilder {
  /** 构建 evaluate 脚本，并把返回值序列化成安全 JSON。 */
  public buildEvaluateScript(options: BrowserEvaluateScriptOptions): string {
    const mode = options.mode ?? 'expression'
    // 用户脚本直接内联进 executeJavaScript 的源码：不能在页面里 new Function/eval——
    // 那会撞上站点 CSP 的 unsafe-eval（HN 等严格 CSP 站点直接拒绝），而
    // executeJavaScript 本身不受页面 CSP 限制。
    const functionBody = mode === 'function-body'
      ? options.script
      : `return ( ${options.script} );`
    const syntaxError = precheckBrowserInlineScriptSyntax(functionBody)
    if (syntaxError) return `(() => ({
        url: location.href,
        ok: false,
        mode: ${JSON.stringify(mode)},
        result: null,
        resultText: '',
        resultTruncated: false,
        error: { name: 'SyntaxError', message: ${JSON.stringify(syntaxError)}, stack: null },
        durationMs: 0,
        capturedAt: Date.now(),
      }))()`

    const payload = JSON.stringify({
      mode,
      timeoutMs: clampInteger(options.timeoutMs, 1, 30_000, 5_000),
      maxResultChars: clampInteger(options.maxResultChars, 1, 200_000, 20_000),
    })

    // 页面返回值可能包含 DOM、Error、循环引用等，脚本内会先 simplify 再 JSON 化。
    return `(() => {
      const payload = ${payload}
      const startedAt = Date.now()
      const truncateText = (value, max) => {
        const text = String(value || '')
        return {
          text: text.length > max ? text.slice(0, max) : text,
          truncated: text.length > max,
        }
      }
      const describeElement = (node) => {
        if (!(node instanceof Element)) return null
        const attributes = {}
        for (const attr of ['id', 'class', 'name', 'type', 'href', 'role', 'aria-label', 'data-testid', 'data-test', 'data-qa']) {
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
      const simplify = (value, depth = 0, seen = new WeakSet()) => {
        if (value == null || value === undefined) return value
        const type = typeof value
        if (type === 'string' || type === 'number' || type === 'boolean') return value
        if (type === 'bigint' || type === 'symbol' || type === 'function') return String(value)
        if (value instanceof Error) {
          return {
            name: value.name,
            message: value.message,
            stack: value.stack || null,
          }
        }
        if (value instanceof Element) return describeElement(value)
        if (value instanceof Node) {
          return {
            nodeType: value.nodeType,
            nodeName: value.nodeName,
            text: String(value.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
          }
        }
        if (depth >= 4) return Object.prototype.toString.call(value)
        if (type === 'object') {
          if (seen.has(value)) return '[Circular]'
          seen.add(value)
          if (Array.isArray(value)) {
            return value.slice(0, 100).map((item) => simplify(item, depth + 1, seen))
          }
          const output = {}
          for (const key of Object.keys(value).slice(0, 100)) {
            try {
              output[key] = simplify(value[key], depth + 1, seen)
            } catch (error) {
              output[key] = error instanceof Error ? error.message : String(error)
            }
          }
          return output
        }
        return String(value)
      }
      const serialize = (value) => {
        const simplified = simplify(value)
        let resultText
        try {
          resultText = JSON.stringify(simplified, null, 2)
        } catch {
          resultText = String(simplified)
        }
        if (resultText === undefined) resultText = 'undefined'
        const truncated = truncateText(resultText, payload.maxResultChars)
        return {
          result: truncated.truncated ? null : simplified,
          resultText: truncated.text,
          resultTruncated: truncated.truncated,
        }
      }
      const userScript = async function () {
${functionBody}
      }
      const run = async () => {
        let timeoutHandle
        return Promise.race([
          userScript.call(window),
          new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error('browser evaluate timeout after ' + payload.timeoutMs + 'ms')), payload.timeoutMs)
          }),
        ]).finally(() => {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
        })
      }

      return run()
        .then((value) => {
          const serialized = serialize(value)
          return {
            url: location.href,
            ok: true,
            mode: payload.mode,
            ...serialized,
            error: null,
            durationMs: Date.now() - startedAt,
            capturedAt: Date.now(),
          }
        })
        .catch((error) => {
          const err = error instanceof Error ? error : new Error(String(error))
          const stack = truncateText(err.stack || '', 8000)
          return {
            url: location.href,
            ok: false,
            mode: payload.mode,
            result: null,
            resultText: '',
            resultTruncated: false,
            error: {
              name: err.name || 'Error',
              message: err.message,
              stack: stack.text || null,
            },
            durationMs: Date.now() - startedAt,
            capturedAt: Date.now(),
          }
        })
    })()`
  }

}

export { BrowserEvaluateScriptBuilder, precheckBrowserInlineScriptSyntax }
