/**
 * 注入面：宿主可以塞进来的东西，只有一个口子。
 * 不塞时用包自带的 DOM 实现（`mountHtmlArtifact` 在没拿到 `options.environment` 时自己 new 一个），
 * 要换 webview、要在测试里假造一份浏览器，就经 `mountHtmlArtifact(target, { environment })` 递进来。
 * 这里的每个接口都必须从根入口导出。
 */

/**
 * 制品运行时会碰到的浏览器边界：建桥 id、造 iframe、订阅窗口消息、代滚一次滚轮。
 * 谁给：挂载制品的应用；什么时候给：`mountHtmlArtifact` 调用的那一刻，之后不再换；
 * 必不必须：不必须，缺省是包自带的 DOM 实现。放在这里是为了不去打补丁改全局对象。
 */
export interface HtmlArtifactBrowserEnvironment {
  /** 造一个进程内唯一的桥 id，用来给这一个制品的七个消息名加前缀；同页多个制品因此不会串台。 */
  createBridgeId: () => string
  /** 造一个空的 iframe 元素；运行时随后给它配 sandbox、样式与 srcdoc。 */
  createIframe: () => HTMLIFrameElement
  /** 订阅窗口的 `message` 事件；运行时只认来自自己那个 iframe 的消息。 */
  addMessageListener: (listener: (event: MessageEvent<unknown>) => void) => void
  /** 退订上面订阅的监听器；`dispose()` 时必须把宿主还原干净。 */
  removeMessageListener: (listener: (event: MessageEvent<unknown>) => void) => void
  /** iframe 自己滚不动时代它滚一次；宿主给了 `onWheel` 就不会走到这里。 */
  scrollBy: (deltaX: number, deltaY: number) => void
}
