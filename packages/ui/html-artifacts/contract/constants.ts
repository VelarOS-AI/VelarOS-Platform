/**
 * 常量表：HTML 制品协议与沙箱外壳的约定值。
 * 不 import 任何东西，浏览器、渲染进程、扩展都能用（从 `@velaros-ai/ui/html-artifacts/contracts` 取）。
 * 同一个数字只在这里写一次：注入 iframe 的脚本、宿主侧的钳制、协议解析器都引这里，改一处三处跟着变。
 */

/** 线协议本身：版本冻结为 `1`，两端不商量；改线格式先升这里，旧版本一律当普通 Markdown 放过去。 */
export const HtmlArtifactProtocolContract = Object.freeze({
  /** 协议版本。`<artifact version="…">` 对不上这个值就不进制品模式。 */
  version: '1',
  /** 制品标签名：`<artifact …>` 开、`</artifact>` 收。 */
  artifactTag: 'artifact',
  /** 补丁标签名：`<patch …>` 开、`</patch>` 收。 */
  patchTag: 'patch',
  /** 载荷自带协议闭合标签时，用这个编码把它藏起来。 */
  base64Encoding: 'base64',
} as const)

/** 补丁的四种类型：整体替换、追加、样式、脚本。 */
export const HtmlArtifactPatchTypes = Object.freeze([
  'replace',
  'append',
  'style',
  'script',
] as const)

/** 解析器的三种模式：普通 Markdown、制品体内、补丁载荷内。 */
export const HtmlArtifactProtocolModes = Object.freeze([
  'markdown',
  'artifact',
  'action',
] as const)

/** 协议诊断码：解析期发现的问题按码上报，外面按码判断，不按文字。 */
export const HtmlArtifactProtocolDiagnosticCodes = Object.freeze(['invalid-base64'] as const)

/** 宿主错误的来源分段：外面按 `phase` 分流，不按文字。 */
export const HtmlArtifactHostErrorPhases = Object.freeze([
  'host',
  'protocol',
  'runtime',
  'security',
] as const)

/** 尺寸与文案的缺省值：iframe 内的注入脚本和浏览器宿主两侧共用同一组数字。 */
export const HtmlArtifactDefaults = Object.freeze({
  /** 运行时报出第一次测量之前，iframe 的高度（像素）。 */
  initialHeight: 360,
  /** iframe 允许向宿主申请的最大高度（像素）；再高的内容留在沙箱里滚。 */
  maxReportedHeight: 1200,
  /** iframe 允许申请的最大内容宽度，按宿主宽度的倍数；更宽的由宿主缩放。 */
  maxWidthRatio: 3,
  /** 宿主侧缩放的硬边界，按宿主宽度的倍数；超过它就停止缩放，免得正文被压成细条。 */
  hostMaxScaleDownWidthRatio: 4,
  /** `<artifact height="…">` 能声明的最小高度（像素）。 */
  declaredHeightMin: 160,
  /** `<artifact height="…">` 能声明的最大高度（像素）。 */
  declaredHeightMax: 1200,
  /** 制品没给标题时的缺省标题，会显示在 iframe 的 title 上。 */
  title: '实时 HTML 预览',
  /** 外壳文档里承载制品的根元素 id。 */
  rootId: 'velaros-html-artifact-root',
} as const)

/** 协议的资源上限缺省值：宿主可以经 `protocolLimits` 收紧，防不可信或异常超长的流把内存吃光。 */
export const HtmlArtifactProtocolLimitDefaults = Object.freeze({
  /** 跨 chunk 暂存的待解析缓冲区字符数上限。 */
  maxBufferLength: 16_384,
  /** 单个制品保留的 HTML 字符数上限。 */
  maxArtifactHtmlLength: 256_000,
  /** 单个制品保留的协议原文字符数上限（宿主要把原文存下来时用）。 */
  maxArtifactProtocolTextLength: 256_000,
  /** 单个补丁载荷的字符数上限。 */
  maxActionPayloadLength: 256_000,
  /** 制品标题的字符数上限，超出直接截断。 */
  maxArtifactTitleLength: 80,
  /** 制品 id 的字符数上限，超出直接截断。 */
  maxArtifactIdLength: 80,
  /** 补丁元数据（`target` / `id`）的字符数上限。 */
  maxPatchMetadataLength: 160,
} as const)

/** 宿主与 iframe 之间的消息名：滚轮转发是固定的，其余七个是缺省值，宿主可以按实例改。 */
export const HtmlArtifactBridgeMessageTypes = Object.freeze({
  /** iframe 自己滚不动时，请宿主代滚这一次滚轮手势。这个名字不随实例变，宿主要能认出任何一个制品发来的它。 */
  wheel: 'velaros:html-artifact-wheel',
  /** 七个桥接消息的缺省名；`mountHtmlArtifact` 会按实例换成带随机 id 的前缀，避免同页多个制品串台。 */
  defaults: Object.freeze({
    /** 宿主 → iframe：整份 HTML 渲染。 */
    render: 'velaros-html-artifact-render',
    /** 宿主 → iframe：应用一批补丁。 */
    patch: 'velaros-html-artifact-patch',
    /** iframe → 宿主：上报测量出来的内容尺寸。 */
    resize: 'velaros-html-artifact-resize',
    /** iframe → 宿主：制品里调用 `sendPrompt()` 继续提问。 */
    sendPrompt: 'velaros-html-artifact-send-prompt',
    /** iframe → 宿主：制品里调用 `openLink()` 打开外链。 */
    openLink: 'velaros-html-artifact-open-link',
    /** iframe → 宿主：制品经 `artifactBridge.send()` 发来的自定义载荷。 */
    generic: 'velaros-html-artifact-message',
    /** iframe → 宿主：沙箱里的脚本出错。 */
    error: 'velaros-html-artifact-error',
  } as const),
} as const)

/** 外链缺省只放行这两种协议；`javascript:` 一类主动执行型 URL 永远到不了宿主回调。 */
export const HtmlArtifactExternalUrlProtocols = Object.freeze(['http:', 'https:'] as const)

/** 补丁类型的取值。 */
export type HtmlArtifactPatchType = (typeof HtmlArtifactPatchTypes)[number]

/** 解析器模式的取值。 */
export type HtmlArtifactProtocolMode = (typeof HtmlArtifactProtocolModes)[number]

/** 协议诊断码的取值。 */
export type HtmlArtifactProtocolDiagnosticCode = (typeof HtmlArtifactProtocolDiagnosticCodes)[number]

/** 宿主错误来源分段的取值。 */
export type HtmlArtifactHostErrorPhase = (typeof HtmlArtifactHostErrorPhases)[number]
