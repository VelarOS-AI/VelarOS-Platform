/**
 * .gitignore 一行的解析：规整转义、把一行展开成相对规则根的 glob。
 */

import picomatch from 'picomatch'

/** 规则使用 `/` 分隔的相对路径；只去包装分隔符，POSIX 文件名里的反斜杠保留为字面字符。 */
export function normalizeGitignorePath(path: string): string {
  const normalized = path.replace(/^\.\//u, '').replace(/\/$/u, '')
  return normalized === '.' ? '' : normalized
}

/** 去掉行尾 CR 与未转义的尾随空格；前导空格和转义保留，供后续按 Git 规则解释。 */
export function trimGitignoreLine(line: string): string {
  let value = line.replace(/\r$/, '')
  while (value.endsWith(' ')) {
    let backslashes = 0
    for (let index = value.length - 2; index >= 0 && value[index] === '\\'; index--) backslashes++
    if (backslashes % 2 !== 0) break
    value = value.slice(0, -1)
  }
  return value
}

/** 把实际目录名或转义字符交给 glob 时保持字面含义，避免把目录名里的方括号当规则。 */
function escapeGlobLiteral(value: string): string {
  return value.replace(/[\\*?[\]{}()!"^$+|-]/gu, '\\$&')
}

/** 把规则接到 .gitignore 所在目录下面；在规则根时原样返回。 */
function withBase(baseRelativePath: string, pattern: string): string {
  return baseRelativePath ? `${escapeGlobLiteral(baseRelativePath)}/${pattern}` : pattern
}

/**
 * 把一条 .gitignore 规则展开成相对规则根的 glob：以 `/` 开头或中间含 `/` 的只在所在目录下匹配，
 * 其余在任意层级匹配。「目录被忽略则里面的一切跟着被忽略」不在这里展开，判定时按各级上级目录推。
 */
export function buildGitignorePatterns(pattern: string, baseRelativePath: string): string[] {
  const anchored = pattern.startsWith('/')
  const body = anchored ? pattern.slice(1) : pattern
  if (!body) return []

  if (anchored || body.includes('/')) return [withBase(baseRelativePath, body)]
  return baseRelativePath
    ? [withBase(baseRelativePath, body), withBase(baseRelativePath, `**/${body}`)]
    : [body, `**/${body}`]
}

/** 编译 Git 的完整路径模式：保留 fnmatch 通配，字面引号、括号等不参与 shell/glob 扩展。 */
export function compileGitignorePattern(pattern: string): (path: string) => boolean {
  let glob = ''
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!
    if (character === '\\') {
      const literal = pattern[++index]
      // Git 中结尾的孤立反斜杠是无效模式，不能偷偷改成匹配字面反斜杠。
      if (literal === undefined) return () => false
      glob += escapeGlobLiteral(literal)
    } else {
      glob += /["(){}|+]/u.test(character) ? `\\${character}` : character
    }
  }
  // picomatch 的匹配函数先以 input === glob 放行，字符类会被误当成同名的字面路径。
  // Git 规则始终走编译结果，不采用该快捷判断。
  const matcher = picomatch.makeRe(glob, {
    dot: true,
    fastpaths: false,
    literalBrackets: false,
    nobrace: true,
    noextglob: true,
    nonegate: true,
    posix: true,
    regex: false,
    strictSlashes: true,
    windows: false,
  })
  return (path) => matcher.test(path)
}
