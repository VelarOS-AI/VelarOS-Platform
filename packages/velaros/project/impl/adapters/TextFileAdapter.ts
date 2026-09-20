/**
 * 纯文本 adapter：`TextFileAdapter`，实现注入面的 `FileAdapter`（contract/requires.ts）。
 * 所有可读的非二进制文件都由它兜底：文本搜索、按精确片段 / 前后锚点 / 行号解析目标、轻量校验；更强的 adapter 以更高 priority 优先。
 */

import { isEmpty, isString, isTrue } from '@velaros-ai/core'

import type { FileAdapter } from '../../contract/requires.js'
import type { AdapterCapability, AdapterKind, AdapterSearchHit, AdapterSearchInput, AdapterValidateInput } from '../../types/adapter.js'
import type { FileSnapshot } from '../../types/snapshot.js'
import type { ResolvedTarget, ResolveTargetInput, ResolveTargetResult } from '../../types/target.js'
import type { ValidationResult } from '../../types/validation.js'
import { execGuardedRegex } from '../../utils/regex-guard.js'
import { snippetWindow } from '../../utils/search-snippet.js'
import { textRangeTarget } from '../../utils/targets.js'
import { createLowercaseOffsetMapper, includesLineEndingAware, lineToOffset, rangeFromOffsets, resolveLineEndingAwareTextMatch } from '../../utils/text.js'
import { ProjectTuning } from '../../utils/tuning.js'

export class TextFileAdapter implements FileAdapter {
  public readonly id = 'core.text'
  public readonly kind: AdapterKind = 'text'
  public readonly priority = 0
  public readonly capabilities: AdapterCapability[] = ['read', 'search', 'resolve', 'prepare_edit', 'validate']

  public search(input: AdapterSearchInput): AdapterSearchHit[] {
    const content = input.snapshot.content ?? ''
    if (!content) return []
    const hits: AdapterSearchHit[] = []
    const limit = input.maxResults ?? ProjectTuning.adapters.textHits
    if (limit <= 0) return hits
    const caseInsensitive = !isTrue(input.caseSensitive)
    const addHit = (start: number, end: number): void => {
      hits.push({
        path: input.snapshot.path,
        score: 1,
        kind: 'text',
        range: rangeFromOffsets(content, start, end),
        // 交出去的是整行窗口，行太长时以命中为中心收窄：命中一定在片段里。
        snippet: snippetWindow(content, start, end),
        adapterId: this.id,
      })
    }
    if (input.regex || isEmpty(input.query)) {
      // 保持既有 JS 正则语法；仅显式正则（或空字面查询）创建 RegExp。
      // 整次扫描交给带时限的护栏跑：模型给的正则可能灾难回溯，直接 exec 会卡死整个进程。
      for (const match of execGuardedRegex(input.query, caseInsensitive ? 'gi' : 'g', content, limit)) {
        addHit(match.index, match.index + match.length)
      }
      return hits
    }
    const haystack = caseInsensitive ? content.toLowerCase() : content
    const needle = caseInsensitive ? input.query.toLowerCase() : input.query
    // 整串转换保留 Greek final sigma 等上下文规则；展开时再按顺序映射回原文。
    const mapOffset = haystack.length === content.length
      ? (offset: number): number => offset
      : createLowercaseOffsetMapper(content)
    let from = 0
    while (hits.length < limit) {
      const index = haystack.indexOf(needle, from)
      if (index === -1) break
      addHit(mapOffset(index, false), mapOffset(index + needle.length, true))
      from = index + needle.length
    }
    return hits
  }

  public resolveTarget(input: ResolveTargetInput & { snapshot: FileSnapshot }): ResolveTargetResult {
    const content = input.snapshot.content ?? ''
    if (input.baseRevision && input.baseRevision !== input.snapshot.revision) return { status: 'not_found', reason: `baseRevision 不匹配：${input.baseRevision} != ${input.snapshot.revision}` }
    const exact = input.target?.exactSnippet
    if (exact) {
      const found = resolveLineEndingAwareTextMatch(content, exact)
      const expected = input.expectedMatches ?? 1
      if (found.count === 1 && expected === 1) return { status: 'resolved', target: textRangeTarget(input.snapshot, { startOffset: found.index, endOffset: found.index + found.matchedText.length }, input, 0.99, this.id) }
      if (found.count > 0) {
        const candidates: ResolvedTarget[] = []
        let from = 0
        while (true) {
          const idx = content.indexOf(found.matchedText, from)
          if (idx === -1) break
          candidates.push(textRangeTarget(input.snapshot, { startOffset: idx, endOffset: idx + found.matchedText.length }, input, 0.75, this.id))
          from = idx + found.matchedText.length
        }
        return {
          status: 'ambiguous',
          candidates,
          reason: found.count === expected
            ? `匹配总数断言通过，但 ${found.count} 个候选仍需明确选择`
            : `预期 ${expected} 个匹配，实际找到 ${found.count} 个`,
        }
      }
      return { status: 'not_found', reason: '未找到精确片段' }
    }
    const anchors = input.target?.anchors
    if (anchors?.before || anchors?.after || (!!anchors?.mustContain && !isEmpty(anchors.mustContain))) {
      // 锚点目标先选中 before/after 之间的文本，再校验 mustContain 提示。
      let start = 0
      let end = content.length
      if (anchors.before) {
        const found = resolveLineEndingAwareTextMatch(content, anchors.before)
        if (found.count === 0) return { status: 'not_found', reason: '未找到 before 锚点' }
        start = found.index + found.matchedText.length
      }
      if (anchors.after) {
        const found = resolveLineEndingAwareTextMatch(content.slice(start), anchors.after)
        if (found.count === 0) return { status: 'not_found', reason: '未找到 after 锚点' }
        end = start + found.index
      }
      const slice = content.slice(start, end)
      for (const must of anchors.mustContain ?? []) {
        if (!includesLineEndingAware(slice, must)) return { status: 'not_found', reason: `范围内未找到 mustContain 锚点：${must}` }
      }
      return { status: 'resolved', target: textRangeTarget(input.snapshot, { startOffset: start, endOffset: end }, input, 0.85, this.id) }
    }
    const hint = input.target?.lineHint
    if (hint) {
      // 行号提示会随文件变化漂移，因此故意给较低置信度。
      const start = lineToOffset(content, hint.startLine)
      const end = lineToOffset(content, hint.endLine + 1)
      return { status: 'resolved', target: textRangeTarget(input.snapshot, { startOffset: start, endOffset: end }, input, 0.55, this.id) }
    }
    return { status: 'not_found', reason: '未提供 exactSnippet、anchors 或 lineHint' }
  }

  public validate(input: AdapterValidateInput): ValidationResult {
    const content = input.changedContent ?? input.snapshot.content ?? ''
    return { ok: isString(content), diagnostics: [], checks: [{ id: this.id, ok: true }] }
  }
}
