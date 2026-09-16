/**
 * 注入面的缺省实现：直接用当前窗口与文档。
 * `mountHtmlArtifact` 没拿到 `options.environment` 时就 new 一个它；要换 webview 或在测试里
 * 假造一份浏览器，实现 `HtmlArtifactBrowserEnvironment` 递进来即可，不用去打补丁改全局对象。
 */
import type { HtmlArtifactBrowserEnvironment } from '../contract/requires.js'
import { isFunction } from '../utils/runtime-guards.js'

export class DomHtmlArtifactEnvironment implements HtmlArtifactBrowserEnvironment {
  private fallbackId = 0

  constructor(
    private readonly browserWindow: Window = window,
    private readonly browserDocument: Document = document
  ) {}

  public createBridgeId(): string {
    const cryptoApi = globalThis.crypto
    if (cryptoApi && isFunction(cryptoApi.randomUUID)) return cryptoApi.randomUUID()

    this.fallbackId += 1
    return `${Date.now().toString(36)}-${this.fallbackId.toString(36)}`
  }

  public createIframe(): HTMLIFrameElement {
    return this.browserDocument.createElement('iframe')
  }

  public addMessageListener(listener: (event: MessageEvent<unknown>) => void): void {
    this.browserWindow.addEventListener('message', listener)
  }

  public removeMessageListener(listener: (event: MessageEvent<unknown>) => void): void {
    this.browserWindow.removeEventListener('message', listener)
  }

  public scrollBy(deltaX: number, deltaY: number): void {
    this.browserWindow.scrollBy({ left: deltaX, top: deltaY })
  }
}
