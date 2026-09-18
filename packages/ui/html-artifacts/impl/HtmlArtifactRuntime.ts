/**
 * 浏览器宿主：一个 iframe 接一条流，从建桥到清理的整条生命周期都归它。
 * 一份解析器、一份沙箱外壳、一套只属于这个实例的桥接消息名，加上宿主给的六个回调。
 * 实例由 `mountHtmlArtifact()` 给出；类本身不出包。
 */
import {
  HtmlArtifactBridgeMessageTypes,
  HtmlArtifactDefaults,
} from '../contract/constants.js'
import type { HtmlArtifactBrowserEnvironment } from '../contract/requires.js'
import type {
  HtmlArtifactHostError,
  HtmlArtifactMessagePayload,
  MountHtmlArtifactOptions,
} from '../types/browser.js'
import type {
  HtmlArtifactBridgeMessages,
  HtmlArtifactProtocolEvent,
  HtmlArtifactSnapshot,
} from '../types/html-artifacts.js'
import { normalizeHtmlArtifactExternalUrl } from '../utils/external-url.js'
import { normalizeDimension, readMessagePayload, readString } from '../utils/host-bridge.js'
import { isFunction } from '../utils/runtime-guards.js'
import { Log } from '../utils/runtime-log.js'
import { buildHtmlArtifactShellDocument } from '../utils/shell-document.js'

import { DomHtmlArtifactEnvironment } from './DomHtmlArtifactEnvironment.js'
import type { HtmlArtifactProtocolParserApi } from './HtmlArtifactProtocolParser.js'
import { HtmlArtifactProtocolParser } from './HtmlArtifactProtocolParser.js'

const log = Log.tag('HtmlArtifactBrowserHost')

/**
 * 挂载出来的一个制品：外面拿它喂流、取内容、复用同一个 iframe、最后清理干净。
 * 六个方法都绑好了 this，解构出来单独用也没问题。`dispose()` 之后再调 `write` / `finish` / `reset` 会抛错。
 */
export interface HtmlArtifactController {
  /** 挂载出来的那个 iframe；宿主可以自己再加样式，但别换它的 `srcdoc`。 */
  readonly iframe: HTMLIFrameElement
  /** 外壳加载完、排队的渲染消息都送进去之后落定；`dispose()` 也会让它落定。 */
  readonly ready: Promise<HTMLIFrameElement>
  /** 喂一段文本进来，返回这一段的协议事件，顺带把该渲染的送进 iframe。 */
  write: (chunk: string) => HtmlArtifactProtocolEvent[]
  /** 流结束时收尾，返回收尾产生的事件。 */
  finish: () => HtmlArtifactProtocolEvent[]
  /** 直接消费一条（异步）可迭代的文本流，跑完返回最后一个制品的内容。同一时刻只许消费一条。 */
  consume: (
    chunks: AsyncIterable<string> | Iterable<string>,
  ) => Promise<Nullable<HtmlArtifactSnapshot>>
  /** 按 id 取制品内容；不给 id 就取这条流里最近动过的那个。 */
  getSnapshot: (artifactId?: string) => Nullable<HtmlArtifactSnapshot>
  /** 换一份干净的外壳，复用同一个 iframe 接下一次回答；脚本、样式、计时器、监听器一并清掉。 */
  reset: () => void
  /** 移除 iframe 与全部宿主监听器；之后这个实例不能再用。 */
  dispose: () => void
}

export class HtmlArtifactRuntime implements HtmlArtifactController {
  /** iframe 的缺省无障碍标题，宿主可以用 `options.title` 覆盖。 */
  private static readonly IframeTitle = 'HTML 制品预览'
  /** iframe 的缺省 sandbox 令牌：刻意只给脚本，别的能力都要宿主显式授权。 */
  private static readonly SandboxTokens = 'allow-scripts'
  /** 这个实例专属的桥接消息名前缀，后面接一个随机 id，同页多个制品不串台。 */
  private static readonly BridgePrefix = 'velaros:html-artifact'

  readonly iframe: HTMLIFrameElement
  readonly ready: Promise<HTMLIFrameElement>

  private readonly environment: HtmlArtifactBrowserEnvironment
  private readonly minHeight: number
  private readonly maxHeight: number
  private readonly initialHeight: number
  private readonly parser: HtmlArtifactProtocolParserApi
  private bridgeMessages: HtmlArtifactBridgeMessages
  private latestArtifactId: Nullable<string> = null
  private disposed = false
  private consuming = false
  private frameReady = false
  private settleReady: Optional<(frame: HTMLIFrameElement) => void>
  private readonly pendingMessages: HtmlArtifactMessagePayload[] = []

