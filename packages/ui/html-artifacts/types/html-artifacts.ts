/**
 * HTML 制品的可移植数据：增量协议在流上传的每一种事件、解析器的状态形状，
 * 以及沙箱文档、尺寸拟合、外链归一化这些能力的入参与出参。
 * 只从常量表 import type，不引任何实现，也不带行为（回调型选项在 `types/browser.ts`）。
 */
// 门禁要求可移植文件的常量表 import 写成一行。
import type { HtmlArtifactPatchType, HtmlArtifactProtocolDiagnosticCode, HtmlArtifactProtocolMode } from '../contract/constants.js'

/** 一次补丁动作的类型，与补丁类型同一组取值。 */
export type HtmlArtifactActionType = HtmlArtifactPatchType

/** 送进 iframe 的一次渲染改动：整体替换、追加、换一段样式、跑一段脚本。 */
export type HtmlArtifactRenderPatch =
  | { type: 'replace', target?: string, html: string }
  | { type: 'append', target?: string, html: string }
  | { type: 'style', styleId: string, css: string }
  | { type: 'script', scriptId: string, code: string }

/** 一个制品的身份：`<artifact …>` 标签上声明的那几项。 */
export interface HtmlArtifactDescriptor {
  /** 制品 id，归一化后的结果；同一个 id 的后续补丁打在同一个制品上。 */
  id: string
  /** 制品声明的协议版本；缺省按当前版本处理。 */
  protocolVersion?: string
  /** 给人看的标题，已按上限截断；没写就是缺省标题。 */
  title: string
  /** 制品自己要的初始高度（像素），落在声明高度的上下界内；没写就没有这一项。 */
  initialHeight?: number
}

/** 一个制品当前的完整内容：身份加上已经攒出来的 HTML 与协议原文。 */
export interface HtmlArtifactSnapshot extends HtmlArtifactDescriptor {
  /** 制品根节点当前的 HTML，已按上限截断。 */
  html: string
  /** 这个制品对应的协议原文（宿主要持久化时用），已按上限截断。 */
  protocolText?: string
}

/** 正在解析中的一次补丁动作：攒到哪、发到哪、已经报过哪些诊断。 */
export interface HtmlArtifactActionState {
  /** 这次动作是哪一种补丁。 */
  type: HtmlArtifactActionType
  /** 补丁打在哪个选择器上；没写就是打在制品根节点上。 */
  target?: string
  /** 样式补丁的样式块 id。 */
  styleId?: string
  /** 脚本补丁的脚本块 id。 */
  scriptId?: string
  /** 载荷的编码方式；`base64` 表示要先解码再送进 iframe。 */
  encoding?: 'base64'
  /** 这次动作开始前制品根节点的 HTML，追加型补丁要拼在它后面。 */
  baseHtml: string
  /** 已经收到的载荷原文，已按上限截断。 */
  html: string
  /** 载荷里已经发出去的长度，下一次只发这之后的部分。 */
  emittedLength: number
  /** 已经报过的诊断指纹，同一条不重复打扰宿主。 */
  emittedDiagnostics: string[]
}

/** 解析期发现的问题：不中断流，作为事件报给宿主。 */
export interface HtmlArtifactProtocolDiagnostic {
  /** 诊断码，外面按它判断，不按文字。 */
  code: HtmlArtifactProtocolDiagnosticCode
  /** 给人看的说明。 */
  message: string
  /** 问题出在协议解析这一段。 */
  phase: 'protocol'
  /** 出问题的补丁是哪一种。 */
  patchType?: HtmlArtifactPatchType
  /** 出问题的补丁 id（`id` 或 `target`）。 */
  patchId?: string
}

/** 协议的资源上限：宿主可以逐项收紧，不写的那项用常量表里的缺省值。 */
export interface HtmlArtifactProtocolLimits {
  /** 单个补丁载荷的字符数上限。 */
  maxActionPayloadLength?: number
  /** 单个制品保留的 HTML 字符数上限。 */
  maxArtifactHtmlLength?: number
  /** 单个制品保留的协议原文字符数上限。 */
  maxArtifactProtocolTextLength?: number
  /** 跨 chunk 暂存的待解析缓冲区字符数上限。 */
  maxBufferLength?: number
}

