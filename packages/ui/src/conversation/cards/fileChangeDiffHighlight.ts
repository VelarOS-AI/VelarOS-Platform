export type DiffCodeLanguage = 'css' | 'javascript' | 'json' | 'markup' | 'shell' | 'text'

export type DiffCodeTokenKind =
  | 'attribute'
  | 'comment'
  | 'function'
  | 'keyword'
  | 'number'
  | 'operator'
  | 'plain'
  | 'property'
  | 'punctuation'
  | 'string'
  | 'tag'
  | 'type'
  | 'variable'

export interface DiffCodeToken {
  kind: DiffCodeTokenKind
  text: string
}

const JavaScriptExtensions = new Set([
  'cjs',
  'cts',
  'js',
  'jsx',
  'mjs',
  'mts',
  'ts',
  'tsx',
])
const JsonExtensions = new Set(['json', 'json5', 'jsonc', 'jsonl'])
const CssExtensions = new Set(['css', 'less', 'sass', 'scss'])
const MarkupExtensions = new Set(['astro', 'htm', 'html', 'svelte', 'svg', 'vue', 'xml'])
const ShellExtensions = new Set(['bash', 'env', 'fish', 'sh', 'zsh'])

const JavaScriptKeywords = new Set([
  'abstract',
  'as',
  'asserts',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'constructor',
  'continue',
  'debugger',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'infer',
  'instanceof',
  'interface',
  'is',
  'keyof',
  'let',
  'module',
  'namespace',
  'new',
  'null',
  'of',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'satisfies',
  'set',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'var',
  'while',
  'with',
  'yield',
])

const JavaScriptTypes = new Set([
  'Array',
  'Promise',
  'ReadonlyArray',
  'Record',
  'any',
  'bigint',
  'boolean',
  'never',
  'number',
  'object',
  'string',
  'symbol',
  'unknown',
  'void',
])

const ShellKeywords = new Set([
  'case',
  'cd',
  'do',
  'done',
  'echo',
  'elif',
  'else',
  'esac',
  'export',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'local',
  'pwd',
  'readonly',
  'then',
  'while',
])

const JavaScriptTokenPattern =
  /\/\/.*|\/\*.*?\*\/|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?n?)\b|\b[A-Za-z_$][\w$]*\b|=>|===|!==|==|!=|<=|>=|\+\+|--|&&|\|\||[{}()[\].,;:?]|[+\-*/%=&|!<>~^]+|\s+|./giu
const JsonTokenPattern =
  /"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b(?:false|null|true)\b|[{}[\],:]|\s+|./giu
const CssTokenPattern =
  /\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@[A-Za-z_-][\w-]*|#[\da-fA-F]{3,8}\b|[-+]?(?:\d*\.)?\d+(?:[a-z%]+)?\b|[{}:;(),.]|[-_A-Za-z][\w-]*(?=\s*:)|[.#]?[-_A-Za-z][\w-]*|\s+|./giu
const MarkupTokenPattern =
  /<!--.*?-->|<!doctype.*?>|<\/?|\/?>|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z][\w:-]*(?=\s*=)|[A-Za-z][\w:-]*|=|\s+|./giu
const ShellTokenPattern =
  /#.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\$[A-Za-z_][\w]*|--?[\w-]+|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w-]*\b|[|&;(){}<>]|[^\s|&;(){}<>]+|\s+|./gu