  constructor(
    target: HTMLElement,
    private readonly options: MountHtmlArtifactOptions = {}
  ) {
    if (!target || !isFunction(target.replaceChildren)) {
      throw new TypeError('挂载目标不是元素：mountHtmlArtifact 要一个能 replaceChildren 的 HTMLElement。')
    }

    this.environment = options.environment ?? new DomHtmlArtifactEnvironment()
    this.minHeight = normalizeDimension(options.minHeight, 1)
    this.maxHeight = Math.max(
      this.minHeight,
      normalizeDimension(options.maxHeight, HtmlArtifactDefaults.maxReportedHeight)
    )
    this.initialHeight = Math.min(
      this.maxHeight,
      Math.max(
        this.minHeight,
        normalizeDimension(options.initialHeight, HtmlArtifactDefaults.initialHeight)
      )
    )
    this.parser = new HtmlArtifactProtocolParser({
      enabled: true,
      limits: options.protocolLimits,
    })
    this.bridgeMessages = this.createBridgeMessages()
    this.iframe = this.environment.createIframe()
    this.ready = new Promise<HTMLIFrameElement>((resolve) => {
      this.settleReady = resolve
    })

    this.configureIframe()
    this.environment.addMessageListener(this.handleMessage)
    target.replaceChildren(this.iframe)
  }

  readonly write = (chunk: string): HtmlArtifactProtocolEvent[] => {
    this.assertActive()
    return this.dispatch(this.parser.write(chunk))
  }

  readonly finish = (): HtmlArtifactProtocolEvent[] => {
    this.assertActive()
    return this.dispatch(this.parser.finish())
  }

  readonly consume = async (
    chunks: AsyncIterable<string> | Iterable<string>
  ): Promise<Nullable<HtmlArtifactSnapshot>> => {
    this.assertActive()
    if (this.consuming) throw new Error('HTML 制品运行时已经在消费一条流了，先等它结束再开下一条。')

    this.consuming = true
    try {
      for await (const chunk of chunks) {
        this.write(chunk)
      }
      this.finish()
      return this.getSnapshot()
    } finally {
      this.consuming = false
    }
  }

  readonly getSnapshot = (
    artifactId = this.latestArtifactId ?? ''
  ): Nullable<HtmlArtifactSnapshot> => this.parser.getSnapshot(artifactId)

  readonly reset = (): void => {
    this.assertActive()
    this.parser.reset()
    this.latestArtifactId = null
    this.pendingMessages.length = 0
    this.frameReady = false
    this.bridgeMessages = this.createBridgeMessages()
    this.iframe.style.height = `${this.initialHeight}px`
    this.iframe.addEventListener('load', this.handleLoad, { once: true })
    // 换一份新外壳会清掉脚本、样式、计时器、观察器和监听器，同时保留宿主应用依赖的 iframe 身份。
    this.iframe.srcdoc = this.createShellDocument()
  }

  readonly dispose = (): void => {
    if (this.disposed) return

    this.disposed = true
    this.consuming = false
    this.pendingMessages.length = 0
    this.iframe.removeEventListener('load', this.handleLoad)
    this.environment.removeMessageListener(this.handleMessage)
    this.iframe.remove()
    this.settleReady?.(this.iframe)
  }

  private configureIframe(): void {
    this.iframe.title = this.options.title ?? HtmlArtifactRuntime.IframeTitle
    if (this.options.className) this.iframe.className = this.options.className
    this.iframe.setAttribute('sandbox', this.options.sandbox ?? HtmlArtifactRuntime.SandboxTokens)
    this.iframe.referrerPolicy = 'no-referrer'
    this.iframe.style.display = 'block'
    this.iframe.style.width = '100%'
    this.iframe.style.height = `${this.initialHeight}px`
    this.iframe.addEventListener('load', this.handleLoad, { once: true })
    this.iframe.srcdoc = this.createShellDocument()
  }

  private createBridgeMessages(): HtmlArtifactBridgeMessages {
    const prefix = `${HtmlArtifactRuntime.BridgePrefix}:${this.environment.createBridgeId()}`
    return {
      render: `${prefix}:render`,
      patch: `${prefix}:patch`,
      resize: `${prefix}:resize`,
      sendPrompt: `${prefix}:prompt`,
      openLink: `${prefix}:link`,
      generic: `${prefix}:message`,
      error: `${prefix}:error`,
    }
  }

  private createShellDocument(): string {
    return buildHtmlArtifactShellDocument({
      bridgeMessages: this.bridgeMessages,
      designCss: this.options.designCss,
      maxReportedHeight: this.maxHeight,
      rootId: this.options.rootId,
    })
  }

  private reportError(error: HtmlArtifactHostError): void {
    try {
      this.options.onError?.(error)
    } catch (cause) {
      log.warn('HTML artifact 错误回调执行失败。', { cause })
    }
  }