/** 解析一条流所需的全部状态；宿主自己持久化它时（例如聊天会话跨进程续读）拿到的就是这个形状。 */
export interface HtmlArtifactProtocolStreamState {
  /** 关掉时整条流原样当 Markdown 放过去，一个制品都不认。 */
  enabled: boolean
  /** 当前解析到哪一段。 */
  mode: HtmlArtifactProtocolMode
  /** 还没凑成完整协议边界的尾巴，留到下一个 chunk 一起看。 */
  buffer: string
  /** 当前打开着的制品；不在制品里就是 null。 */
  activeArtifact: Nullable<HtmlArtifactDescriptor>
  /** 当前打开着的补丁动作；不在补丁里就是 null。 */
  activeAction: Nullable<HtmlArtifactActionState>
  /** 这条流里出现过的每个制品的最新内容，按 id 索引。 */
  artifactsById: Record<string, HtmlArtifactSnapshot>
  /** 没给 id 的制品的计数器，用来编出不重名的 id。 */
  anonymousArtifactCounter: number
  /** 这条流实际生效的资源上限，缺省项已经补齐。 */
  limits: Required<HtmlArtifactProtocolLimits>
}

/** 新建一条流的解析状态时可以给的东西。 */
export interface HtmlArtifactProtocolStreamOptions {
  /** 要不要认制品协议；不写就是不认，整条流当 Markdown。 */
  enabled?: boolean
  /** 续读时先把已有的制品放回去，后续补丁接着打在它们上面。 */
  initialArtifacts?: HtmlArtifactSnapshot[]
  /** 收紧资源上限。 */
  limits?: HtmlArtifactProtocolLimits
}

/** 解析器状态的只读快照：外面看得见解析到哪了，但改不动它。 */
export interface HtmlArtifactProtocolStateSnapshot {
  /** 见 `HtmlArtifactProtocolStreamState.enabled`。 */
  readonly enabled: boolean
  /** 见 `HtmlArtifactProtocolStreamState.mode`。 */
  readonly mode: HtmlArtifactProtocolMode
  /** 见 `HtmlArtifactProtocolStreamState.buffer`。 */
  readonly buffer: string
  /** 见 `HtmlArtifactProtocolStreamState.activeArtifact`，已冻结。 */
  readonly activeArtifact: Nullable<Readonly<HtmlArtifactDescriptor>>
  /** 见 `HtmlArtifactProtocolStreamState.activeAction`，已冻结。 */
  readonly activeAction: Nullable<
    Readonly<Omit<HtmlArtifactActionState, 'emittedDiagnostics'>> & {
      /** 已经报过的诊断指纹，只读。 */
      readonly emittedDiagnostics: readonly string[]
    }
  >
  /** 见 `HtmlArtifactProtocolStreamState.artifactsById`，每一项都已冻结。 */
  readonly artifactsById: Readonly<Record<string, Readonly<HtmlArtifactSnapshot>>>
  /** 见 `HtmlArtifactProtocolStreamState.anonymousArtifactCounter`。 */
  readonly anonymousArtifactCounter: number
  /** 见 `HtmlArtifactProtocolStreamState.limits`，已冻结。 */
  readonly limits: Readonly<Required<HtmlArtifactProtocolLimits>>
}

/** 解析一段流吐出来的事件；宿主按 `type` 分流，自己决定怎么渲染。 */
export type HtmlArtifactProtocolEvent =
  | { type: 'markdown', text: string }
  | {
    type: 'artifact-open'
    artifact: HtmlArtifactDescriptor
    protocolText: string
  }
  | {
    type: 'artifact-update'
    artifact: HtmlArtifactDescriptor
    html: string
    isStreaming: boolean
    protocolText: string
  }
  | {
    type: 'artifact-patch'
    artifact: HtmlArtifactDescriptor
    patch: HtmlArtifactRenderPatch
    protocolText: string
  }
  | {
    type: 'artifact-diagnostic'
    artifact: HtmlArtifactDescriptor
    diagnostic: HtmlArtifactProtocolDiagnostic
    protocolText: string
  }
  | {
    type: 'artifact-close'
    artifact: HtmlArtifactDescriptor
    protocolText: string
  }

