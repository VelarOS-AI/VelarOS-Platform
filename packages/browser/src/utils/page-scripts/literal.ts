/**
 * Encodes untrusted text as a JavaScript string literal without leaving any
 * source-code metacharacters in the generated script. Encoding every UTF-16
 * code unit also preserves lone surrogates exactly.
 */
export function encodeBrowserScriptStringLiteral(value: string): string {
  let literal = "'"
  for (let index = 0; index < value.length; index += 1) {
    literal += `\\u${value.charCodeAt(index).toString(16).padStart(4, '0')}`
  }
  return `${literal}'`
}