function getPathExtension(path: string): string {
  const cleanPath = path.split(/[?#]/u)[0] ?? path
  const baseName = cleanPath.split(/[\\/]/u).at(-1)?.toLowerCase() ?? cleanPath.toLowerCase()

  switch (baseName) {
    case 'dockerfile':
      return 'dockerfile'
    case 'makefile':
      return 'makefile'
  }

  const index = baseName.lastIndexOf('.')
  return index > 0 ? baseName.slice(index + 1) : baseName
}

export function inferDiffCodeLanguageFromPath(path: string): DiffCodeLanguage {
  const extension = getPathExtension(path)

  if (JavaScriptExtensions.has(extension)) return 'javascript'
  if (JsonExtensions.has(extension)) return 'json'
  if (CssExtensions.has(extension)) return 'css'
  if (MarkupExtensions.has(extension)) return 'markup'
  if (ShellExtensions.has(extension) || extension === 'dockerfile' || extension === 'makefile') return 'shell'

  return 'text'
}

function pushToken(tokens: DiffCodeToken[], kind: DiffCodeTokenKind, text: string): void {
  if (!text) return

  const previous = tokens.at(-1)
  if (previous?.kind === kind) {
    previous.text += text
    return
  }

  tokens.push({ kind, text })
}

function readPreviousNonWhitespace(text: string, index: number): string {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const character = text[cursor] ?? ''
    if (!/\s/u.test(character)) return character
  }

  return ''
}

function readNextNonWhitespace(text: string, index: number): string {
  for (let cursor = index; cursor < text.length; cursor += 1) {
    const character = text[cursor] ?? ''
    if (!/\s/u.test(character)) return character
  }

  return ''
}

function tokenizeByPattern(
  line: string,
  pattern: RegExp,
  resolveKind: (value: string, index: number, line: string) => DiffCodeTokenKind
): DiffCodeToken[] {
  const tokens: DiffCodeToken[] = []

  pattern.lastIndex = 0
  for (const match of line.matchAll(pattern)) {
    const value = match[0]
    pushToken(tokens, resolveKind(value, match.index ?? 0, line), value)
  }

  return tokens
}

function tokenizeJavaScriptLine(line: string): DiffCodeToken[] {
  return tokenizeByPattern(line, JavaScriptTokenPattern, (value, index, source) => {
    if (/^\s+$/u.test(value)) return 'plain'
    if (value.startsWith('//') || value.startsWith('/*')) return 'comment'
    if (value.startsWith('"') || value.startsWith("'") || value.startsWith('`')) return 'string'
    if (/^(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d)/u.test(value)) return 'number'
    if (JavaScriptKeywords.has(value)) return 'keyword'
    if (JavaScriptTypes.has(value)) return 'type'
    if (/^[A-Za-z_$]/u.test(value)) {
      const previous = readPreviousNonWhitespace(source, index)
      const next = readNextNonWhitespace(source, index + value.length)

      if (previous === '.') return 'property'

      switch (next) {
        case '(':
          return 'function'
        case ':':
          return 'property'
      }

      return 'plain'
    }
    if (/^[{}()[\].,;:?]$/u.test(value)) return 'punctuation'
    if (/^(?:=>|===|!==|==|!=|<=|>=|\+\+|--|&&|\|\||[+\-*/%=&|!<>~^]+)$/u.test(value)) return 'operator'

    return 'plain'
  })
}

function tokenizeJsonLine(line: string): DiffCodeToken[] {
  return tokenizeByPattern(line, JsonTokenPattern, (value, index, source) => {
    if (/^\s+$/u.test(value)) return 'plain'
    if (value.startsWith('"')) return readNextNonWhitespace(source, index + value.length) === ':' ? 'property' : 'string'
    if (/^-?\d/u.test(value)) return 'number'
    if (value === 'true' || value === 'false' || value === 'null') return 'keyword'
    if (/^[{}[\],:]$/u.test(value)) return 'punctuation'

    return 'plain'
  })
}

function tokenizeCssLine(line: string): DiffCodeToken[] {
  return tokenizeByPattern(line, CssTokenPattern, (value, index, source) => {
    if (/^\s+$/u.test(value)) return 'plain'
    if (value.startsWith('/*')) return 'comment'
    if (value.startsWith('"') || value.startsWith("'")) return 'string'
    if (value.startsWith('@')) return 'keyword'
    if (/^[-+]?(?:\d*\.)?\d/u.test(value) || /^#[\da-fA-F]{3,8}\b/u.test(value)) return 'number'
    if (/^[{}:;(),.]$/u.test(value)) return 'punctuation'
    if (readNextNonWhitespace(source, index + value.length) === ':') return 'property'
    if (value.startsWith('.') || value.startsWith('#')) return 'tag'

    return 'plain'
  })
}

function tokenizeMarkupLine(line: string): DiffCodeToken[] {
  return tokenizeByPattern(line, MarkupTokenPattern, (value, index, source) => {
    if (/^\s+$/u.test(value)) return 'plain'
    if (value.startsWith('<!--')) return 'comment'
    if (/^<!doctype/i.test(value)) return 'keyword'
    if (value.startsWith('"') || value.startsWith("'")) return 'string'
    if (value === '<' || value === '</' || value === '>' || value === '/>' || value === '=') return 'punctuation'
    if (readPreviousNonWhitespace(source, index) === '<' || readPreviousNonWhitespace(source, index) === '/') return 'tag'
    if (readNextNonWhitespace(source, index + value.length) === '=') return 'attribute'

    return 'plain'
  })
}

function tokenizeShellLine(line: string): DiffCodeToken[] {
  return tokenizeByPattern(line, ShellTokenPattern, (value) => {
    if (/^\s+$/u.test(value)) return 'plain'
    if (value.startsWith('#')) return 'comment'
    if (value.startsWith('"') || value.startsWith("'")) return 'string'
    if (value.startsWith('$')) return 'variable'
    if (/^--?[\w-]+$/u.test(value)) return 'attribute'
    if (/^\d/u.test(value)) return 'number'
    if (ShellKeywords.has(value)) return 'keyword'
    if (/^[|&;(){}<>]$/u.test(value)) return 'operator'

    return 'plain'
  })
}

export function tokenizeDiffCodeLine(line: string, language: DiffCodeLanguage): DiffCodeToken[] {
  if (!line) return [{ kind: 'plain', text: ' ' }]

  switch (language) {
    case 'css':
      return tokenizeCssLine(line)
    case 'javascript':
      return tokenizeJavaScriptLine(line)
    case 'json':
      return tokenizeJsonLine(line)
    case 'markup':
      return tokenizeMarkupLine(line)
    case 'shell':
      return tokenizeShellLine(line)
    case 'text':
    default:
      return [{ kind: 'plain', text: line }]
  }
}
