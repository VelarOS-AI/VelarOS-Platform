import { isPresent } from '@velaros-ai/core'

import type {
  BrowserDragOptions,
  BrowserElementTargetHint,
  BrowserPageInspection,
  BrowserScreenshotElementLegendItem,
  BrowserTargetActionOptions,
} from '../../types/browser.js'
import type { BrowserTargetRefSession, StoredBrowserTargetRefs } from '../../types/session.js'
import {
  invalidRefError,
  isRefTokenCharacter,
  readBaseRef,
  staleRefError,
} from '../../utils/target-refs'
import { scopeRef } from '../../utils/target-refs'
import { resolveStoredRef } from '../../utils/target-refs'

/**
 * 页面元素 ref 定位表（`@e1:g3` 风格短引用 → 完整定位线索）。
 *
 * inspect / annotated screenshot 产出 ref，后续 target action 用 ref 反查回
 * 完整 target hint。每次观察都会分配新 generation；旧 ref 永远不会被同名的
 * `@e1` 静默重绑定到另一个元素。截图与交互两个域共享此状态，因此独立成协作对象。
 */
export interface BrowserTargetRefStoreApi {
  /** 记录页面检查产出的 links/actions/formFields 定位线索。 */
  storeInspection(sessionId: string, inspection: BrowserPageInspection): void
  /** 记录标注截图产出的元素图例定位线索。 */
  storeScreenshotLegend(sessionId: string, legend: BrowserScreenshotElementLegendItem[]): void
  /** 把这次观察产出的目标登记成新一代 ref；旧 ref 随之失效。 */
  storeTargets(
    sessionId: string,
    targets: Array<Nullable<BrowserElementTargetHint>>
  ): StoredBrowserTargetRefs
  /** 用存储的 ref 线索补全 target action 的定位字段。 */
  hydrate(sessionId: string, options: BrowserTargetActionOptions): BrowserTargetActionOptions
  /** 用同一份 ref 解析规则补全拖拽起点与终点。 */
  hydrateDrag(sessionId: string, options: BrowserDragOptions): BrowserDragOptions
  /**
   * 解析一个模型返回的 target。
   *
   * 显式 ref 必须命中当前 observation，且命中后以存储的 target 为唯一权威来源。
   * 独立 selector/text/attributes 定位必须省略 ref，避免失效 ref 被附带字段绕过。
   */
  hydrateTarget(
    sessionId: string,
    target: BrowserElementTargetHint,
    field?: 'source' | 'target'
  ): BrowserElementTargetHint
  /** 归一化 ref 写法（e1 / @e1 / ref=e1:g2 → @e1 / @e1:g2）；非法 ref 返回 null。 */
  normalizeRef(ref: LooseOptional<string>): Nullable<string>
  /** 清掉这条会话的状态。 */
  clear(sessionId: string): void
  /** 清掉全部会话的状态；运行时收尾时调。 */
  clearAll(): void
}

export class BrowserTargetRefStore implements BrowserTargetRefStoreApi {
  private readonly refsBySession = new Map<string, BrowserTargetRefSession>()
  private readonly generationBySession = new Map<string, number>()

  /** 记录页面检查产出的 links/actions/formFields 定位线索。 */
  public storeInspection(sessionId: string, inspection: BrowserPageInspection): void {
    const targets: Array<Nullable<BrowserElementTargetHint>> = []
    inspection.links.forEach((entry) => targets.push(entry.target))
    inspection.actions.forEach((entry) => targets.push(entry.target))
    inspection.formFields.forEach((entry) => targets.push(entry.target))
    const stored = this.storeTargets(sessionId, targets)
    if (inspection.snapshot) {
      const sourceLines = inspection.snapshot.lines
      const scopedLines = sourceLines
        .map((line) => this.scopeSnapshotLine(line, stored))
        .filter(isPresent)
      inspection.snapshot.lines = scopedLines
      inspection.snapshot.refCount = stored.aliases.size
      inspection.snapshot.truncated =
        inspection.snapshot.truncated || scopedLines.length < sourceLines.length
    }
  }

  /** 记录标注截图产出的元素图例定位线索。 */
  public storeScreenshotLegend(
    sessionId: string,
    legend: BrowserScreenshotElementLegendItem[]
  ): void {
    this.storeTargets(
      sessionId,
      legend.map((entry) => entry.target)
    )
  }

