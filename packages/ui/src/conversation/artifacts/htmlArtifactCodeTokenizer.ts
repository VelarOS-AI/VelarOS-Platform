export type HtmlArtifactCodeTokenKind =
  | 'Text'
  | 'Punctuation'
  | 'Tag'
  | 'Attr'
  | 'String'
  | 'Comment'
  | 'Doctype'
  | 'StyleSelector'
  | 'StyleProperty'
  | 'StyleValue'
  | 'StyleAtRule'
  | 'ScriptKeyword'
  | 'ScriptString'
  | 'ScriptNumber'
  | 'CodeComment'
  | 'CodePunctuation'

export interface HtmlArtifactCodeToken {
  kind: HtmlArtifactCodeTokenKind
  value: string
}

const CssTokenPattern =
  /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@[A-Za-z_-][\w-]*|#[\da-fA-F]{3,8}\b|[-+]?(?:\d*\.)?\d+(?:[a-z%]+)?\b|[{}:;(),]|[.#]?[A-Za-z_-][\w-]*(?=\s*\{)|[A-Za-z_-][\w-]*(?=\s*:)|[A-Za-z_-][\w-]*|\s+|./gu
const ScriptTokenPattern =
  /\/\/.*|\/\*[\s\S]*?\*\/|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:async|await|break|case|catch|class|const|continue|default|else|export|false|finally|for|from|function|if|import|in|instanceof|let|new|null|of|return|switch|this|throw|true|try|typeof|undefined|var|while|yield)\b|\b\d+(?:\.\d+)?\b|[{}()[\].,;:+\-*/%=!<>?&|]+|[A-Za-z_$][\w$]*|\s+|./gu
const ScriptKeywords = new Set([
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'else',
  'export',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'null',
  'of',
  'return',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'while',
  'yield',
])

function pushHtmlArtifactToken(
  tokens: HtmlArtifactCodeToken[],
  kind: HtmlArtifactCodeTokenKind,
  value: string
): void {
  if (value) tokens.push({ kind, value })
}

function isAsciiLetter(character: LooseOptional<string>): boolean {
  if (!character) return false
  const code = character.charCodeAt(0)
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function findNextHtmlTag(
  source: string,
  startIndex: number
): Nullable<{ start: number; end: number; segment: string }> {
  let searchFrom = startIndex
  while (searchFrom < source.length) {
    const start = source.indexOf('<', searchFrom)
    if (start < 0) return null

    if (source.startsWith('<!--', start)) {
      const commentEnd = source.indexOf('-->', start + 4)
      if (commentEnd < 0) return null
      const end = commentEnd + 3
      return { start, end, segment: source.slice(start, end) }
    }

    const doctypePrefix = source.slice(start, start + 9).toLowerCase()
    const nameStart = source[start + 1] === '/' ? start + 2 : start + 1
    if (doctypePrefix !== '<!doctype' && !isAsciiLetter(source[nameStart])) {
      searchFrom = start + 1
      continue
    }

    let quote: Nullable<string> = null
    for (let index = nameStart + 1; index < source.length; index += 1) {
      const character = source[index] ?? ''
      if (quote && character === quote) {
        quote = null
      } else if (!quote && (character === '"' || character === "'")) {
        quote = character
      } else if (!quote && character === '>') {
        const end = index + 1
        return { start, end, segment: source.slice(start, end) }
      } else if (!quote && character === '<') {
        break
      }
    }
    searchFrom = start + 1
  }
  return null
}

function readHtmlTagName(segment: string): string {
  return /^<\/?\s*([A-Za-z][\w:-]*)/u.exec(segment)?.[1]?.toLowerCase() ?? ''
}

function isOpeningHtmlTag(segment: string): boolean {
  return /^<\s*[A-Za-z]/u.test(segment) && !/\/\s*>$/u.test(segment)
}

function findClosingHtmlTag(
  source: string,
  tagName: string,
  startIndex: number
): Nullable<{ start: number; end: number; segment: string }> {
  const pattern = new RegExp(`</\\s*${tagName}\\s*>`, 'iu')
  const match = pattern.exec(source.slice(startIndex))
  if (!match?.[0]) return null

  const start = startIndex + match.index
  return {
    start,
    end: start + match[0].length,
    segment: match[0],
  }
}

function tokenizeHtmlArtifactTag(segment: string): HtmlArtifactCodeToken[] {
  if (segment.startsWith('<!--')) return [{ kind: 'Comment', value: segment }]
  if (/^<!doctype/i.test(segment)) return [{ kind: 'Doctype', value: segment }]

  const tokens: HtmlArtifactCodeToken[] = []
  const opening = /^<\/?/u.exec(segment)?.[0] ?? '<'
  let index = opening.length
  pushHtmlArtifactToken(tokens, 'Punctuation', opening)

  const tagName = /^[^\s/>]+/u.exec(segment.slice(index))?.[0] ?? ''
  pushHtmlArtifactToken(tokens, 'Tag', tagName)
  index += tagName.length

  while (index < segment.length) {
    const rest = segment.slice(index)
    const whitespace = /^\s+/u.exec(rest)?.[0]
    if (whitespace) {
      pushHtmlArtifactToken(tokens, 'Text', whitespace)
      index += whitespace.length
      continue
    }

    const punctuation = /^\/?>/u.exec(rest)?.[0]
    if (punctuation) {
      pushHtmlArtifactToken(tokens, 'Punctuation', punctuation)
      index += punctuation.length
      continue
    }

    if (rest.startsWith('=')) {
      pushHtmlArtifactToken(tokens, 'Punctuation', '=')
      index += 1
      continue
    }

    const quotedValue = /^"[^"]*"|^'[^']*'/u.exec(rest)?.[0]
    if (quotedValue) {
      pushHtmlArtifactToken(tokens, 'String', quotedValue)
      index += quotedValue.length
      continue
    }

    const bareValue = /^[^\s/>=]+/u.exec(rest)?.[0]
    if (bareValue) {
      const previousToken = tokens.at(-1)
      pushHtmlArtifactToken(tokens, previousToken?.value === '=' ? 'String' : 'Attr', bareValue)
      index += bareValue.length
      continue
    }

    pushHtmlArtifactToken(tokens, 'Punctuation', segment[index] ?? '')
    index += 1
  }

  return tokens
}

