import { realpath, stat } from 'node:fs/promises'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ToolContext } from '../Types.js'

import { readSystemTextFile, resolveSystemPathInput } from './Filesystem.js'

export interface AtomicGrepInput {
  path: string
  pattern: string
  regex?: boolean
  caseSensitive?: boolean
  limit: number
  maxDepth?: number
  maxResultsPerFile?: number
}

export interface AtomicGrepMatch {
  path: string
  line: number
  column: number
  excerpt: string
}

export interface AtomicGrepResult {
  rootPath: string
  pattern: string
  count: number
  truncated: boolean
  /**
   * 单文件命中数超过 maxResultsPerFile 被丢弃的文件（最多列 10 个）。
   * 诚实截断铁律：静默丢弃 + truncated:false 会让模型把不完整结果当全量
   * （真机取证:200 条 ERROR 被报成 25 条还声称"数据完整"）。
   */
  perFileTruncatedPaths?: string[]
  matches: AtomicGrepMatch[]
}

function buildMatcher(input: AtomicGrepInput): (line: string) => Iterable<number> {
  if (input.regex) {
    const flags = input.caseSensitive ? 'g' : 'gi'
    let expression: RegExp
    try {
      expression = new RegExp(input.pattern, flags)
    } catch (err) {
      const message = AppError.getMessage(err)
      throw new AppError('VALIDATION', `Invalid regex pattern: ${message}`)
    }
    return (line) => {
      const starts: number[] = []
      expression.lastIndex = 0
      let match = expression.exec(line)
      while (match) {
        starts.push(match.index + 1)
        if (isEmpty(match[0])) {
          expression.lastIndex += 1
        }
        match = expression.exec(line)
      }
      return starts
    }
  }

  const needle = input.caseSensitive ? input.pattern : input.pattern.toLowerCase()
  // 空 needle 会让游标永不推进而无限 yield。入参 schema 有 `min(1)` 兜着，但**依赖外层校验的
  // 防御不是防御**——本函数是内部可复用件，schema 只守工具入口那一条路。这里挡住，让空模式
  // 退化成"零匹配"而不是挂死进程。
  if (isEmpty(needle)) return () => []
  return function* matchLiteral(line: string) {
    const haystack = input.caseSensitive ? line : line.toLowerCase()
    let index = 0
    while (true) {
      const foundIndex = haystack.indexOf(needle, index)
      if (foundIndex === -1) return
      yield foundIndex + 1
      index = foundIndex + needle.length
    }
  }
}

function grepFileContent(
  filePath: string,
  content: string,
  matcher: (line: string) => Iterable<number>,
  perFileLimit: number
): AtomicGrepMatch[] {
  const matches: AtomicGrepMatch[] = []
  const lines = content.split(/\r?\n/)

  // 按文件累计计数(曾误写成按行计数:单行命中数达 limit 才停,且直接中断整个文件扫描)。
  outer: for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    for (const column of matcher(line)) {
      matches.push({
        path: filePath,
        line: lineIndex + 1,
        column,
        excerpt: line.trim(),
      })
      if (matches.length >= perFileLimit) break outer
    }
  }

  return matches
}

export async function executeAtomicGrep(
  input: AtomicGrepInput,
  ctx: ToolContext
): Promise<AtomicGrepResult> {
  const resolvedPath = resolveSystemPathInput(input.path)
  // 用 stat 跟随入口 symlink，并 realpath 解析到真实路径，与 list 入口行为保持一致
  // （macOS 上 /etc → /private/etc）；否则 symlink 目录会被误判为「既非文件也非目录」而拒绝。
  const stats = await stat(resolvedPath).catch(() => null)
  if (!stats) {
    throw new AppError('NOT_FOUND', `Path not found: ${resolvedPath}`)
  }
  const rootPath = await realpath(resolvedPath).catch(() => resolvedPath)

  const matcher = buildMatcher(input)
  const perFileLimit = input.maxResultsPerFile ?? 5
  const matches: AtomicGrepMatch[] = []

  if (stats.isFile()) {
    const textFile = await readSystemTextFile(rootPath)
    // 多扫 1 条用于检测溢出:超过 perFileLimit 说明还有命中被丢,必须如实上报。
    const fileMatches = grepFileContent(rootPath, textFile.content, matcher, perFileLimit + 1)
    const perFileOverflow = fileMatches.length > perFileLimit
    matches.push(...fileMatches.slice(0, Math.min(perFileLimit, input.limit)))
    return {
      rootPath,
      pattern: input.pattern,
      count: matches.length,
      truncated: matches.length >= input.limit || perFileOverflow,
      ...(perFileOverflow ? { perFileTruncatedPaths: [rootPath] } : {}),
      matches,
    }
  }

  if (!stats.isDirectory()) {
    throw new AppError('VALIDATION', `Path must be a file or directory: ${resolvedPath}`)
  }

  const search = await ctx.system.globalSearch(
    {
      query: input.pattern,
      mode: 'content',
      rootPath,
      limit: input.limit,
      maxDepth: input.maxDepth ?? 8,
      // 多要 1 条用于按文件检测溢出,返回前再裁回 perFileLimit。
      maxResultsPerFile: perFileLimit + 1,
      regex: input.regex,
      caseSensitive: input.caseSensitive,
    },
    ctx.abortSignal
  )

  const perFileCounts = new Map<string, number>()
  const perFileTruncatedPaths: string[] = []
  for (const hit of search.matches ?? []) {
    const seen = (perFileCounts.get(hit.path) ?? 0) + 1
    perFileCounts.set(hit.path, seen)
    if (seen > perFileLimit) {
      if (!perFileTruncatedPaths.includes(hit.path)) perFileTruncatedPaths.push(hit.path)
      continue
    }
    matches.push({
      path: hit.path,
      line: hit.line,
      column: hit.column,
      excerpt: hit.excerpt,
    })
    if (matches.length >= input.limit) break
  }

  const perFileOverflow = perFileTruncatedPaths.length > 0
  return {
    rootPath,
    pattern: input.pattern,
    count: matches.length,
    truncated: matches.length >= input.limit || search.truncated || perFileOverflow,
    ...(perFileOverflow ? { perFileTruncatedPaths: perFileTruncatedPaths.slice(0, 10) } : {}),
    matches,
  }
}
