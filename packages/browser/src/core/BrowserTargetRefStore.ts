import type { BrowserElementTargetHint, BrowserPageInspection, BrowserScreenshotElementLegendItem, BrowserTargetActionOptions } from './types.js'

/**
 * 页面元素 ref 定位表（`@e1` 风格短引用 → 完整定位线索）。
 *
 * inspect / annotated screenshot 产出 ref，后续 target action 用 ref 反查回
 * 完整 target hint。截图与交互两个域共享此状态，因此独立成协作对象。
 */
export class BrowserTargetRefStore {
  private readonly refsBySession = new Map<string, Map<string, BrowserElementTargetHint>>()

  /** 记录页面检查产出的 links/actions/formFields 定位线索。 */
  public storeInspection(sessionId: string, inspection: BrowserPageInspection): void {
    const targets: Array<Nullable<BrowserElementTargetHint>> = []
    inspection.links.forEach((entry) => targets.push(entry.target))
    inspection.actions.forEach((entry) => targets.push(entry.target))
    inspection.formFields.forEach((entry) => targets.push(entry.target))
    this.storeTargets(sessionId, targets)
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
  ): void {
    const refs = new Map<string, BrowserElementTargetHint>()
    targets.forEach((target) => {
      const normalizedRef = this.normalizeRef(target?.ref)
      if (!target || !normalizedRef) return

      refs.set(normalizedRef, {
        ...target,
        ref: normalizedRef,
      })
    })

    if (refs.size > 0) {
      this.refsBySession.set(sessionId, refs)
    } else {
      this.clear(sessionId)
    }
  }

  /** 用存储的 ref 线索补全 target action 的定位字段。 */
  public hydrate(sessionId: string, options: BrowserTargetActionOptions): BrowserTargetActionOptions {
    const normalizedRef = this.normalizeRef(options.target.ref)
    if (!normalizedRef) return options

    const storedTarget = this.refsBySession.get(sessionId)?.get(normalizedRef)
    if (!storedTarget) return options

    return {
      ...options,
      target: {
        ...storedTarget,
        ...options.target,
        ref: normalizedRef,
        css: options.target.css ?? storedTarget.css,
        role: options.target.role ?? storedTarget.role,
        text: options.target.text ?? storedTarget.text,
        name: options.target.name ?? storedTarget.name,
        attributes: {
          ...storedTarget.attributes,
          ...options.target.attributes,
        },
      },
    }
  }

  /** 归一化 ref 写法（ref=e1 / @e1 / e1 → @e1）；非法 ref 返回 null。 */
  public normalizeRef(ref: LooseOptional<string>): Nullable<string> {
    const trimmed = String(ref ?? '').trim()
    const withoutPrefix = trimmed.startsWith('ref=') ? trimmed.slice(4).trim() : trimmed
    const withoutAt = withoutPrefix.startsWith('@') ? withoutPrefix.slice(1) : withoutPrefix
    if (!/^e\d+$/.test(withoutAt)) return null

    return `@${withoutAt}`
  }

  public clear(sessionId: string): void {
    this.refsBySession.delete(sessionId)
  }

  public clearAll(): void {
    this.refsBySession.clear()
  }
}
