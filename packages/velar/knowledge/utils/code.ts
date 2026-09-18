/**
 * 面向知识索引流水线的轻量代码分析：判定代码文件、正则扫符号、扫 import、给路径打分。
 *
 * 这里刻意不依赖工作区内核的适配器体系：索引流水线要同步批量扫大量文件，内核适配器偏交互式编辑。
 */

import { dirname, join, relative, resolve } from 'node:path'

import { isEmpty, toNullable } from '@velaros-ai/core'

import type { KnowledgeCodeImportRecord, KnowledgeCodeSymbol } from '../types/code.js'

/** 认作代码文件的扩展名名单，跟着「什么算代码」这条规则一起改。 */
const CodeExtensions = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'rb', 'php', 'swift', 'kt',
])

/** 正则扫符号的模式名单：一行一种声明形态，够支撑索引与符号提示。 */
const SymbolPatterns: Array<{ pattern: RegExp; kind: KnowledgeCodeSymbol['kind'] }> = [
  { pattern: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m, kind: 'function' },
  { pattern: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m, kind: 'class' },
  { pattern: /^(?:export\s+)?interface\s+(\w+)/m, kind: 'interface' },
  { pattern: /^(?:export\s+)?type\s+(\w+)\s*[=<]/m, kind: 'type' },
  { pattern: /^(?:export\s+)?enum\s+(\w+)/m, kind: 'enum' },
  { pattern: /^(?:export\s+)?(?:const|let|var)\s+(\w+)/m, kind: 'variable' },
]

/** 缓冲区看起来像不像文本文件：开头一段里没有空字节就算是。 */
export function isLikelyTextFile(buffer: Buffer): boolean {
  // 只看开头 512 字节：二进制文件几乎总在文件头就带空字节，整文件扫描不值当。
  const sample = buffer.subarray(0, Math.min(512, buffer.length))
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return false
  }
  return true
}

/** 列出认作代码文件的扩展名；给了 filter 就只保留其中认识的那些。 */
export function getCodeExtensions(filter?: string[]): string[] {
  if (filter && !isEmpty(filter)) return filter.filter((e) => CodeExtensions.has(e))
  return [...CodeExtensions]
}

/** 这个路径算不算代码文件。 */
export function isCodeFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return CodeExtensions.has(ext)
}

/** 从源码里正则扫出符号，非代码文件返回空。 */
export function extractSymbols(filePath: string, content: string): KnowledgeCodeSymbol[] {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  if (!CodeExtensions.has(ext)) return []

  const symbols: KnowledgeCodeSymbol[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const { pattern, kind } of SymbolPatterns) {
      const m = line.match(pattern)
      if (m?.[1]) {
        symbols.push({
          name: m[1],
          kind,
          path: filePath,
          line: i + 1,
          column: line.indexOf(m[1]) + 1,
          exported: line.includes('export '),
        })
      }
    }
  }
  return symbols
}

/** 把一行里的注释涂成空白，返回涂过的行和这一行结束时还在不在块注释里。 */
function maskJavaScriptComments(
  line: string,
  startsInBlockComment: boolean,
): { line: string; endsInBlockComment: boolean } {
  let masked = ''
  let quote: Nullable<string> = null
  let inBlockComment = startsInBlockComment
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? ''
    const next = line[index + 1]
    if (inBlockComment) {
      if (character === '*' && next === '/') {
        masked += '  '
        index += 1
        inBlockComment = false
      } else {
        masked += ' '
      }
      continue
    }
    if (quote) {
      masked += character
      if (character === '\\' && next) {
        masked += next
        index += 1
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      masked += character
      continue
    }
    if (character === '/' && next === '/') {
      masked += ' '.repeat(line.length - index)
      break
    }
    if (character === '/' && next === '*') {
      masked += '  '
      index += 1
      inBlockComment = true
      continue
    }
    masked += character
  }
  return { line: masked, endsInBlockComment: inBlockComment }
}

