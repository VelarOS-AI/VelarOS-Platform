import { isArray, isBoolean, isEmpty, isFiniteNumber, isNumber, isPlainObject, isString, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import { normalizeBrowserPressKeyOptions } from './BrowserKeyChord'
import type {
  BrowserPageDriver,
  BrowserPageDriverPointerListener,
  BrowserPageDriverState,
} from './BrowserPageDriver'
import type { BrowserPageScriptBuilder } from './BrowserPageScriptBuilder'
import {
  type BrowserPageDriverKernel,
  type BrowserPageDriverSession,
  clampInteger,
  clampZoomFactor,
  DEFAULT_BROWSER_VIEWPORT,
  type ExternalBrowserPageSession,
} from './BrowserRuntimeInternals'
import type { BrowserTargetRefStore } from './BrowserTargetRefStore'
import type { BrowserClickCoordinatesOptions, BrowserClickCoordinatesResult, BrowserDragOptions, BrowserDragResult, BrowserElementTargetHint, BrowserMoveMouseOptions, BrowserMoveMouseResult, BrowserPageInspection, BrowserPagePreviewPointerEvent, BrowserPageScrollOptions, BrowserPageScrollResult, BrowserPageZoomOptions, BrowserPageZoomResult, BrowserPressKeyOptions, BrowserPressKeyResult, BrowserSiteContext, BrowserTargetActionEffect, BrowserTargetActionEffectSnapshot, BrowserTargetActionOptions, BrowserTargetActionResult, BrowserTargetActionTextDiff, BrowserTypeTextOptions, BrowserTypeTextResult, BrowserViewportOptions, BrowserViewportResult } from './types.js'

export interface BrowserPointerPoint {
  x: number
  y: number
}

export interface BrowserTargetActionInternalEffectSnapshot extends BrowserTargetActionEffectSnapshot {
  textSampleLines: string[]
  textSampleTruncated: boolean
}

export type BrowserTargetActionClickMode = 'dom' | 'coordinate'

const BrowserTargetActionEffectSampleLineLimit = 200

/**
 * 交互域执行体的 host 无关外部核（走 CDP driver）。
 *
 * 承载 target action 与自愈、动作效果指纹、坐标点击/拖拽/hover 的 driver 流程、
 * viewport 与页面缩放，以及全部纯计算助手。Electron 宿主的
 * `BrowserInteractionEngine` 继承本类：external 分支交给 `super`，embedded 分支
 * （webContents 输入合成、虚拟指针浮层、HUD、高亮）由子类补齐。
 *
 * 方法默认在 runtime 的 actionQueue 内被调用。
 */
export class CdpInteractionEngine {
  protected readonly log = logRuntime.tag('BrowserInteractionEngine')

  constructor(
    protected readonly kernel: BrowserPageDriverKernel,
    protected readonly scripts: BrowserPageScriptBuilder,
    protected readonly targetRefs: BrowserTargetRefStore,
    protected readonly onPreviewPointer?: LooseOptional<(
      sessionId: string,
      pointer: BrowserPagePreviewPointerEvent
    ) => void>
  ) {}

  // ---- kernel 桥接 ----
  // 这些 protected 一行方法是 runtime 拆分期的搬运脚手架（“方法体零改写”地平移进 engine）。
  // 现在拆分已定形，它们的**退场条件**是：把 engine 内的调用点直接改成 `this.kernel.X(...)`，
  // 然后整段删除。在那之前别逐个删——半删会让同一个 engine 里两种取会话写法并存（§0.1 条 2）。
  protected getExternalPageSession(sessionId: string): Nullable<ExternalBrowserPageSession> {
    return this.kernel.getExternalPageSession(sessionId)
  }

  protected refreshPageDriverSessionState(
    sessionId: string,
    pageSession: BrowserPageDriverSession,
    fallbackUrl: string
  ): Promise<BrowserPageDriverState> {
    return this.kernel.refreshPageDriverSessionState(sessionId, pageSession, fallbackUrl)
  }

  protected refreshExternalPageState(
    sessionId: string,
    session: ExternalBrowserPageSession,
    fallbackUrl: string
  ): Promise<BrowserPageDriverState> {
    return this.kernel.refreshExternalPageState(sessionId, session, fallbackUrl)
  }

  protected updateExternalPageStateFromInspection(
    sessionId: string,
    session: ExternalBrowserPageSession,
    inspection: BrowserPageInspection
  ): void {
    this.kernel.updateExternalPageStateFromInspection(sessionId, session, inspection)
  }

  protected syncExternalPageStateFromScriptResult(
    sessionId: string,
    session: ExternalBrowserPageSession,
    result: unknown,
    fallbackUrl: string
  ): void {
    this.kernel.syncExternalPageStateFromScriptResult(sessionId, session, result, fallbackUrl)
  }

  protected delay(ms: number): Promise<void> {
    return this.kernel.delay(ms)
  }

  private requireExternalPageSession(sessionId: string): ExternalBrowserPageSession {
    const externalSession = this.getExternalPageSession(sessionId)
    if (!externalSession) {
      throw new AppError('NOT_FOUND', `外部浏览器会话不存在：${sessionId}`)
    }
    return externalSession
  }

  public async performTargetAction(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserTargetActionOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserTargetActionResult> {
    abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const hydratedOptions = this.targetRefs.hydrate(sessionId, options)
    const clickMode = this.resolveTargetActionClickMode(externalSession.driver, hydratedOptions)
    const beforeEffectSnapshot = await this.captureTargetActionEffectSnapshot(
      externalSession.driver
    )
    const initialActionResult =
      await externalSession.driver.executeJavaScript<BrowserTargetActionResult>(
        this.scripts.buildTargetActionScript(hydratedOptions, { clickMode }),
        true
      )
    const healedActionResult = await this.selfHealTargetActionAfterNotFound({
      sessionId,
      driver: externalSession.driver,
      options: hydratedOptions,
      result: initialActionResult,
      clickMode,
      externalSession,
    })
    const actionResult = await this.dispatchCoordinateTargetActionIfNeeded({
      sessionId,
      externalSession,
      driver: externalSession.driver,
      options: hydratedOptions,
      result: healedActionResult,
    })
    const state = await this.refreshExternalPageState(
      sessionId,
      externalSession,
      actionResult.url || context.url
    )
    const afterEffectSnapshot = actionResult.matched
      ? await this.captureTargetActionEffectSnapshot(externalSession.driver)
      : null
    const effect = this.buildTargetActionEffect(
      beforeEffectSnapshot,
      afterEffectSnapshot
    )
    if (actionResult.matched && options.action === 'click') {
      this.targetRefs.clear(sessionId)
    }

    return {
      ...actionResult,
      url: state.url || actionResult.url || context.url,
      effect: toOptional(effect),
      capturedAt: Date.now(),
    }
  }

  protected async inspectPageForTargetActionSelfHeal(input: {
    sessionId: string
    driver: BrowserPageDriver
    externalSession?: LooseOptional<ExternalBrowserPageSession>
  }): Promise<BrowserPageInspection> {
    const inspection = await input.driver.executeJavaScript<BrowserPageInspection>(
      this.scripts.buildInspectionScript({
        includeHtml: false,
        maxTextChars: 2_000,
        maxHtmlChars: 1_000,
        maxElements: 120,
      }),
      true
    )
    this.targetRefs.storeInspection(input.sessionId, inspection)
    if (input.externalSession) {
      this.updateExternalPageStateFromInspection(input.sessionId, input.externalSession, inspection)
    }

    return inspection
  }

  protected async selfHealTargetActionAfterNotFound(input: {
    sessionId: string
    driver: BrowserPageDriver
    options: BrowserTargetActionOptions
    result: BrowserTargetActionResult
    clickMode: BrowserTargetActionClickMode
    externalSession?: LooseOptional<ExternalBrowserPageSession>
  }): Promise<BrowserTargetActionResult> {
    if (input.result.matched || input.result.failureReason !== 'not-found') return input.result

    const inspection = await this.inspectPageForTargetActionSelfHeal({
      sessionId: input.sessionId,
      driver: input.driver,
      externalSession: input.externalSession,
    })
    const healedTarget = this.findSelfHealingTarget(input.options, inspection)
    if (!healedTarget) return input.result

    return input.driver.executeJavaScript<BrowserTargetActionResult>(
      this.scripts.buildTargetActionScript({
        ...input.options,
        target: healedTarget,
      }, {
        clickMode: input.clickMode,
      }),
      true
    )
  }

  private findSelfHealingTarget(
    options: BrowserTargetActionOptions,
    inspection: BrowserPageInspection
  ): Nullable<BrowserElementTargetHint> {
    const candidates: Array<{
      target: BrowserElementTargetHint
      priority: number
      index: number
    }> = []
    let index = 0
    const addTarget = (
      target: Nullable<BrowserElementTargetHint>,
      priority: number
    ): void => {
      if (!target) return
      candidates.push({ target, priority, index })
      index += 1
    }

    inspection.formFields.forEach((entry) => addTarget(entry.target, options.action === 'fill' ? 5 : 1))
    inspection.actions.forEach((entry) => addTarget(entry.target, options.action === 'click' ? 5 : 2))
    inspection.links.forEach((entry) => addTarget(entry.target, options.action === 'click' ? 3 : 1))

    const ranked = candidates
      .map((candidate) => ({
        ...candidate,
        score: this.scoreSelfHealingTarget(options.target, candidate.target) + candidate.priority,
      }))
      .filter((candidate) => candidate.score >= 8)
      .sort((left, right) => right.score - left.score || left.index - right.index)

    const best = ranked[0]?.target
    if (!best || this.isSameBrowserTargetSelector(options.target, best)) return null

    return best
  }

  private scoreSelfHealingTarget(
    staleTarget: BrowserElementTargetHint,
    freshTarget: BrowserElementTargetHint
  ): number {
    let score = 0
    const staleRole = this.normalizeTargetMatchText(staleTarget.role)
    const freshRole = this.normalizeTargetMatchText(freshTarget.role)
    const staleText = this.normalizeTargetMatchText(staleTarget.text)
    const freshText = this.normalizeTargetMatchText(freshTarget.text)
    const staleName = this.normalizeTargetMatchText(staleTarget.name)
    const freshName = this.normalizeTargetMatchText(freshTarget.name)

    if (staleRole && freshRole && staleRole === freshRole) score += 3
    if (staleText && freshText) {
      score += staleText === freshText || freshText.includes(staleText) ? 8 : 0
    }
    if (staleName && freshName) {
      score += staleName === freshName || freshName.includes(staleName) ? 6 : 0
    }

    for (const [key, value] of Object.entries(staleTarget.attributes)) {
      const staleValue = this.normalizeTargetMatchText(value)
      const freshValue = this.normalizeTargetMatchText(freshTarget.attributes[key])
      if (staleValue && freshValue && staleValue === freshValue) score += 2
    }

    return score
  }

  private normalizeTargetMatchText(value: LooseOptional<string>): string {
    return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  }

  private isSameBrowserTargetSelector(
    staleTarget: BrowserElementTargetHint,
    freshTarget: BrowserElementTargetHint
  ): boolean {
    const staleCss = this.normalizeTargetMatchText(staleTarget.css)
    const freshCss = this.normalizeTargetMatchText(freshTarget.css)
    if (staleCss && freshCss && staleCss !== freshCss) return false

    const staleRef = this.targetRefs.normalizeRef(staleTarget.ref)
    const freshRef = this.targetRefs.normalizeRef(freshTarget.ref)
    if (staleRef && freshRef && staleRef !== freshRef) return false

    return !!staleCss && staleCss === freshCss
  }

  protected async captureTargetActionEffectSnapshot(
    driver: BrowserPageDriver
  ): Promise<Nullable<BrowserTargetActionInternalEffectSnapshot>> {
    try {
      const value = await driver.executeJavaScript<unknown>(
        this.scripts.buildActionEffectSnapshotScript()
      )

      return this.normalizeTargetActionEffectSnapshot(value)
    } catch (error) {
      this.log.debug('读取浏览器动作效果指纹失败', {
        error: AppError.from(error).message,
      })
      return null
    }
  }

  private normalizeTargetActionEffectSnapshot(
    value: unknown
  ): Nullable<BrowserTargetActionInternalEffectSnapshot> {
    if (!isPlainObject(value)) return null
    if (!isString(value.url)) return null
    if (!isString(value.title)) return null
    if (!isString(value.textHash)) return null
    if (!isNumber(value.textLength)) return null
    const textSampleLines = isArray(value.textSampleLines)
      ? value.textSampleLines.filter(isString).slice(0, BrowserTargetActionEffectSampleLineLimit)
      : []

    return {
      url: value.url,
      title: value.title,
      textHash: value.textHash,
      textLength: Math.max(0, Math.round(value.textLength)),
      textSampleLines,
      textSampleTruncated: isBoolean(value.textSampleTruncated) ? value.textSampleTruncated : false,
    }
  }

  protected buildTargetActionEffect(
    before: Nullable<BrowserTargetActionInternalEffectSnapshot>,
    after: Nullable<BrowserTargetActionInternalEffectSnapshot>
  ): Nullable<BrowserTargetActionEffect> {
    if (!before || !after) return null

    const textDiff = this.diffTargetActionTextSamples(before, after)

    return {
      observed: true,
      urlChanged: before.url !== after.url,
      titleChanged: before.title !== after.title,
      textChanged: before.textHash !== after.textHash || before.textLength !== after.textLength,
      textDiff,
      before: this.toPublicTargetActionEffectSnapshot(before),
      after: this.toPublicTargetActionEffectSnapshot(after),
    }
  }

  private toPublicTargetActionEffectSnapshot(
    snapshot: BrowserTargetActionInternalEffectSnapshot
  ): BrowserTargetActionEffectSnapshot {
    return {
      url: snapshot.url,
      title: snapshot.title,
      textHash: snapshot.textHash,
      textLength: snapshot.textLength,
    }
  }

  private diffTargetActionTextSamples(
    before: BrowserTargetActionInternalEffectSnapshot,
    after: BrowserTargetActionInternalEffectSnapshot
  ): BrowserTargetActionTextDiff {
    const unchanged = this.countLongestCommonSubsequence(
      before.textSampleLines,
      after.textSampleLines
    )
    const additions = Math.max(0, after.textSampleLines.length - unchanged)
    const removals = Math.max(0, before.textSampleLines.length - unchanged)

    return {
      changed: additions > 0 || removals > 0,
      additions,
      removals,
      unchanged,
      truncated: before.textSampleTruncated || after.textSampleTruncated,
    }
  }

  private countLongestCommonSubsequence(before: string[], after: string[]): number {
    if (isEmpty(before) || isEmpty(after)) return 0

    let previous = Array.from({ length: after.length + 1 }, () => 0)
    for (const beforeLine of before) {
      const current = Array.from({ length: after.length + 1 }, () => 0)
      after.forEach((afterLine, afterIndex) => {
        current[afterIndex + 1] = beforeLine === afterLine
          ? previous[afterIndex] + 1
          : Math.max(previous[afterIndex + 1], current[afterIndex])
      })
      previous = current
    }

    return previous[after.length] ?? 0
  }

  protected resolveTargetActionClickMode(
    driver: BrowserPageDriver,
    options: BrowserTargetActionOptions
  ): BrowserTargetActionClickMode {
    if (options.action !== 'click') return 'dom'
    if (!driver.clickCoordinates) return 'dom'

    return 'coordinate'
  }

  protected async dispatchCoordinateTargetActionIfNeeded(input: {
    sessionId: string
    externalSession?: LooseOptional<ExternalBrowserPageSession>
    driver: BrowserPageDriver
    options: BrowserTargetActionOptions
    result: BrowserTargetActionResult
  }): Promise<BrowserTargetActionResult> {
    if (input.options.action === 'hover') return this.dispatchCoordinateTargetHoverIfNeeded(input)
    if (input.options.action !== 'click') return input.result
    if (!input.result.matched || input.result.clickMethod !== 'coordinate') return input.result

    const clickPoint = this.readTargetActionClickPoint(input.result.clickPoint)
    if (!clickPoint || !input.driver.clickCoordinates) return {
        ...input.result,
        matched: false,
        failureReason: 'not-interactable',
      }

    try {
      await input.driver.clickCoordinates({
        x: clickPoint.x,
        y: clickPoint.y,
        button: 'left',
        clickCount: 1,
        waitForNavigation: false,
        onPointerEvent: input.externalSession
          ? this.createPreviewPointerListener(input.sessionId, input.externalSession, 'click')
          : undefined,
      })

      return input.result
    } catch (error) {
      this.log.debug('坐标目标点击失败，回退 DOM click', {
        error: AppError.from(error).message,
      })

      return input.driver.executeJavaScript<BrowserTargetActionResult>(
        this.scripts.buildTargetActionScript(input.options, { clickMode: 'dom' }),
        true
      )
    }
  }

  private async dispatchCoordinateTargetHoverIfNeeded(input: {
    sessionId: string
    externalSession?: LooseOptional<ExternalBrowserPageSession>
    driver: BrowserPageDriver
    result: BrowserTargetActionResult
  }): Promise<BrowserTargetActionResult> {
    if (!input.result.matched || input.result.clickMethod !== 'coordinate') return input.result

    const hoverPoint = this.readTargetActionClickPoint(input.result.clickPoint)
    if (!hoverPoint || !input.driver.moveMouse) return {
        ...input.result,
        matched: false,
        failureReason: 'not-interactable',
      }

    await input.driver.moveMouse({
      x: hoverPoint.x,
      y: hoverPoint.y,
      onPointerEvent: input.externalSession
        ? this.createPreviewPointerListener(input.sessionId, input.externalSession, 'hover')
        : undefined,
    })

    return input.result
  }

  private readTargetActionClickPoint(
    value: BrowserTargetActionResult['clickPoint']
  ): Nullable<{ x: number; y: number }> {
    return this.readBrowserPointerPoint(value)
  }

  protected readBrowserPointerPoint(
    value: Optional<Nullable<{ x: number; y: number }>>
  ): Nullable<{ x: number; y: number }> {
    if (!value) return null
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null

    return {
      x: Math.round(value.x),
      y: Math.round(value.y),
    }
  }

  public async typeText(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserTypeTextOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserTypeTextResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    if (!externalSession.driver.typeText) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持文本输入。')
    }
    await externalSession.driver.typeText(options)
    const state = await this.refreshExternalPageState(sessionId, externalSession, context.url)
    return {
      url: state.url || context.url,
      textLength: options.text.length,
      capturedAt: Date.now(),
    }
  }

  public async pressKey(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPressKeyOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserPressKeyResult> {
    _abortSignal?.throwIfAborted()
    const normalized = normalizeBrowserPressKeyOptions(options)
    const externalSession = this.requireExternalPageSession(sessionId)
    if (!externalSession.driver.pressKey) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持键盘输入。')
    }
    const repeat = clampInteger(normalized.repeat, 1, 50, 1)
    await externalSession.driver.pressKey({
      ...normalized,
      repeat,
    })
    const state = await this.refreshExternalPageState(sessionId, externalSession, context.url)
    return {
      url: state.url || context.url,
      key: options.key,
      repeat,
      capturedAt: Date.now(),
    }
  }

  public async clickCoordinates(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserClickCoordinatesOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserClickCoordinatesResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    if (!externalSession.driver.clickCoordinates) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持坐标点击。')
    }
    const point = this.clampExternalViewportPoint(options.x, options.y)
    const button = options.button ?? 'left'
    const clickCount = clampInteger(options.clickCount, 1, 5, 1)
    await externalSession.driver.clickCoordinates({
      ...options,
      x: point.x,
      y: point.y,
      button,
      clickCount,
      onPointerEvent: this.createPreviewPointerListener(
        sessionId,
        externalSession,
        'click'
      ),
    })
    const state = await this.refreshExternalPageState(sessionId, externalSession, context.url)
    return {
      url: state.url || context.url,
      x: point.x,
      y: point.y,
      button,
      clickCount,
      capturedAt: Date.now(),
    }
  }

  public async dragTargets(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserDragOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserDragResult> {
    _abortSignal?.throwIfAborted()
    const steps = clampInteger(options.steps, 1, 60, 10)
    const externalSession = this.requireExternalPageSession(sessionId)
    return this.dragTargetsWithExternalDriver({
      sessionId,
      context,
      driver: externalSession.driver,
      options,
      steps,
      externalSession,
    })
  }

  private async dragTargetsWithExternalDriver(input: {
    sessionId: string
    context: BrowserSiteContext
    driver: BrowserPageDriver
    options: BrowserDragOptions
    steps: number
    externalSession: ExternalBrowserPageSession
  }): Promise<BrowserDragResult> {
    if (!input.driver.dragCoordinates) {
      throw new AppError('VALIDATION', '当前浏览器 driver 不支持拖拽。')
    }

    const resolved = await input.driver.executeJavaScript<BrowserDragResult>(
      this.scripts.buildDragTargetScript(input.options),
      true
    )
    if (!resolved.matched) return {
        ...resolved,
        steps: input.steps,
        capturedAt: Date.now(),
      }

    const sourcePoint = this.readBrowserPointerPoint(resolved.source.point)
    const targetPoint = this.readBrowserPointerPoint(resolved.target.point)
    if (!sourcePoint || !targetPoint) return {
        ...resolved,
        matched: false,
        startX: toNullable(sourcePoint?.x),
        startY: toNullable(sourcePoint?.y),
        endX: toNullable(targetPoint?.x),
        endY: toNullable(targetPoint?.y),
        steps: input.steps,
        failureReason: 'not-interactable',
        capturedAt: Date.now(),
      }

    const source = this.clampExternalViewportPoint(sourcePoint.x, sourcePoint.y)
    const target = this.clampExternalViewportPoint(targetPoint.x, targetPoint.y)

    await input.driver.dragCoordinates({
      startX: source.x,
      startY: source.y,
      endX: target.x,
      endY: target.y,
      steps: input.steps,
      onPointerEvent: this.createPreviewPointerListener(input.sessionId, input.externalSession, 'drag'),
    })

    const state = await this.refreshExternalPageState(
      input.sessionId,
      input.externalSession,
      resolved.url || input.context.url
    )
    const finalUrl = state?.url || input.driver.getURL() || resolved.url || input.context.url

    return {
      ...resolved,
      url: finalUrl,
      startX: source.x,
      startY: source.y,
      endX: target.x,
      endY: target.y,
      steps: input.steps,
      failureReason: null,
      capturedAt: Date.now(),
    }
  }

  public async moveMouse(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserMoveMouseOptions,
    _abortSignal?: AbortSignal
  ): Promise<BrowserMoveMouseResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    if (!externalSession.driver.moveMouse) {
      throw new AppError('VALIDATION', '当前外部浏览器 driver 不支持鼠标移动。')
    }
    const point = this.clampExternalViewportPoint(options.x, options.y)
    await externalSession.driver.moveMouse({
      ...point,
      onPointerEvent: this.createPreviewPointerListener(
        sessionId,
        externalSession,
        'move'
      ),
    })
    const state = await this.refreshExternalPageState(sessionId, externalSession, context.url)
    return {
      url: state.url || context.url,
      x: point.x,
      y: point.y,
      capturedAt: Date.now(),
    }
  }

  protected clampExternalViewportPoint(x: number, y: number): BrowserPointerPoint {
    return {
      x: clampInteger(x, 0, 32_000, 0),
      y: clampInteger(y, 0, 32_000, 0),
    }
  }

  protected createPreviewPointerListener(
    sessionId: string,
    externalSession: ExternalBrowserPageSession,
    action: BrowserPagePreviewPointerEvent['action']
  ): BrowserPageDriverPointerListener {
    const viewport = externalSession.viewport ?? DEFAULT_BROWSER_VIEWPORT
    const width = Math.max(1, viewport.width)
    const height = Math.max(1, viewport.height)

    return (event): void => {
      const x = Math.max(0, Math.min(width - 1, Math.round(event.x)))
      const y = Math.max(0, Math.min(height - 1, Math.round(event.y)))
      this.onPreviewPointer?.(sessionId, {
        x,
        y,
        xRatio: Math.min(1, Math.max(0, x / width)),
        yRatio: Math.min(1, Math.max(0, y / height)),
        action,
        phase: event.phase,
        button: toNullable(event.button),
        capturedAt: Date.now(),
      })
    }
  }

  public async setViewport(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserViewportOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserViewportResult> {
    abortSignal?.throwIfAborted()
    const width = clampInteger(options.width, 320, 3840, DEFAULT_BROWSER_VIEWPORT.width)
    const height = clampInteger(options.height, 240, 2160, DEFAULT_BROWSER_VIEWPORT.height)
    const pageSession = await this.kernel.getLivePageDriverSession(sessionId, abortSignal)
    if (!pageSession.driver.setViewport) {
      throw new AppError('VALIDATION', '当前浏览器 driver 不支持 viewport 调整。')
    }

    await pageSession.driver.setViewport({ width, height })
    const state = await this.refreshPageDriverSessionState(sessionId, pageSession, context.url)

    return {
      url: state.url || context.url,
      width,
      height,
      capturedAt: Date.now(),
    }
  }

  public async setPageZoom(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageZoomOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserPageZoomResult> {
    abortSignal?.throwIfAborted()
    const pageSession = await this.kernel.getLivePageDriverSession(sessionId, abortSignal)
    if (!pageSession.driver.setPageZoomFactor) {
      throw new AppError('VALIDATION', '当前浏览器 driver 不支持页面缩放。')
    }

    const previousZoomFactor = clampZoomFactor(pageSession.driver.getPageZoomFactor?.(), 1)
    const zoomFactor = this.resolvePageZoomFactor(options, previousZoomFactor)
    await pageSession.driver.setPageZoomFactor(zoomFactor)
    // 缩放 HUD 是 webview 专属浮层，外部 CDP driver 无对应；Electron 子类覆盖时补 HUD。
    const state = await this.refreshPageDriverSessionState(sessionId, pageSession, context.url)

    return {
      url: state.url || context.url,
      zoomFactor,
      previousZoomFactor,
      capturedAt: Date.now(),
    }
  }

  protected resolvePageZoomFactor(
    options: BrowserPageZoomOptions,
    currentZoomFactor: number
  ): number {
    const step = this.clampZoomStep(options.step, 0.1)

    switch (options.action) {
      case 'in':
        return clampZoomFactor(currentZoomFactor + step, 1)
      case 'out':
        return clampZoomFactor(currentZoomFactor - step, 1)
      case 'reset':
        return 1
      case 'set':
        return clampZoomFactor(options.zoomFactor, 1)
      default:
        return currentZoomFactor
    }
  }

  /** 缩放步长与 `clampZoomFactor` 同形不同界（步长 0.05–0.5，因子 0.25–3），刻意各自成立。 */
  private clampZoomStep(value: LooseOptional<number>, fallback: number): number {
    if (!isFiniteNumber(value)) return fallback

    const normalized = Math.round(value * 100) / 100
    return Math.min(Math.max(normalized, 0.05), 0.5)
  }

  public async scrollPage(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPageScrollOptions = {},
    _abortSignal?: AbortSignal
  ): Promise<BrowserPageScrollResult> {
    _abortSignal?.throwIfAborted()
    const externalSession = this.requireExternalPageSession(sessionId)
    const result = await externalSession.driver.executeJavaScript<BrowserPageScrollResult>(
      this.scripts.buildScrollScript(options),
      true
    )
    this.syncExternalPageStateFromScriptResult(sessionId, externalSession, result, context.url)
    return result
  }
}
