import { isEmpty, isFalse, isNumber, isTrue, optionalWhen } from '@velaros-ai/core'

import type { SearchHit } from '../types/io.js'
import type { CorePolicy } from '../types/policy.js'
import type { CommandProvider, CommandToolRequirement } from '../types/provider.js'
import { matchesAny } from '../utils/glob.js'

export interface RipgrepSearchContext {
  rootAbs: string
  /** rootAbs 下用于收窄搜索范围的相对目录（可选）。 */
  subdirRel?: string
  query: string
  regex: boolean
  caseSensitive?: boolean
  include?: string[]
  exclude?: string[]
  excludeGitignored?: boolean
  maxResults: number
  /** 已授权且可由 rg 精确解释的路径；在命中数上限之前过滤。 */
  filterPath?: (path: string) => boolean
  command: CommandProvider
  policy: CorePolicy
}

interface RgMatchPayload {
  path?: { text?: string }
  lines?: { text?: string }
  line_number?: number
  submatches?: Array<{ start?: number; end?: number }>
}

interface RgMessage {
  type?: string
  data?: RgMatchPayload
}

interface RipgrepSearchResult {
  hits: Nullable<SearchHit[]>
  timedOut?: boolean
  truncated?: boolean
  diagnostics?: string[]
  toolRequirements?: CommandToolRequirement[]
}

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

function toRipgrepExcludeGlob(pattern: string): string {
  const glob = pattern.trim()
  return glob.startsWith('!') ? glob : `!${glob}`
}

function expandDirectoryExcludeGlob(pattern: string): string[] {
  if (!pattern.endsWith('/**')) return [pattern]
  const base = pattern.slice(0, -3)
  return base ? [base, pattern] : [pattern]
}

function buildRipgrepTimeoutDiagnostic(timeoutMs: number): string {
  return `ripgrep timed out after ${timeoutMs}ms; returned matches may be incomplete. Narrow root/include/query or retry after increasing the project ripgrep timeout.`
}

/** 暴露给测试使用（`dist/search/ripgrep.js`）。 */
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

    const snippet = (lineText ?? '').replace(/\r?\n$/, '').slice(0, 400)
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
  const maxResults = Math.min(Math.max(1, ctx.maxResults), 500)
  const args: string[] = ['--json', '--max-columns', '400', '--threads', '4', '--hidden', '--max-filesize', String(ctx.policy.maxSearchFileSizeBytes)]
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

  args.push('--max-count', String(Math.min(400, maxResults * 8)))

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