function readNextNonWhitespace(source: string, index: number): string {
  return /\S/u.exec(source.slice(index))?.[0] ?? ''
}

function tokenizeStyleContent(source: string): HtmlArtifactCodeToken[] {
  const tokens: HtmlArtifactCodeToken[] = []
  CssTokenPattern.lastIndex = 0

  for (const match of source.matchAll(CssTokenPattern)) {
    const value = match[0]
    const index = match.index ?? 0
    const next = readNextNonWhitespace(source, index + value.length)

    if (/^\s+$/u.test(value)) pushHtmlArtifactToken(tokens, 'Text', value)
    else if (value.startsWith('/*')) pushHtmlArtifactToken(tokens, 'CodeComment', value)
    else if (value.startsWith('"') || value.startsWith("'")) pushHtmlArtifactToken(tokens, 'String', value)
    else if (value.startsWith('@')) pushHtmlArtifactToken(tokens, 'StyleAtRule', value)
    else if (/^[{}:;(),]$/u.test(value)) pushHtmlArtifactToken(tokens, 'CodePunctuation', value)
    else if (/^[-+]?(?:\d*\.)?\d/u.test(value) || /^#[\da-fA-F]{3,8}\b/u.test(value)) {
      pushHtmlArtifactToken(tokens, 'StyleValue', value)
    } else if (next === '{' || /^[.#]/u.test(value)) {
      pushHtmlArtifactToken(tokens, 'StyleSelector', value)
    } else if (next === ':') {
      pushHtmlArtifactToken(tokens, 'StyleProperty', value)
    } else {
      pushHtmlArtifactToken(tokens, 'StyleValue', value)
    }
  }

  return tokens
}

function tokenizeScriptContent(source: string): HtmlArtifactCodeToken[] {
  const tokens: HtmlArtifactCodeToken[] = []
  ScriptTokenPattern.lastIndex = 0

  for (const match of source.matchAll(ScriptTokenPattern)) {
    const value = match[0]

    if (/^\s+$/u.test(value)) pushHtmlArtifactToken(tokens, 'Text', value)
    else if (value.startsWith('//') || value.startsWith('/*')) {
      pushHtmlArtifactToken(tokens, 'CodeComment', value)
    } else if (value.startsWith('"') || value.startsWith("'") || value.startsWith('`')) {
      pushHtmlArtifactToken(tokens, 'ScriptString', value)
    } else if (/^\d/u.test(value)) {
      pushHtmlArtifactToken(tokens, 'ScriptNumber', value)
    } else if (/^[{}()[\].,;:+\-*/%=!<>?&|]+$/u.test(value)) {
      pushHtmlArtifactToken(tokens, 'CodePunctuation', value)
    } else if (ScriptKeywords.has(value)) {
      pushHtmlArtifactToken(tokens, 'ScriptKeyword', value)
    } else {
      pushHtmlArtifactToken(tokens, 'Text', value)
    }
  }

  return tokens
}

function tokenizeEmbeddedHtmlCode(tagName: string, source: string): HtmlArtifactCodeToken[] {
  return tagName === 'style' ? tokenizeStyleContent(source) : tokenizeScriptContent(source)
}

export function tokenizeHtmlArtifactSource(source: string): HtmlArtifactCodeToken[] {
  const tokens: HtmlArtifactCodeToken[] = []
  let cursor = 0

  while (cursor < source.length) {
    const match = findNextHtmlTag(source, cursor)
    if (!match) {
      pushHtmlArtifactToken(tokens, 'Text', source.slice(cursor))
      break
    }

    const { segment, start } = match
    pushHtmlArtifactToken(tokens, 'Text', source.slice(cursor, start))
    tokens.push(...tokenizeHtmlArtifactTag(segment))
    cursor = match.end

    const tagName = readHtmlTagName(segment)
    if ((tagName === 'style' || tagName === 'script') && isOpeningHtmlTag(segment)) {
      const closing = findClosingHtmlTag(source, tagName, cursor)
      const embeddedEnd = closing?.start ?? source.length
      tokens.push(...tokenizeEmbeddedHtmlCode(tagName, source.slice(cursor, embeddedEnd)))

      if (!closing) {
        cursor = source.length
        break
      }

      tokens.push(...tokenizeHtmlArtifactTag(closing.segment))
      cursor = closing.end
    }
  }

  return tokens
}
