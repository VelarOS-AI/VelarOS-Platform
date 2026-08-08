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

/**
 * `simplify` 的深度上限。
 *
 * **这个数字必须与 {@link simplifyBrowserEvaluatedValue} 函数体里的字面量一致**——函数要被
 * `toString()` 内联进页面脚本，所以它不能引用模块作用域的常量。两者靠单测机械绑定
 * （`browser-evaluate-simplify.test.mjs` 用本常量构造恰好 N 层的对象验证边界）。
 *
 * 旧值是 4，正好卡在 `root → entity → components → transform → position` 这类三层嵌套的
 * 领域快照上：`position` 被替换成 `[object Object]`，坐标彻底读不出来。
 */
const BrowserEvaluateSimplifyMaxDepth = 8
/** 单个对象最多取多少个键 / 数组最多取多少项。同样与函数体字面量绑定。 */
const BrowserEvaluateSimplifyMaxEntries = 100

/**
 * 把页面里的 Element 压成可 JSON 化的描述。
 *
 * 与 {@link simplifyBrowserEvaluatedValue} 一样会被 `toString()` 内联进页面脚本，
 * 因此**不许引用任何模块作用域标识符**（常量、import、其它 helper 都不行）。
 */
function describeBrowserEvaluatedElement(node: any): any {
  if (typeof Element === 'undefined' || !(node instanceof Element)) return null
  const attributes: Record<string, string> = {}
  for (const attr of [
    'id',
    'class',
    'name',
    'type',
    'href',
    'role',
    'aria-label',
    'data-testid',
    'data-test',
    'data-qa',
  ]) {
    const value = node.getAttribute(attr)
    if (value) attributes[attr] = value
  }
  return {
    nodeType: 'Element',
    tagName: node.tagName.toLowerCase(),
    text: String(node.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500),
    attributes,
  }
}

/**
 * 把 evaluate 的返回值压成可 JSON 化的结构。
 *
 * ## 两条曾经的判决（别改回去）
 *
 * **① 环检测认「路径」不认「见过」。** 旧版用一个沿整棵树传递的 `WeakSet` 记录所有访问过的
 * 对象，于是**同一个对象被两个兄弟字段引用**（DAG，不是环）时，后到的那个被误判成
 * `'[Circular]'`。实测里 `entity.tags` 与 `entity.components.tags` 是同一个数组引用，
 * 后者就这么消失了。真正的环是「祖先里出现过自己」，所以这里维护一条**路径栈**：
 * 进对象前 push、出对象后 pop，兄弟之间互不影响。
 *
 * **② 标量分支必须排在深度检查之前。** 深度到顶时被替换掉的只能是容器；叶子标量在任何深度
 * 都要如实返回，否则「深处的一个数字」会变成 `[object Object]` 这种假值。当前顺序已经是对的，
 * 改动时别把深度检查提到前面去。
 *
 * 深度到顶返回 `'[Truncated Object]'` 这类**一眼能认出是截断标记**的字符串，而不是
 * `Object.prototype.toString.call(value)`——后者产出的 `'[object Object]'` 长得就像一个
 * 正常求值结果，模型会把它当成真值读，然后在原地打转。
 *
 * 会被 `toString()` 内联进页面脚本：**不许引用任何模块作用域标识符**。
 */
function simplifyBrowserEvaluatedValue(value: any, depth = 0, path: any[] = []): any {
  if (value === null || value === undefined) return value
  const type = typeof value
  // ——— 标量：永远在深度检查之前如实返回（判决②）———
  if (type === 'string' || type === 'number' || type === 'boolean') return value
  if (type === 'bigint' || type === 'symbol' || type === 'function') return String(value)
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack || null }
  if (typeof Element !== 'undefined' && value instanceof Element) return describeBrowserEvaluatedElement(value)
  if (typeof Node !== 'undefined' && value instanceof Node) return {
      nodeType: value.nodeType,
      nodeName: value.nodeName,
      text: String(value.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500),
    }
  if (type !== 'object') return String(value)

  // ——— 容器：先认环（判决①），再看深度 ———
  for (const ancestor of path) if (ancestor === value) return '[Circular]'
  if (depth >= 8) return `[Truncated ${Object.prototype.toString.call(value).slice(8, -1)}]`

  path.push(value)
  try {
    if (Array.isArray(value)) return value
        .slice(0, 100)
        .map((item) => simplifyBrowserEvaluatedValue(item, depth + 1, path))
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(value).slice(0, 100)) {
      try {
        output[key] = simplifyBrowserEvaluatedValue(value[key], depth + 1, path)
      } catch (error) {
        output[key] = error instanceof Error ? error.message : String(error)
      }
    }
    return output
  } finally {
    path.pop()
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
      // 这两个函数的**唯一定义**在本模块里（describeBrowserEvaluatedElement /
      // simplifyBrowserEvaluatedValue），这里靠 toString() 内联进页面——所以它们能被单测
      // 直接调用验证行为，而不是只能对脚本文本做正则断言。改那两个函数即改页面行为。
      const describeBrowserEvaluatedElement = ${describeBrowserEvaluatedElement.toString()}
      const simplifyBrowserEvaluatedValue = ${simplifyBrowserEvaluatedValue.toString()}
      const serialize = (value) => {
        const simplified = simplifyBrowserEvaluatedValue(value)
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

export {
  BrowserEvaluateScriptBuilder,
  BrowserEvaluateSimplifyMaxDepth,
  BrowserEvaluateSimplifyMaxEntries,
  describeBrowserEvaluatedElement,
  precheckBrowserInlineScriptSyntax,
  simplifyBrowserEvaluatedValue,
}
