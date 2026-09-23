import type { BrowserEvaluateScriptOptions } from '../../types/browser'
import { clampInteger } from '../numbers.js'

/** 页面脚本在求值源码里的文件名：出错时栈里的行列按它认出来，再换算成 script 里的行列。 */
const EvaluateSourceUrl = 'velaros-evaluate.js'

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
 * 把页面里的 Element 压成可 JSON 化的描述。
 *
 * 与 {@link toJsonSafeValue} 一样会被 `toString()` 内联进页面脚本，
 * 因此**不许引用任何模块作用域标识符**（常量、import、其它 helper 都不行）。
 */
function describeBrowserEvaluatedElement(node: any): any {
  // @arch-guard:suspend code-style/forbid-redundant-strict-literal-comparison 理由：本函数被 toString() 内联进页面执行，core 原语在页面上下文不存在；且这是「页面有没有 DOM」的能力探测，isPresent 表达不了。
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
 * 把页面脚本的返回值变成能整份 JSON 化的样子，**不截断**：数组、对象多大取多大，要多少由脚本自己切；
 * 只守住内存的那道上限在外面按 JSON 长度核。
 *
 * - DOM 元素与节点换成它的描述（标签、属性、前 500 字文本）；Error 换成 name、message、stack；bigint、symbol 换成字符串。
 * - 有 `toJSON` 的（Date、URL）照它来，与 JSON.stringify 一个口径。
 * - **环检测认「路径」不认「见过」**：同一个对象被两个兄弟字段引用（DAG，不是环）照样两处都在；
 *   只有祖先里出现过自己才写成 `'[Circular]'`。进对象前 push、出对象后 pop。
 * - 读某个键时抛错（getter）不让整次求值失败：那个键的值写成错误说明。
 *
 * 会被 `toString()` 内联进页面脚本：**不许引用任何模块作用域标识符**。
 */
function toJsonSafeValue(value: any, path: any[] = []): any {
  // @arch-guard:suspend code-style/forbid-redundant-strict-literal-comparison 理由：本函数被 toString() 内联进页面执行，core 原语在页面上下文不存在；且 null 与 undefined 要原样回传（两者在求值结果里语义不同），不能并成 isPresent。
  if (value === null || value === undefined) return value
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return value
  if (type === 'bigint' || type === 'symbol') return String(value)
  if (type === 'function') return undefined
  if (value instanceof Error)
    return { name: value.name, message: value.message, stack: value.stack || null }
  // @arch-guard:suspend code-style/forbid-redundant-strict-literal-comparison 理由：同上，页面内联 + DOM 能力探测。
  if (typeof Element !== 'undefined' && value instanceof Element)
    return describeBrowserEvaluatedElement(value)
  // @arch-guard:suspend code-style/forbid-redundant-strict-literal-comparison 理由：同上，页面内联 + DOM 能力探测。
  if (typeof Node !== 'undefined' && value instanceof Node)
    return {
      nodeType: value.nodeType,
      nodeName: value.nodeName,
      text: String(value.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500),
    }
  if (type !== 'object') return String(value)
  // @arch-guard:suspend code-style/forbid-raw-runtime-type-guards 理由：本函数被 toString() 内联进页面执行，isFunction 在页面上下文不存在。
  if (typeof value.toJSON === 'function') return toJsonSafeValue(value.toJSON(), path)

  for (const ancestor of path) if (ancestor === value) return '[Circular]'
  path.push(value)
  try {
    // @arch-guard:suspend code-style/forbid-raw-runtime-type-guards 理由：页面内联，isArray 在页面上下文不存在。
    if (Array.isArray(value))
      return value.map((item) => {
        const converted = toJsonSafeValue(item, path)
        // @arch-guard:suspend code-style/forbid-nullish-churn 理由：页面内联，toNullable 在页面上下文不存在；数组里的 undefined 按 JSON 的规矩写成 null。
        return converted === undefined ? null : converted
      })
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      try {
        const converted = toJsonSafeValue(value[key], path)
        if (converted !== undefined) output[key] = converted
        // @arch-guard:suspend code-style/require-error-logging 理由：错误没有被吞——它被写进 output[key] 成为该字段的值回传给调用方，这正是「取不到就说出来」的出声方式；页面内联无 Log 可用，抛出则会让整次求值失败。
      } catch (error) {
        output[key] = error instanceof Error ? error.message : String(error)
      }
    }
    return output
  } finally {
    path.pop()
  }
}

/**
 * 构建页面脚本的求值源码：script 是一个表达式，求出来是函数就用 args 调它，是 Promise 就等它；
 * 结果按 JSON 整份取回，超过 maxResultChars 只回它的长度；页面里抛错回错误名、原话与它在 script 里的行列。
 *
 * 用户脚本直接内联进 executeJavaScript 的源码：不能在页面里 new Function/eval——那会撞上站点 CSP 的 unsafe-eval
 * （HN 等严格 CSP 站点直接拒绝），而 executeJavaScript 本身不受页面 CSP 限制。语法错误在主进程先编译一遍拦下，不拼进去。
 */
export function buildEvaluateScript(options: BrowserEvaluateScriptOptions): string {
  const syntaxError = precheckBrowserInlineScriptSyntax(`return (\n${options.script}\n);`)
  if (syntaxError)
    return `({ url: location.href, ok: false, error: { name: 'SyntaxError', message: ${JSON.stringify(syntaxError)} } })`

  const head = `(async () => {
  const __velarosEvaluate = async (...args) => {
    let value = (
`
  const payload = JSON.stringify({
    args: options.args ?? [],
    timeoutMs: clampInteger(options.timeoutMs, 1, 30_000, 5_000),
    maxResultChars: options.maxResultChars,
    // script 的第一行落在求值源码的第几行：出错时栈里的行号减掉它就是 script 里的行号。
    scriptLine: head.split('\n').length,
    scriptLines: options.script.split('\n').length,
    sourceUrl: EvaluateSourceUrl,
  })

  return `${head}${options.script}
    )
    if (typeof value === 'function') value = value(...args)
    return await value
  }
  const payload = ${payload}
  const describeBrowserEvaluatedElement = ${describeBrowserEvaluatedElement.toString()}
  const toJsonSafeValue = ${toJsonSafeValue.toString()}
  const locate = (error) => {
    const escaped = payload.sourceUrl.replace(/[.]/g, '\\\\.')
    const match = String((error && error.stack) || '').match(new RegExp(escaped + ':(\\\\d+):(\\\\d+)'))
    if (!match) return {}
    const line = Number(match[1]) - payload.scriptLine + 1
    return line >= 1 && line <= payload.scriptLines ? { line, column: Number(match[2]) } : {}
  }
  let timeoutHandle
  try {
    const value = await Promise.race([
      __velarosEvaluate(...payload.args),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('页面脚本执行超时（' + payload.timeoutMs + ' 毫秒）')), payload.timeoutMs)
      }),
    ])
    const json = JSON.stringify(toJsonSafeValue(value))
    if (json === undefined) return { url: location.href, ok: true }
    if (json.length > payload.maxResultChars) return { url: location.href, ok: false, tooLargeChars: json.length }
    return { url: location.href, ok: true, json }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    return { url: location.href, ok: false, error: { name: failure.name || 'Error', message: failure.message, ...locate(failure) } }
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
})()
//# sourceURL=${EvaluateSourceUrl}`
}

export { describeBrowserEvaluatedElement, precheckBrowserInlineScriptSyntax, toJsonSafeValue }