/** 从某个位置开始跳过空白，返回第一个非空白字符的下标。 */
function skipImportWhitespace(line: string, start: number): number {
  let index = start
  while (index < line.length && /\s/u.test(line[index] ?? '')) index += 1
  return index
}

/** 读一段带引号的模块说明符，读不成返回 null。 */
function readQuotedSpecifierAt(line: string, start: number): Nullable<{ value: string; end: number }> {
  const quote = line[start]
  if (quote !== '"' && quote !== "'") return null
  for (let index = start + 1; index < line.length; index += 1) {
    if (line[index] === '\\') return null
    if (line[index] === quote) {
      const value = line.slice(start + 1, index)
      return value ? { value, end: index + 1 } : null
    }
  }
  return null
}

/** 读 `* as X` 这种命名空间绑定，返回它结束的位置。 */
function readNamespaceBindingEnd(line: string, start: number): Nullable<number> {
  if (line[start] !== '*') return null
  let cursor = skipImportWhitespace(line, start + 1)
  if (!line.startsWith('as', cursor) || !/\s/u.test(line[cursor + 2] ?? '')) return null
  cursor = skipImportWhitespace(line, cursor + 2)
  const aliasStart = cursor
  while (cursor < line.length && !/[\s,;]/u.test(line[cursor] ?? '')) cursor += 1
  return cursor === aliasStart ? null : cursor
}

/** 从 `import` 之后的位置读出这一行导入的模块说明符。 */
function readImportSpecifier(line: string, bodyStart: number): Nullable<string> {
  let cursor = bodyStart
  if (line.startsWith('type', cursor) && /\s/u.test(line[cursor + 'type'.length] ?? ''))
    cursor = skipImportWhitespace(line, cursor + 'type'.length)

  if (line[cursor] === '{') {
    const bindingsEnd = line.indexOf('}', cursor + 1)
    if (bindingsEnd < 0) return null
    cursor = bindingsEnd + 1
  } else if (line[cursor] === '*') {
    const namespaceEnd = readNamespaceBindingEnd(line, cursor)
    if (!namespaceEnd) return null
    cursor = namespaceEnd
  } else {
    const defaultBindingStart = cursor
    while (cursor < line.length && !/[\s,;]/u.test(line[cursor] ?? '')) cursor += 1
    if (cursor === defaultBindingStart) return null
    cursor = skipImportWhitespace(line, cursor)
    if (line[cursor] === ',') {
      cursor = skipImportWhitespace(line, cursor + 1)
      if (line[cursor] === '{') {
        const bindingsEnd = line.indexOf('}', cursor + 1)
        if (bindingsEnd < 0) return null
        cursor = bindingsEnd + 1
      } else {
        const namespaceEnd = readNamespaceBindingEnd(line, cursor)
        if (!namespaceEnd) return null
        cursor = namespaceEnd
      }
    }
  }

  cursor = skipImportWhitespace(line, cursor)
  if (!line.startsWith('from', cursor) || !/\s/u.test(line[cursor + 'from'.length] ?? ''))
    return null
  cursor = skipImportWhitespace(line, cursor + 'from'.length)
  return toNullable(readQuotedSpecifierAt(line, cursor)?.value)
}

/** 从 `export` 之后的位置读出这一行转发的模块说明符。 */
function readExportSpecifier(line: string, bodyStart: number): Nullable<string> {
  let cursor = bodyStart
  if (line[cursor] === '{') {
    const bindingsEnd = line.indexOf('}', cursor + 1)
    if (bindingsEnd < 0) return null
    cursor = bindingsEnd + 1
  } else if (line[cursor] === '*') {
    cursor = skipImportWhitespace(line, cursor + 1)
    if (line.startsWith('as', cursor) && /\s/u.test(line[cursor + 2] ?? '')) {
      cursor = skipImportWhitespace(line, cursor + 2)
      const aliasStart = cursor
      while (/[A-Za-z0-9_$]/u.test(line[cursor] ?? '')) cursor += 1
      if (cursor === aliasStart) return null
    }
  } else {
    return null
  }

  cursor = skipImportWhitespace(line, cursor)
  if (!line.startsWith('from', cursor) || !/\s/u.test(line[cursor + 'from'.length] ?? ''))
    return null
  cursor = skipImportWhitespace(line, cursor + 'from'.length)
  return toNullable(readQuotedSpecifierAt(line, cursor)?.value)
}

