/**
 * 把不可信文本编成 JavaScript 字符串字面量，生成的脚本里不留任何源码元字符。
 *
 * 逐个 UTF-16 码元编码，孤立代理项也原样保住。
 */
export function encodeBrowserScriptStringLiteral(value: string): string {
  let literal = "'"
  for (let index = 0; index < value.length; index += 1) {
    literal += `\\u${value.charCodeAt(index).toString(16).padStart(4, '0')}`
  }
  return `${literal}'`
}