  private invoke<T extends unknown[]>(
    callback: Optional<(...args: T) => void>,
    callbackName: string,
    ...args: T
  ): void {
    if (!callback) return
    try {
      callback(...args)
    } catch (cause) {
      log.warn('HTML artifact 宿主回调执行失败。', { callbackName, cause })
      this.reportError({
        phase: 'host',
        message: `宿主回调 ${callbackName} 执行失败。`,
        cause,
      })
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('HTML 制品运行时已经 dispose，不能再用；要接下一条流请重新挂载。')
  }

  private post(payload: HtmlArtifactMessagePayload): void {
    if (!this.frameReady) {
      this.pendingMessages.push(payload)
      return
    }

    const frameWindow = this.iframe.contentWindow
    if (!frameWindow) {
      this.reportError({
        phase: 'host',
        message: 'HTML 制品的 iframe 不可用，这条消息没能送进沙箱。',
      })
      return
    }
    frameWindow.postMessage(payload, '*')
  }

  private dispatch(events: HtmlArtifactProtocolEvent[]): HtmlArtifactProtocolEvent[] {
    for (const event of events) {
      switch (event.type) {
        case 'markdown':
          this.invoke(this.options.onMarkdown, 'onMarkdown', event.text)
          break
        case 'artifact-open':
          this.latestArtifactId = event.artifact.id
          break
        case 'artifact-update':
          this.latestArtifactId = event.artifact.id
          this.post({
            type: this.bridgeMessages.render,
            html: event.html,
            patches: [],
          })
          break
        case 'artifact-patch':
          this.latestArtifactId = event.artifact.id
          this.post({
            type: this.bridgeMessages.patch,
            patches: [event.patch],
          })
          break
        case 'artifact-diagnostic':
          this.reportError({
            phase: 'protocol',
            message: event.diagnostic.message,
            patchId: event.diagnostic.patchId,
            patchType: event.diagnostic.patchType,
          })
          break
        case 'artifact-close':
          this.latestArtifactId = event.artifact.id
          break
      }

      this.invoke(this.options.onEvent, 'onEvent', event)
    }
    return events
  }

  private applyReportedHeight(payload: HtmlArtifactMessagePayload): void {
    const candidate = Number(payload.naturalHeight ?? payload.height)
    if (!Number.isFinite(candidate) || candidate <= 0) return

    const height = Math.min(this.maxHeight, Math.max(this.minHeight, Math.ceil(candidate)))
    if (Math.round(this.iframe.getBoundingClientRect().height) !== height) {
      this.iframe.style.height = `${height}px`
    }
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    if (this.disposed) return
    const payload = readMessagePayload(event.data)
    if (!payload) return

    const frameWindow = this.iframe.contentWindow
    if (!frameWindow || event.source !== frameWindow) return

    switch (payload.type) {
      case this.bridgeMessages.resize:
        this.applyReportedHeight(payload)
        break
      case this.bridgeMessages.sendPrompt:
        this.invoke(this.options.onPrompt, 'onPrompt', readString(payload.prompt))
        break
      case this.bridgeMessages.openLink: {
        const url = normalizeHtmlArtifactExternalUrl(payload.url, {
          allowedProtocols: this.options.allowedLinkProtocols,
        })
        if (url) {
          this.invoke(this.options.onLink, 'onLink', url)
        } else {
          this.reportError({
            phase: 'security',
            message: '已拦下一个不合法的制品外链。',
          })
        }
        break
      }
      case this.bridgeMessages.generic:
        this.invoke(this.options.onMessage, 'onMessage', payload.payload)
        break
      case this.bridgeMessages.error:
        this.reportError({
          phase: 'runtime',
          message: readString(payload.message) || '制品运行时出错。',
          patchId: readString(payload.patchId) || undefined,
          patchType: readString(payload.patchType) || undefined,
        })
        break
      case HtmlArtifactBridgeMessageTypes.wheel: {
        const deltaX = Number(payload.deltaX) || 0
        const deltaY = Number(payload.deltaY) || 0
        if (this.options.onWheel) {
          this.invoke(this.options.onWheel, 'onWheel', deltaX, deltaY)
        } else {
          this.environment.scrollBy(deltaX, deltaY)
        }
        break
      }
    }
  }

  private readonly handleLoad = (): void => {
    if (this.disposed) return
    this.frameReady = true

    const frameWindow = this.iframe.contentWindow
    if (frameWindow) {
      for (const payload of this.pendingMessages.splice(0)) {
        frameWindow.postMessage(payload, '*')
      }
    }
    this.settleReady?.(this.iframe)
  }
}

/** 在一个元素里挂一个 HTML 制品：造 iframe、建桥、接流，返回控制它的那个句柄。 */
export function mountHtmlArtifact(
  target: HTMLElement,
  options: MountHtmlArtifactOptions = {}
): HtmlArtifactController {
  return new HtmlArtifactRuntime(target, options)
}