  public storeTargets(
    sessionId: string,
    targets: Array<Nullable<BrowserElementTargetHint>>
  ): StoredBrowserTargetRefs {
    const generation = (this.generationBySession.get(sessionId) ?? 0) + 1
    this.generationBySession.set(sessionId, generation)
    const refs = new Map<string, BrowserElementTargetHint>()
    const aliases = new Map<string, string>()
    targets.forEach((target) => {
      const normalizedRef = this.normalizeRef(target?.ref)
      if (!target || !normalizedRef) return

      const baseRef = readBaseRef(normalizedRef)
      const scopedRef = scopeRef(baseRef, generation)
      aliases.set(baseRef, scopedRef)
      target.ref = scopedRef

      refs.set(scopedRef, {
        ...target,
        ref: scopedRef,
      })
    })

    if (refs.size > 0) {
      this.refsBySession.set(sessionId, { generation, refs })
    } else {
      this.clear(sessionId)
    }

    return { generation, aliases }
  }

  /** 用存储的 ref 线索补全 target action 的定位字段。 */
  public hydrate(
    sessionId: string,
    options: BrowserTargetActionOptions
  ): BrowserTargetActionOptions {
    return {
      ...options,
      target: this.hydrateTarget(sessionId, options.target, 'target'),
    }
  }

  /** 用同一份 ref 解析规则补全拖拽起点与终点。 */
  public hydrateDrag(sessionId: string, options: BrowserDragOptions): BrowserDragOptions {
    return {
      ...options,
      source: this.hydrateTarget(sessionId, options.source, 'source'),
      target: this.hydrateTarget(sessionId, options.target, 'target'),
    }
  }

  /**
   * 解析一个模型返回的 target。
   *
   * 显式 ref 必须命中当前 observation，且命中后以存储的 target 为唯一权威来源。
   * 独立 selector/text/attributes 定位必须省略 ref，避免失效 ref 被附带字段绕过。
   */
  public hydrateTarget(
    sessionId: string,
    target: BrowserElementTargetHint,
    field: 'source' | 'target' = 'target'
  ): BrowserElementTargetHint {
    if (!isPresent(target.ref)) return target

    const requestedRef = target.ref.trim()
    const normalizedRef = this.normalizeRef(requestedRef)
    if (!normalizedRef) throw invalidRefError(sessionId, requestedRef, field)

    const session = this.refsBySession.get(sessionId)
    const resolvedRef = session ? resolveStoredRef(normalizedRef, session) : null
    const storedTarget = resolvedRef ? session?.refs.get(resolvedRef) : null
    if (!storedTarget) {
      throw staleRefError(sessionId, normalizedRef, field, session?.generation)
    }

    return {
      ...storedTarget,
      ref: resolvedRef,
      attributes: { ...storedTarget.attributes },
    }
  }

  /** 归一化 ref 写法（e1 / @e1 / ref=e1:g2 → @e1 / @e1:g2）；非法 ref 返回 null。 */
  public normalizeRef(ref: LooseOptional<string>): Nullable<string> {
    const trimmed = String(ref ?? '').trim()
    const withoutPrefix = trimmed.startsWith('ref=') ? trimmed.slice(4).trim() : trimmed
    const withoutAt = withoutPrefix.startsWith('@') ? withoutPrefix.slice(1) : withoutPrefix
    if (!/^e\d+(?::g[1-9]\d*)?$/u.test(withoutAt)) return null

    return `@${withoutAt}`
  }

  /**
   * Snapshot 是供模型阅读的紧凑文本，不应假定 ref 后面永远是逗号或右方括号。
   * 按 `ref=` 协议标记逐段扫描 token，使后续增加状态字段或改变分隔符时仍能正确换代。
   */
  private scopeSnapshotLine(line: string, stored: StoredBrowserTargetRefs): Nullable<string> {
    const marker = 'ref='
    let cursor = 0
    let scopedLine = ''

    while (cursor < line.length) {
      const markerIndex = line.indexOf(marker, cursor)
      if (markerIndex < 0) return scopedLine + line.slice(cursor)

      const tokenStart = markerIndex + marker.length
      let tokenEnd = tokenStart
      while (tokenEnd < line.length && isRefTokenCharacter(line[tokenEnd])) tokenEnd += 1

      const rawRef = line.slice(tokenStart, tokenEnd)
      const normalizedRef = this.normalizeRef(rawRef)
      const baseRef = normalizedRef ? readBaseRef(normalizedRef) : null
      const scopedRef = baseRef ? stored.aliases.get(baseRef) : null
      // snapshot 构建早于 actions/formFields 的最终裁剪，可能含有未进入 refs 的 locator。
      // 这类行必须丢弃；给它伪造 generation 会向模型发布一个永远无法执行的“新鲜” ref。
      if (!scopedRef) return null
      scopedLine += line.slice(cursor, tokenStart) + scopedRef
      cursor = tokenEnd
    }

    return scopedLine
  }

  public clear(sessionId: string): void {
    this.refsBySession.delete(sessionId)
  }

  public clearAll(): void {
    this.refsBySession.clear()
    this.generationBySession.clear()
  }
}
