/**
 * 常量表：独立文档渲染器命令协议的约定值。
 * 不 import 任何东西，`@velaros-ai/document-renderer/contracts` 直接把它交出去，调用方不必拉起渲染实现。
 */

/** 命令协议本身：一个进程恰好收一条 JSON 请求、回一条 JSON 回执。 */
export const DocumentRendererProtocol = Object.freeze({
  /** 协议版本。请求与回执都带它，对不上就不是同一套协议。 */
  version: 1,
  /** 产品名：describe 的回执按它自报身份，打包脚本核对的也是它。 */
  product: 'velar-document-renderer',
  /** 传输约定：一个进程一条请求一条回执，不做长连接、不做批量。 */
  transport: 'one-json-request-per-process',
  /** 包版本：describe 报的就是它；代码里只有这一处，与 package.json 的 version 由验收用例核对。 */
  packageVersion: '0.2.0',
} as const)

/** 回执里的四个错误码：调用方按码判断，不按文字。 */
export const DocumentRendererErrorCodes = Object.freeze({
  /** 请求不合法：JSON 语法错、字段缺失、值越界，都是它。 */
  invalidRequest: 'INVALID_REQUEST',
  /** 路径被拒：三条路径有一条解开符号链接后落在 projectRoot 之外，或者 outputPath 本身是符号链接。 */
  pathDenied: 'PATH_DENIED',
  /** 格式不支持：输入或输出的扩展名不在格式表里，或者这一页 PDF 渲染不出来。 */
  unsupportedFormat: 'UNSUPPORTED_FORMAT',
  /** 渲染失败：解析、渲染、落盘出错，说明里带上原因。 */
  renderFailed: 'RENDER_FAILED',
} as const)

/** 请求字段的公开上限：schema 按它校验，回执里的说明也引它。 */
export const DocumentRendererLimits = Object.freeze({
  /** requestId 最多多少字符；回执原样回显它。 */
  requestIdChars: 200,
  /** 三条路径每条最多多少字符，对齐常见文件系统的路径上限。 */
  pathChars: 4096,
  /** render-office 的 maxItems 最少几项。 */
  minimumOfficeItems: 1,
  /** render-office 的 maxItems 最多几项：再多预览页也读不过来。 */
  maximumOfficeItems: 200,
  /** render-pdf-page 的 scale 最小倍数。 */
  minimumPdfScale: 0.25,
  /** render-pdf-page 的 scale 最大倍数。 */
  maximumPdfScale: 4,
  /** 一页 PDF 渲染出来最多多少像素（四千万）：再大就超出单张位图的合理范围。 */
  maximumPdfPixels: 40_000_000,
} as const)

/** 两种渲染操作各自认的扩展名：describe 报的是它，校验用的也是它，改一处两边一起变。 */
export const DocumentRendererFormats = Object.freeze({
  /** Office 文档预览：三种输入、两种输出。 */
  renderOffice: {
    /** 操作名，请求里的 operation 填它。 */
    name: 'render-office',
    /** 认的输入扩展名，小写、带点。 */
    inputExtensions: ['.docx', '.pptx', '.xlsx'],
    /** 认的输出扩展名：`.html` 是预览页，`.png` 是整页位图。 */
    outputExtensions: ['.html', '.png'],
  },
  /** PDF 单页渲染：一种输入、一种输出。 */
  renderPdfPage: {
    /** 操作名，请求里的 operation 填它。 */
    name: 'render-pdf-page',
    /** 认的输入扩展名，小写、带点。 */
    inputExtensions: ['.pdf'],
    /** 认的输出扩展名。 */
    outputExtensions: ['.png'],
  },
} as const)

/** 本包读的环境变量：环境变量也是注入，先登记再用。 */
export const DocumentRendererEnvironmentVariables = Object.freeze({
  /** 打包后的资源根目录。 */
  resourcesRoot: {
    /** 变量名。 */
    name: 'VELAROS_DOCUMENT_RENDERER_RESOURCES_ROOT',
    /** 方向：宿主写、渲染器读。 */
    direction: 'input',
    /** 由产品启动器设成能力包的根目录；渲染 PDF 时从这里取 pdfjs 的标准字体，没设就交给 pdfjs 自己找。 */
    description: '打包后的资源根目录，产品启动器设置，渲染 PDF 时从这里取标准字体。',
  },
} as const)

/** 错误码的取值。 */
export type DocumentRendererErrorCode =
  (typeof DocumentRendererErrorCodes)[keyof typeof DocumentRendererErrorCodes]
