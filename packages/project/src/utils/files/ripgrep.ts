import { isEmpty, isFalse, isNumber, isTrue, optionalWhen } from '@velaros-ai/core'

import type { RgMessage, RipgrepSearchContext, RipgrepSearchResult } from '../../types/files.js'
import type { SearchHit } from '../../types/io.js'
import { matchesAny } from '../glob.js'
import { ProjectTuning } from '../tuning.js'

/** 整理 glob 名单：去掉首尾空白、空项和重复，保留原来的顺序。 */
function normalizeGlobList(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const globs: string[] = []
  for (const value of values) {
    const glob = value.trim()
    if (!glob || seen.has(glob)) continue
    seen.add(glob)
    globs.push(glob)
  }
  return globs
}

/** 把排除用的 glob 写成 ripgrep 的排除形式（前面加 !，已有的不重复加）。 */
function toRipgrepExcludeGlob(pattern: string): string {
  const glob = pattern.trim()
  return glob.startsWith('!') ? glob : `!${glob}`
}

/** `dir/**` 这类目录排除同时排除目录本身（`dir`），ripgrep 才不会进这个目录。 */
function expandDirectoryExcludeGlob(pattern: string): string[] {
  if (!pattern.endsWith('/**')) return [pattern]
  const base = pattern.slice(0, -3)
  return base ? [base, pattern] : [pattern]
}

/** ripgrep 超时时附在搜索结果里的诊断：已拿到的命中照样返回，但可能不全。 */
function buildRipgrepTimeoutDiagnostic(timeoutMs: number): string {
  return `ripgrep 搜索超过 ${timeoutMs} 毫秒超时，返回的命中可能不完整；请缩小 root、include 或 query，或调大项目的 ripgrep 超时后重试。`
}

/** 解析 `rg --json` 的输出：只取 match 行，列号从 UTF-8 字节位置换算成 UTF-16 坐标，片段截到可调的字符数，满 maxResults 即止。 */
export function parseRipgrepJsonLines(stdout: string, maxResults: number, filterPath?: (path: string) => boolean): SearchHit[] {
  const hits: SearchHit[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim() || hits.length >= maxResults) break
    let msg: RgMessage
    try {
      msg = JSON.parse(line) as RgMessage
    } catch {
      // arch-guard:silent-catch-ok 单行 rg JSON 解析失败时跳过该行，后续行仍可继续解析。
      continue
    }
    if (msg.type !== 'match' || !msg.data) continue
    const pathText = msg.data.path?.text
    const lineText = msg.data.lines?.text
    const lineNumber = msg.data.line_number
    if (!pathText || !isNumber(lineNumber)) continue
    const path = pathText.replace(/\\/g, '/').replace(/^\.\//, '')
    if (filterPath && !filterPath(path)) continue

    const subs = msg.data.submatches ?? []
    let startCol = 1
    let endCol = 1
    if (subs.length > 0 && isNumber(subs[0].start)) {
      const start = subs[0].start ?? 0
      const end = subs[0].end ?? start
      // rg 给出 UTF-8 字节位置；Project 的列坐标统一为解码后的 UTF-16 code units。
      const bytes = Buffer.from(lineText ?? '', 'utf8')
      startCol = bytes.subarray(0, start).toString('utf8').length + 1
      endCol = Math.max(startCol, bytes.subarray(0, end).toString('utf8').length + 1)
    }

    const snippet = (lineText ?? '').replace(/\r?\n$/, '').slice(0, ProjectTuning.ripgrep.snippetChars)
    hits.push({
      path,
      revision: '',
      score: 2,
      kind: 'text',
      range: {
        startLine: lineNumber,
        endLine: lineNumber,
        startColumn: startCol,
        endColumn: endCol,
      },
      snippet,
      adapterId: 'core.ripgrep',
      trust: { source: 'project', trust: 'untrusted' },
    })
  }
  return hits
}

/**
 * 通过 CommandProvider 运行 ripgrep。失败时返回 hits=null，方便调用方回退。
 * 退出码 1 表示没有命中（空结果列表）。
 */
export async function searchWithRipgrep(ctx: RipgrepSearchContext): Promise<RipgrepSearchResult> {
  const maxResults = Math.min(Math.max(1, ctx.maxResults), ProjectTuning.ripgrep.maxResults)
  const args: string[] = ['--json', '--max-columns', String(ProjectTuning.ripgrep.snippetChars), '--threads', String(ProjectTuning.ripgrep.threads), '--hidden', '--max-filesize', String(ctx.policy.maxSearchFileSizeBytes)]
  if (isFalse(ctx.excludeGitignored)) args.push('--no-ignore')

  for (const g of normalizeGlobList(ctx.include ?? [])) {
    args.push('--glob', g)
  }

  const excludes = normalizeGlobList([
    ...ctx.policy.readDeny.flatMap(expandDirectoryExcludeGlob),
    ...(ctx.exclude ?? []).flatMap(expandDirectoryExcludeGlob),
  ])
  for (const g of excludes) {
    args.push('--glob', toRipgrepExcludeGlob(g))
  }

  if (!ctx.regex) args.push('--fixed-strings')
  if (!isTrue(ctx.caseSensitive)) args.push('--ignore-case')

  args.push('--max-count', String(Math.min(ProjectTuning.ripgrep.perFileMatches, maxResults * 8)))

  const pattern = ctx.query
  args.push('--', pattern)

  const searchUnder = ctx.subdirRel?.trim() ? ctx.subdirRel.trim() : '.'
  args.push(searchUnder)

  try {
    const result = await ctx.command.run({
      command: 'rg',
      args,
      cwd: ctx.rootAbs,
      timeoutMs: ctx.policy.ripgrepTimeoutMs,
    })

    if (result.toolRequirements?.some((item) => item.kind === 'missing-command'))
      return {
        hits: null,
        toolRequirements: result.toolRequirements,
      }

    const timedOut = isTrue(result.timedOut)
    const truncated = isTrue(result.truncated)
    if (result.exitCode !== 0 && result.exitCode !== 1 && !timedOut && !truncated)
      return {
        hits: null,
        toolRequirements: result.toolRequirements,
      }

    const hits = parseRipgrepJsonLines(result.stdout, maxResults, (path) =>
      !matchesAny(path, ctx.policy.readDeny) && (!ctx.filterPath || ctx.filterPath(path)))
    const deny = ctx.policy.readDeny
    const filtered = hits.filter((h) => !matchesAny(h.path, deny))
    const diagnostics = [
      ...(timedOut ? [buildRipgrepTimeoutDiagnostic(ctx.policy.ripgrepTimeoutMs)] : []),
      ...(truncated ? ['ripgrep 输出达到宿主缓冲上限，当前结果可能不完整；请缩小搜索范围或增加命中条件后继续检索。'] : []),
    ]
    return {
      hits: filtered.length <= maxResults ? filtered : filtered.slice(0, maxResults),
      timedOut,
      truncated,
      diagnostics: optionalWhen(!isEmpty(diagnostics), diagnostics),
      toolRequirements: result.toolRequirements,
    }
  } catch {
    // arch-guard:silent-catch-ok ripgrep 后端失败时返回 null，让调用方按设计回退到 adapter 搜索。
    return { hits: null }
  }
}
