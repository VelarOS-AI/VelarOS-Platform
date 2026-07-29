/**
 * 知识代码辅助器。
 *
 * 面向知识索引流水线的轻量代码分析工具。
 * 这些辅助函数不依赖工作区内核，因为知识存储在索引期间会直接扫描文件。
 *
 * 注意：这里刻意与工作区内核适配器系统分离。
 * 知识流水线需要同步批量扫描大量文件，而内核适配器流水线偏向交互式编辑。
 */

import { dirname, join, relative, resolve } from 'node:path'

import { isEmpty } from '@velaros-ai/core'

import type { KnowledgeCodeSymbol } from '../../Types'
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'rb', 'php', 'swift', 'kt',
])

// ---------------------------------------------------------------------------
// 二进制检测
// ---------------------------------------------------------------------------

/** 若缓冲区看起来像文本文件则返回真，判断依据是前 512 字节没有空字节。 */
export function isLikelyTextFile(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(512, buffer.length))
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Code file detection
// ---------------------------------------------------------------------------

export function getCodeExtensions(filter?: string[]): string[] {
  if (filter && !isEmpty(filter)) return filter.filter((e) => CODE_EXTENSIONS.has(e))
  return [...CODE_EXTENSIONS]
}

export function isCodeFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return CODE_EXTENSIONS.has(ext)
}

// ---------------------------------------------------------------------------
// 符号提取：基于正则，足够支撑索引。
// ---------------------------------------------------------------------------

const SYMBOL_PATTERNS: Array<{ pattern: RegExp; kind: KnowledgeCodeSymbol['kind'] }> = [
  { pattern: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m, kind: 'function' },
  { pattern: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m, kind: 'class' },
  { pattern: /^(?:export\s+)?interface\s+(\w+)/m, kind: 'interface' },
  { pattern: /^(?:export\s+)?type\s+(\w+)\s*[=<]/m, kind: 'type' },
  { pattern: /^(?:export\s+)?enum\s+(\w+)/m, kind: 'enum' },
  { pattern: /^(?:export\s+)?(?:const|let|var)\s+(\w+)/m, kind: 'variable' },
]

export function extractSymbols(filePath: string, content: string): KnowledgeCodeSymbol[] {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  if (!CODE_EXTENSIONS.has(ext)) return []

  const symbols: KnowledgeCodeSymbol[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const { pattern, kind } of SYMBOL_PATTERNS) {
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

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

interface ImportRecord {
  specifier: string
  path: string
  isRelative: boolean
}

const IMPORT_PATTERNS = [
  /^import\s+(?:type\s+)?(?:[\w*{},\s]+\s+from\s+)?['"]([^'"]+)['"]/m,
  /^(?:const|let|var)\s+\w+\s*=\s*require\(['"]([^'"]+)['"]\)/m,
  /^export\s+(?:[\w*{},\s]+\s+from\s+)?['"]([^'"]+)['"]/m,
]

export function extractImports(filePath: string, content: string): ImportRecord[] {
  const results: ImportRecord[] = []
  const lines = content.split('\n')
  for (const line of lines) {
    for (const pattern of IMPORT_PATTERNS) {
      const m = line.match(pattern)
      if (m?.[1]) {
        const specifier = m[1]
        results.push({
          specifier,
          path: filePath,
          isRelative: specifier.startsWith('.'),
        })
      }
    }
  }
  return results
}

/** 将相对导入说明符解析成候选绝对路径。 */
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

// ---------------------------------------------------------------------------
// Path scoring
// ---------------------------------------------------------------------------

export function scorePathMatch(filePath: string, hints: string[]): number {
  if (isEmpty(hints)) return 0
  const lower = filePath.toLowerCase()
  let score = 0
  for (const hint of hints) {
    const h = hint.toLowerCase()
    if (lower === h) { score += 10; continue }
    if (lower.endsWith(h) || lower.includes(h)) { score += 3; continue }
    if (lower.includes(h.split('/').pop() ?? h)) score += 1
  }
  return score
}
