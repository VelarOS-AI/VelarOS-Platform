/**
 * .gitignore 一行的解析：规整转义、把一行展开成相对规则根的 glob。
 */

import { normalizeRelativePath } from './path.js'

/** 修掉一行的边角：去掉行尾的 CR、开头的空白和没转义的尾随空格；转义还留着（`#`、`!` 的判定要看有没有转义）。 */
export function trimGitignoreLine(line: string): string {
  let value = line.replace(/\r$/, '').trimStart()
  while (value.endsWith(' ') && !value.endsWith('\\ ')) {
    value = value.slice(0, -1)
  }
  return value
}

/** 还原一行里的 `\ `、`\#`、`\!` 三种转义；要在判完注释与取反之后才做，不然 `\#foo` 会被当成注释。 */
export function unescapeGitignoreLine(line: string): string {
  return line.replace(/\\ /g, ' ').replace(/\\#/g, '#').replace(/\\!/g, '!')
}

/** 把规则接到 .gitignore 所在目录下面；在规则根时原样返回。 */
function withBase(baseRelativePath: string, pattern: string): string {
  return normalizeRelativePath(baseRelativePath ? `${baseRelativePath}/${pattern}` : pattern)
}

/**
 * 把一条 .gitignore 规则展开成相对规则根的 glob：以 `/` 开头或中间含 `/` 的只在所在目录下匹配，
 * 其余在任意层级匹配。「目录被忽略则里面的一切跟着被忽略」不在这里展开，判定时按各级上级目录推。
 */
export function buildGitignorePatterns(pattern: string, baseRelativePath: string): string[] {
  const anchored = pattern.startsWith('/')
  const body = normalizeRelativePath(pattern.replace(/^\/+/, ''))
  if (!body) return []

  if (anchored || body.includes('/')) return [withBase(baseRelativePath, body)]
  return baseRelativePath
    ? [withBase(baseRelativePath, body), withBase(baseRelativePath, `**/${body}`)]
    : [body, `**/${body}`]
}