/** 认出一行里的 import / export … from / require，取出它的模块说明符。 */
function extractImportSpecifier(line: string): Nullable<string> {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('import ')) {
    const bodyStart = skipImportWhitespace(trimmed, 'import'.length)
    const sideEffect = readQuotedSpecifierAt(trimmed, bodyStart)
    if (sideEffect) return sideEffect.value
    return readImportSpecifier(trimmed, bodyStart)
  }
  if (trimmed.startsWith('export ')) {
    let bodyStart = skipImportWhitespace(trimmed, 'export'.length)
    if (
      trimmed.startsWith('type', bodyStart)
      && /\s/u.test(trimmed[bodyStart + 'type'.length] ?? '')
    ) {
      bodyStart = skipImportWhitespace(trimmed, bodyStart + 'type'.length)
    }
    return readExportSpecifier(trimmed, bodyStart)
  }
  const declaration = ['const', 'let', 'var'].find((keyword) => trimmed.startsWith(`${keyword} `))
  if (!declaration) return null
  const assignment = trimmed.indexOf('=')
  if (assignment < 0) return null
  let cursor = skipImportWhitespace(trimmed, assignment + 1)
  if (!trimmed.startsWith('require', cursor)) return null
  cursor = skipImportWhitespace(trimmed, cursor + 'require'.length)
  if (trimmed[cursor] !== '(') return null
  cursor = skipImportWhitespace(trimmed, cursor + 1)
  const specifier = readQuotedSpecifierAt(trimmed, cursor)
  if (!specifier) return null
  cursor = skipImportWhitespace(trimmed, specifier.end)
  if (trimmed[cursor] !== ')') return null
  return specifier.value
}

/** 扫一份源码里的全部导入，注释里的写法不算。 */
export function extractImports(filePath: string, content: string): KnowledgeCodeImportRecord[] {
  const results: KnowledgeCodeImportRecord[] = []
  const lines = content.split('\n')
  let inBlockComment = false
  for (const line of lines) {
    const masked = maskJavaScriptComments(line, inBlockComment)
    inBlockComment = masked.endsInBlockComment
    const specifier = extractImportSpecifier(masked.line)
    if (!specifier) continue
    results.push({
      specifier,
      path: filePath,
      isRelative: specifier.startsWith('.'),
    })
  }
  return results
}

/** 把一个相对导入说明符解析成一组候选的工作区相对路径。 */
export function createImportTargetCandidates(
  specifier: string,
  importerPath: string,
  workspaceRoot: string,
): string[] {
  if (!specifier.startsWith('.')) return []
  const base = resolve(dirname(importerPath), specifier)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    join(base, 'index.js'),
  ]
  return candidates.map((c) => relative(workspaceRoot, c))
}

/** 按路径提示给一个文件打分：完全相等最高，包含次之，文件名相同再次之。 */
export function scorePathMatch(filePath: string, hints: string[]): number {
  if (isEmpty(hints)) return 0
  const lower = filePath.toLowerCase()
  let score = 0
  for (const hint of hints) {
    const h = hint.toLowerCase()
    // 三档：整条路径相等、路径里包含、只有文件名相同。
    if (lower === h) { score += 10; continue }
    if (lower.endsWith(h) || lower.includes(h)) { score += 3; continue }
    if (lower.includes(h.split('/').pop() ?? h)) score += 1
  }
  return score
}
