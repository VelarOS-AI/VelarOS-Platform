/**
 * 包内的工作类型：三种请求的形状、路径准入的入参出参、一次请求校验的结果。
 * 请求形状是手写的单一来源，`utils/request.ts` 里的 schema 逐个 `satisfies z.ZodType<…>` 对齐它，走形就编译不过。
 */
import type { DocumentRendererFormats, DocumentRendererProtocol } from '../contract/constants.js'

/** 每条请求都带的两个字段：协议版本与本次调用的身份。 */
export interface RendererRequestHeader {
  /** 协议版本，对不上直接 INVALID_REQUEST。 */
  protocolVersion: typeof DocumentRendererProtocol.version
  /** 本次调用的身份，回执原样回显。 */
  requestId: string
}

/** 要落盘的两种操作都带的三条路径，全部相对 projectRoot 解释。 */
export interface RendererPathRequest extends RendererRequestHeader {
  /** 项目根目录；三条路径解开符号链接后都必须仍在它里面。 */
  projectRoot: string
  /** 要渲染的文件。 */
  inputPath: string
  /** 渲染结果写到哪；父目录不存在时由渲染器建出来。 */
  outputPath: string
}

/** describe 请求：只问身份与支持的格式，不碰磁盘。 */
export interface DescribeRendererRequest extends RendererRequestHeader {
  /** 操作名。 */
  operation: 'describe'
}

/** render-office 请求：把 Office 文档渲染成预览页或整页位图。 */
export interface RenderOfficeRequest extends RendererPathRequest {
  /** 操作名。 */
  operation: typeof DocumentRendererFormats.renderOffice.name
  /** 最多预览多少项（行、幻灯片、段落）；不填取可调参数里的缺省值。 */
  maxItems?: number
}

/** render-pdf-page 请求：把 PDF 的一页渲染成 PNG。 */
export interface RenderPdfPageRequest extends RendererPathRequest {
  /** 操作名。 */
  operation: typeof DocumentRendererFormats.renderPdfPage.name
  /** 渲染第几页，从 1 开始；不填渲染第一页。 */
  page?: number
  /** 缩放倍数；不填由渲染器按页面尺寸挑一个。 */
  scale?: number
}

/** 一条请求的三种形状，按 operation 判别。 */
export type DocumentRendererRequest =
  | DescribeRendererRequest
  | RenderOfficeRequest
  | RenderPdfPageRequest

/** 一次请求校验的结果：要么给出定型后的请求，要么给出一句中文说明。 */
export type DocumentRendererRequestCheck =
  | { ok: true, request: DocumentRendererRequest }
  | { ok: false, message: string }

/** 判定通过后的三条真实路径：落盘只认这里给出的绝对路径。 */
export interface RendererPathSet {
  /** 解开符号链接后的项目根目录。 */
  projectRoot: string
  /** 解开符号链接后的输入文件。 */
  inputPath: string
  /** 解开符号链接后的输出文件；它的父目录此时已经建好。 */
  outputPath: string
}
