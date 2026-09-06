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

function isAsciiIdentifierStart(character: LooseOptional<string>): boolean {
  if (!character) return false
  const code = character.charCodeAt(0)
  return character === '_' || character === '$'
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
}

function isAsciiDigit(character: LooseOptional<string>): boolean {
  if (!character) return false
  const code = character.charCodeAt(0)
  return code >= 48 && code <= 57
}

function isDigitForRadix(character: LooseOptional<string>, radix: 2 | 8 | 16): boolean {
  if (!character) return false
  const code = character.charCodeAt(0)
  if (code >= 48 && code < 48 + Math.min(radix, 10)) return true
  return radix === 16 && ((code >= 65 && code <= 70) || (code >= 97 && code <= 102))
}

function scanCodeNumberEnd(line: string, start: number, language: DiffCodeLanguage): number {
  let index = start
  if (line[index] === '-' || (language === 'css' && line[index] === '+')) index += 1

  if (
    language === 'javascript'
    && line[index] === '0'
    && (line[index + 1] === 'x' || line[index + 1] === 'X'
      || line[index + 1] === 'b' || line[index + 1] === 'B'
      || line[index + 1] === 'o' || line[index + 1] === 'O')
  ) {
    const marker = line[index + 1]?.toLowerCase()
    const radix = marker === 'x' ? 16 : marker === 'b' ? 2 : 8
    index += 2
    while (isDigitForRadix(line[index], radix)) index += 1
    if (line[index] === 'n') index += 1
    return index
  }

  while (isAsciiDigit(line[index])) index += 1
  if (line[index] === '.') {
    index += 1
    while (isAsciiDigit(line[index])) index += 1
  }

  if (line[index] === 'e' || line[index] === 'E') {
    let exponentEnd = index + 1
    if (line[exponentEnd] === '+' || line[exponentEnd] === '-') exponentEnd += 1
    const exponentStart = exponentEnd
    while (isAsciiDigit(line[exponentEnd])) exponentEnd += 1
    if (exponentEnd > exponentStart) index = exponentEnd
  }

  if (language === 'javascript' && line[index] === 'n') index += 1
  if (language === 'css') {
    while (isAsciiIdentifierStart(line[index]) || line[index] === '%' || line[index] === '-') index += 1
  }
  return index
}

function scanCssSelectorEnd(line: string, start: number): number {
  let index = start + 1
  while (
    isAsciiIdentifierStart(line[index])
    || isAsciiDigit(line[index])
    || line[index] === '-'
  ) index += 1
  return index
}

function scanCodeLineTokens(line: string, language: DiffCodeLanguage): Array<{ value: string; index: number }> {
  const scanned: Array<{ value: string; index: number }> = []
  const push = (start: number, end: number): void => {
    scanned.push({ value: line.slice(start, end), index: start })
  }
  let index = 0
  while (index < line.length) {
    const start = index
    const character = line[index] ?? ''

    if (/\s/u.test(character)) {
      while (index < line.length && /\s/u.test(line[index] ?? '')) index += 1
      push(start, index)
      continue
    }

    if (language === 'markup' && line.startsWith('<!--', index)) {
      const close = line.indexOf('-->', index + 4)
      index = close < 0 ? line.length : close + 3
      push(start, index)
      continue
    }
    if (language === 'markup' && line.slice(index, index + 9).toLowerCase() === '<!doctype') {
      const close = line.indexOf('>', index + 9)
      index = close < 0 ? line.length : close + 1
      push(start, index)
      continue
    }
    if ((language === 'javascript' || language === 'css') && line.startsWith('/*', index)) {
      const close = line.indexOf('*/', index + 2)
      index = close < 0 ? line.length : close + 2
      push(start, index)
      continue
    }
    if (language === 'javascript' && line.startsWith('//', index)) {
      push(start, line.length)
      break
    }
    if (
      language === 'shell'
      && character === '#'
      && (index === 0 || /\s/u.test(line[index - 1] ?? '') || '|&;(){}<>'.includes(line[index - 1] ?? ''))
    ) {
      push(start, line.length)
      break
    }

    const isQuoted = character === '"' || character === "'"
      || (language === 'javascript' && character === '`')
    if (isQuoted) {
      index += 1
      while (index < line.length) {
        if (line[index] === '\\') {
          index = Math.min(line.length, index + 2)
          continue
        }
        if (line[index] === character) {
          index += 1
          break
        }
        index += 1
      }
      push(start, index)
      continue
    }

    if (language === 'markup') {
      const punctuation = line.startsWith('</', index) || line.startsWith('/>', index)
        ? line.slice(index, index + 2)
        : '<>='.includes(character) ? character : ''
      if (punctuation) {
        index += punctuation.length
        push(start, index)
        continue
      }
    }

    if (
      language === 'css'
      && (character === '.' || character === '#')
      && (isAsciiIdentifierStart(line[index + 1])
        || (character === '#' && isAsciiDigit(line[index + 1]))
        || line[index + 1] === '-')
    ) {
      index = scanCssSelectorEnd(line, start)
      push(start, index)
      continue
    }

    const hasSignedNumber = (character === '-' && language !== 'javascript')
      || (character === '+' && language === 'css')
    if (isAsciiDigit(character)
      || (hasSignedNumber && (isAsciiDigit(line[index + 1])
        || (line[index + 1] === '.' && isAsciiDigit(line[index + 2]))))
      || (character === '.' && isAsciiDigit(line[index + 1]))) {
      index = scanCodeNumberEnd(line, start, language)
      push(start, index)
      continue
    }

    if (isAsciiIdentifierStart(character) || (language === 'css' && (character === '-' || character === '@'))) {
      index += 1
      while (index < line.length) {
        const next = line[index]
        if (!isAsciiIdentifierStart(next) && !isAsciiDigit(next)
          && !((language === 'css' || language === 'markup' || language === 'shell') && next === '-')
          && !(language === 'markup' && next === ':')
          && !(language === 'shell' && next === '#')) break
        index += 1
      }
      push(start, index)
      continue
    }

    if (language === 'shell' && !'|&;(){}<>'.includes(character)) {
      index += 1
      while (
        index < line.length
        && !/\s/u.test(line[index] ?? '')
        && !'|&;(){}<>'.includes(line[index] ?? '')
      ) index += 1
      push(start, index)
      continue
    }

    const operatorCharacters = language === 'javascript'
      ? '+-*/%=&|!<>~^'
      : language === 'shell' ? '|&;(){}<>' : ''
    if (operatorCharacters.includes(character)) {
      index += 1
      while (index < line.length && operatorCharacters.includes(line[index] ?? '')) index += 1
      push(start, index)
      continue
    }

    index += 1
    push(start, index)
  }
  return scanned
}