/** 制品源码是普通 HTML 还是一整张 SVG；两者的 body 样式与适配方式不同。 */
export type HtmlArtifactContentKind = 'html' | 'svg'

/** 一套桥接消息名：同页多个制品各用一套，互不串台。 */
export interface HtmlArtifactBridgeMessages {
  /** 宿主 → iframe：整份 HTML 渲染。 */
  render: string
  /** 宿主 → iframe：应用一批补丁。 */
  patch: string
  /** iframe → 宿主：上报测量出来的内容尺寸。 */
  resize: string
  /** iframe → 宿主：制品里调用 `sendPrompt()`。 */
  sendPrompt: string
  /** iframe → 宿主：制品里调用 `openLink()`。 */
  openLink: string
  /** iframe → 宿主：制品经 `artifactBridge.send()` 发来的自定义载荷。 */
  generic: string
  /** iframe → 宿主：沙箱里的脚本出错。 */
  error: string
}

/** 造一份静态制品文档（内容已经齐了）时可以给的东西。 */
export interface HtmlArtifactDocumentOptions {
  /** 内容按 HTML 还是 SVG 处理；不写就自动判。 */
  contentKind?: HtmlArtifactContentKind
  /** 产品中立的设计 CSS，插在制品自己的样式之前。 */
  designCss?: string
  /** SVG 内容的适配 CSS，只在 SVG 档生效。 */
  svgFitCss?: string
  /** 覆盖 body 的内联样式；不写按内容类型给一份缺省。 */
  bodyStyle?: string
  /** 覆盖桥接消息名；不写的那几个用常量表里的缺省值。 */
  bridgeMessages?: Partial<HtmlArtifactBridgeMessages>
  /** 文档一加载就应用的补丁。 */
  initialPatches?: readonly HtmlArtifactRenderPatch[]
  /** iframe 运行时向宿主申请的最大高度（像素）；再高的内容留在沙箱里滚。 */
  maxReportedHeight?: number
  /** iframe 运行时能申请的最大内容宽度，按宿主宽度的倍数。 */
  maxWidthRatio?: number
}

/** 造一份外壳文档（内容随后经消息桥送进去）时可以给的东西。 */
export interface HtmlArtifactShellDocumentOptions extends HtmlArtifactDocumentOptions {
  /** 承载制品的根元素 id；不写用常量表里的缺省值。 */
  rootId?: string
}

/** 宿主侧算出来的一次 frame 适配结果。 */
export interface HtmlArtifactFrameFit {
  /** 内容自己的高度（像素）。 */
  contentHeight: number
  /** 内容自己的宽度（像素）。 */
  contentWidth: number
  /** 是不是已经按真实测量锁定；没测出来时按兜底尺寸走。 */
  locked: boolean
  /** 宿主要施加的缩放比例，1 表示不缩放。 */
  scale: number
  /** 缩放之后 frame 占的高度（像素）。 */
  viewportHeight: number
  /** 缩放之后 frame 占的宽度（像素）。 */
  viewportWidth: number
}

/** 算一次 frame 适配要给的测量值。 */
export interface HtmlArtifactFrameFitInput {
  /** 还没测出来时用的高度（像素）。 */
  fallbackHeight: number
  /** 宿主留给 frame 的最大宽度（像素）。 */
  maxViewportWidth?: LooseOptional<number>
  /** iframe 上报的内容自然高度（像素）。 */
  naturalHeight?: LooseOptional<number>
  /** iframe 上报的内容自然宽度（像素）。 */
  naturalWidth?: LooseOptional<number>
  /** 内容没它宽时，要不要把 frame 铺满宿主宽度。 */
  preferViewportWidth?: boolean
}

/** 归一化一个外链时可以给的东西。 */
export interface NormalizeHtmlArtifactExternalUrlOptions {
  /** 放行哪些协议；不写用常量表里的 `http:` 与 `https:`。 */
  allowedProtocols?: readonly string[]
}
