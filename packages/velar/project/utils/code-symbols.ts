// 域：非 JS/TS 源码（Python、Go、Rust、Java 等）的轻量符号识别。按几种常见的声明写法用正则认函数与类，
// 块范围靠花括号配对或缩进推断，只给通用代码 adapter 用；JS/TS 一律走 AST（utils/jsts-ast.ts），不经过这里。
import type { SymbolInfo } from '../types/adapter.js'

import { rangeFromOffsets } from './text.js'

/** 用几种常见的声明写法扫出函数与类，按出现位置排序；范围只覆盖声明所在的那一行。 */
export function findCodeSymbols(content: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = []
  const patterns: Array<{ kind: string; regex: RegExp }> = [
    { kind: 'function', regex: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g },
    { kind: 'class', regex: /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/g },
    { kind: 'function', regex: /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g },
    { kind: 'function', regex: /^\s*def\s+([A-Za-z_][\w]*)\s*\(/gm },
    { kind: 'class', regex: /^\s*class\s+([A-Za-z_][\w]*)\b/gm },
    { kind: 'function', regex: /func\s+([A-Za-z_][\w]*)\s*\(/g },
    { kind: 'function', regex: /fn\s+([A-Za-z_][\w]*)\s*\(/g },
  ]
  for (const { kind, regex } of patterns) {
    let match: Nullable<RegExpExecArray>
    while ((match = regex.exec(content))) {
      const start = match.index
      const lineEnd = content.indexOf('\n', start)
      symbols.push({ kind, name: match[1], range: rangeFromOffsets(content, start, lineEnd === -1 ? content.length : lineEnd), signatureHash: undefined })
    }
  }
  return symbols.sort((a, b) => (a.range.startOffset ?? 0) - (b.range.startOffset ?? 0))
}

/** 从声明起点推断整个块：签名后不远处有花括号就按括号配对，否则按缩进扩到下一个顶格的声明之前。 */
export function expandCodeBlock(content: string, startOffset: number): { startOffset: number; endOffset: number } {
  const lineEnd = content.indexOf('\n', startOffset)
  const signatureEnd = lineEnd === -1 ? content.length : lineEnd + 1
  const open = content.indexOf('{', startOffset)
  // 花括号离签名行太远（这里取 200 个字符）就不算这个声明的块，退回按缩进推断。
  if (open !== -1 && open < signatureEnd + 200) {
    let depth = 0
    for (let i = open; i < content.length; i++) {
      if (content[i] === '{') depth++
      if (content[i] === '}') {
        depth--
        if (depth === 0) return { startOffset, endOffset: i + 1 }
      }
    }
  }
  // 缩进式语言的回退逻辑：扩展到空行、反缩进或新的 def/class 之前。
  const after = content.slice(startOffset).split('\n')
  let endLines = 1
  for (let i = 1; i < after.length; i++) {
    const line = after[i]
    if (/^\S/.test(line) && /^(def|class)\s+/.test(line)) break
    if (i > 1 && /^\S/.test(line) && line.trim()) break
    endLines++
  }
  const lines = content.slice(0, startOffset).split('\n').length
  let endOffset = startOffset
  const all = content.split('\n')
  for (let i = lines - 1; i < Math.min(all.length, lines - 1 + endLines); i++) endOffset += all[i].length + 1
  return { startOffset, endOffset: Math.min(content.length, endOffset) }
}