function tokenizeByScanner(
  line: string,
  language: DiffCodeLanguage,
  resolveKind: (value: string, index: number, line: string) => DiffCodeTokenKind
): DiffCodeToken[] {
  const tokens: DiffCodeToken[] = []

  for (const token of scanCodeLineTokens(line, language)) {
    pushToken(tokens, resolveKind(token.value, token.index, line), token.value)
  }

  return tokens
}

function tokenizeJavaScriptLine(line: string): DiffCodeToken[] {
  return tokenizeByScanner(line, 'javascript', (value, index, source) => {
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
  return tokenizeByScanner(line, 'json', (value, index, source) => {
    if (/^\s+$/u.test(value)) return 'plain'
    if (value.startsWith('"')) return readNextNonWhitespace(source, index + value.length) === ':' ? 'property' : 'string'
    if (/^-?\d/u.test(value)) return 'number'
    if (value === 'true' || value === 'false' || value === 'null') return 'keyword'
    if (/^[{}[\],:]$/u.test(value)) return 'punctuation'

    return 'plain'
  })
}

function tokenizeCssLine(line: string): DiffCodeToken[] {
  return tokenizeByScanner(line, 'css', (value, index, source) => {
    if (/^\s+$/u.test(value)) return 'plain'
    if (value.startsWith('/*')) return 'comment'
    if (value.startsWith('"') || value.startsWith("'")) return 'string'
    if (value.startsWith('@')) return 'keyword'
    if (/^[-+]?(?:\d*\.)?\d/u.test(value) || /^#[\da-fA-F]{3,8}\b/u.test(value)) return 'number'
    if (/^[{}:;(),.]$/u.test(value)) return 'punctuation'
    if (value.startsWith('.') || value.startsWith('#')) return 'tag'
    if (readNextNonWhitespace(source, index + value.length) === ':') return 'property'

    return 'plain'
  })
}

function tokenizeMarkupLine(line: string): DiffCodeToken[] {
  return tokenizeByScanner(line, 'markup', (value, index, source) => {
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
  return tokenizeByScanner(line, 'shell', (value) => {
    if (/^\s+$/u.test(value)) return 'plain'
    if (value.startsWith('#')) return 'comment'
    if (value.startsWith('"') || value.startsWith("'")) return 'string'
    if (value.startsWith('$')) return 'variable'
    if (/^--?[\w-]+$/u.test(value)) return 'attribute'
    if (/^\d/u.test(value)) return 'number'
    if (ShellKeywords.has(value)) return 'keyword'
    if (/^[|&;(){}<>]+$/u.test(value)) return 'operator'

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
