/**
 * 浏览器宿主这一面的类型：挂载一个制品时给的选项（带回调，所以不进可移植文件）、
 * 交给 `onError` 的错误形状，以及消息桥上一条载荷的最小形状。
 */
import type { HtmlArtifactHostErrorPhase } from '../contract/constants.js'
import type { HtmlArtifactBrowserEnvironment } from '../contract/requires.js'

import type {
  HtmlArtifactProtocolEvent,
  HtmlArtifactProtocolLimits,
} from './html-artifacts.js'

/** 运行时交给 `onError` 的一条错误：外面按 `phase` 分流，文字只给人看。 */
export interface HtmlArtifactHostError {
  /** 给人看的说明。 */
  message: string
  /** 这条错误来自哪一段。 */
  phase: HtmlArtifactHostErrorPhase
  /** 原始异常（回调抛出、脚本出错时带上）。 */
  cause?: unknown
  /** 出问题的补丁 id。 */
  patchId?: string
  /** 出问题的补丁类型。 */
  patchType?: string
}

/** 挂载一个制品时可以给的东西：iframe 的外观与边界、协议上限、注入面，以及六个宿主回调。 */
export interface MountHtmlArtifactOptions {
  /** iframe 的无障碍标题；不写用一份中文缺省。 */
  title?: string
  /** 加在 iframe 上的 class 名。 */
  className?: string
  /** iframe 的 sandbox 令牌；缺省是刻意很小的 `allow-scripts`。 */
  sandbox?: string
  /** 运行时报出第一次测量之前的高度（像素）。 */
  initialHeight?: number
  /** 测量之后宿主允许的最小高度（像素）。 */
  minHeight?: number
  /** 高度硬上限（像素）；更高的内容在 iframe 内部滚。 */
  maxHeight?: number
  /** 产品中立的设计 CSS，插在制品自己的样式之前。 */
  designCss?: string
  /** 外壳文档里承载制品的根元素 id。 */
  rootId?: string
  /** 给不可信或异常超长的流设的协议资源上限。 */
  protocolLimits?: HtmlArtifactProtocolLimits
  /** 允许交给 `onLink` 的 URL 协议；缺省是 `http:` 与 `https:`。 */
  allowedLinkProtocols?: readonly string[]
  /** 换一份浏览器边界（webview、测试假造）；不写用包自带的 DOM 实现。 */
  environment?: HtmlArtifactBrowserEnvironment
  /** 制品之外的普通 Markdown 文本，一段一段交给宿主。 */
  onMarkdown?: (text: string) => void
  /** 制品里调用 `sendPrompt()` 时收到的提问。 */
  onPrompt?: (prompt: string) => void
  /** 制品里调用 `openLink()` 且 URL 过了协议白名单时收到的外链。 */
  onLink?: (url: string) => void
  /** 制品经 `artifactBridge.send()` 发来的自定义载荷。 */
  onMessage?: (payload: unknown) => void
  /** iframe 自己滚不动时转过来的滚轮手势；给了它就不会再走注入面的 `scrollBy`。 */
  onWheel?: (deltaX: number, deltaY: number) => void
  /** 每一条协议事件的原样回调，宿主要自己记账时用。 */
  onEvent?: (event: HtmlArtifactProtocolEvent) => void
  /** 协议诊断、脚本出错、非法外链、回调自己抛错，都从这里出来。 */
  onError?: (error: HtmlArtifactHostError) => void
}

/** 消息桥上一条载荷的最小形状：认得出 `type` 才继续看后面的字段。 */
export type HtmlArtifactMessagePayload = PlainObject & { type: string }
