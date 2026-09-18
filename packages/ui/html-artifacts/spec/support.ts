/**
 * 验收与实现测试共用的浏览器假件：只实现本包真正会碰的那几个 DOM 面。
 * 假对象只写这一份，`spec/` 与 `test/` 都从这里取。
 */

type FakeListener = (event: never) => void

/** 最小事件目标：记住监听器，测试里手动 dispatch。 */
export class FakeEventTarget {
  public readonly listeners = new Map<string, Set<FakeListener>>()

  public addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  public removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  public dispatch(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      (listener as (value: unknown) => void)(event)
    }
  }
}

/** 假窗口：记下 `scrollBy` 的每一次调用，好检查滚轮代滚。 */
export class FakeWindow extends FakeEventTarget {
  public readonly scrollCalls: Array<{ left: number, top: number }> = []

  public scrollBy(options: { left: number, top: number }): void {
    this.scrollCalls.push(options)
  }
}

/** 假 iframe：记下 srcdoc、属性、样式，以及宿主往沙箱里发的每一条消息。 */
export class FakeIframe extends FakeEventTarget {
  public readonly attributes = new Map<string, string>()
  public className = ''
  public referrerPolicy = ''
  public removed = false
  public srcdoc = ''
  public style: Record<string, string> = {}
  public title = ''
  public readonly contentWindow = {
    messages: [] as Array<{ payload: Record<string, unknown>, targetOrigin: string }>,
    postMessage: (payload: Record<string, unknown>, targetOrigin: string) => {
      this.contentWindow.messages.push({ payload, targetOrigin })
    },
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  public getBoundingClientRect(): { height: number } {
    return { height: Number.parseFloat(this.style.height ?? '') || 0 }
  }

  public remove(): void {
    this.removed = true
  }
}

/** 假文档：只会造 iframe，造出来的永远是同一个，测试好拿。 */
export class FakeDocument {
  public readonly iframe = new FakeIframe()

  public createElement(name: string): FakeIframe {
    if (name !== 'iframe') throw new Error(`假文档只造 iframe，收到 ${name}`)
    return this.iframe
  }
}

/** 假挂载点：只实现 `replaceChildren`。 */
export class FakeTarget {
  public children: unknown[] = []

  public replaceChildren(...children: unknown[]): void {
    this.children = children
  }
}

/** 从外壳源码里抠出这一个实例的桥接消息名（`…:render`、`…:prompt` 这些）。 */
export function bridgeType(source: string, suffix: string): Optional<string> {
  return source.match(new RegExp(`velaros:html-artifact:[^"']+:${suffix}`))?.[0] ?? undefined
}

/** 造一份能递给 `mountHtmlArtifact` 的假浏览器边界。 */
export function createFakeEnvironment(
  document: FakeDocument,
  window: FakeWindow,
  bridgeIds: () => string
): unknown {
  return {
    createBridgeId: bridgeIds,
    createIframe: () => document.createElement('iframe'),
    addMessageListener: (listener: FakeListener) => window.addEventListener('message', listener),
    removeMessageListener: (listener: FakeListener) =>
      window.removeEventListener('message', listener),
    scrollBy: (deltaX: number, deltaY: number) => window.scrollBy({ left: deltaX, top: deltaY }),
  }
}

/** 在假的 `window` / `document` 下跑一段测试，跑完把全局还原。 */
export async function withFakeDom(
  run: (context: { document: FakeDocument, window: FakeWindow }) => Promise<void>
): Promise<void> {
  const scope = globalThis as unknown as { window?: unknown, document?: unknown }
  const previousWindow = scope.window
  const previousDocument = scope.document
  const window = new FakeWindow()
  const document = new FakeDocument()
  scope.window = window
  scope.document = document

  try {
    await run({ document, window })
  } finally {
    if (previousWindow === undefined) delete scope.window
    else scope.window = previousWindow
    if (previousDocument === undefined) delete scope.document
    else scope.document = previousDocument
  }
}
