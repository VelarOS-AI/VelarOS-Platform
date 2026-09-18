/**
 * 沙箱文档这件能力的唯一出口：造 iframe 文档、归一化源码、算 frame 适配、过外链白名单。
 * 实例是 `htmlArtifactDocuments`，全是纯计算，没有状态、不碰 DOM——自己托管 iframe 的宿主（ui、Desktop）用它。
 */
import type {
  HtmlArtifactContentKind,
  HtmlArtifactDocumentOptions,
  HtmlArtifactFrameFit,
  HtmlArtifactFrameFitInput,
  HtmlArtifactShellDocumentOptions,
  NormalizeHtmlArtifactExternalUrlOptions,
} from '../types/html-artifacts.js'
import { normalizeHtmlArtifactExternalUrl } from '../utils/external-url.js'
import { resolveHtmlArtifactFrameFit } from '../utils/frame-fit.js'
import {
  buildHtmlArtifactDocument,
  buildHtmlArtifactShellDocument,
  inferHtmlArtifactContentKind,
  normalizeHtmlArtifactSource,
} from '../utils/shell-document.js'

/**
 * 沙箱文档的能力面：宿主自己拿着 iframe 时要的那几件事。
 * 六个方法都是纯函数式的——同样的入参给同样的出参，不读全局、不写 DOM。实例归本包，进程里只有一份。
 */
export interface HtmlArtifactDocumentsApi {
  /** 造一份内容已经齐了的静态制品文档（下载、导出、一次性预览都走它）。 */
  buildDocument: (rawContent: string, options?: HtmlArtifactDocumentOptions) => string
  /** 造一份外壳文档：内容随后经消息桥一段一段送进去，流式渲染走它。 */
  buildShellDocument: (options?: HtmlArtifactShellDocumentOptions) => string
  /** 剥掉包住整段源码的 CDATA 或 Markdown 代码围栏；没有包装就原样返回。 */
  normalizeSource: (content: string) => string
  /** 判断一段源码是普通 HTML 还是一整张 SVG，两者的 body 样式与适配方式不同。 */
  inferContentKind: (content: string) => HtmlArtifactContentKind
  /** 按 iframe 报上来的自然尺寸算宿主该给的 frame 尺寸与缩放比。 */
  resolveFrameFit: (input: HtmlArtifactFrameFitInput) => HtmlArtifactFrameFit
  /** 过一道协议白名单的外链归一化；不合法返回 null，调用方据此拒绝跳转。 */
  normalizeExternalUrl: (
    value: unknown,
    options?: NormalizeHtmlArtifactExternalUrlOptions,
  ) => Nullable<string>
}

class HtmlArtifactDocuments implements HtmlArtifactDocumentsApi {
  public buildDocument(rawContent: string, options: HtmlArtifactDocumentOptions = {}): string {
    return buildHtmlArtifactDocument(rawContent, options)
  }

  public buildShellDocument(options: HtmlArtifactShellDocumentOptions = {}): string {
    return buildHtmlArtifactShellDocument(options)
  }

  public normalizeSource(content: string): string {
    return normalizeHtmlArtifactSource(content)
  }

  public inferContentKind(content: string): HtmlArtifactContentKind {
    return inferHtmlArtifactContentKind(content)
  }

  public resolveFrameFit(input: HtmlArtifactFrameFitInput): HtmlArtifactFrameFit {
    return resolveHtmlArtifactFrameFit(input)
  }

  public normalizeExternalUrl(
    value: unknown,
    options: NormalizeHtmlArtifactExternalUrlOptions = {}
  ): Nullable<string> {
    return normalizeHtmlArtifactExternalUrl(value, options)
  }
}

export const htmlArtifactDocuments: HtmlArtifactDocumentsApi = new HtmlArtifactDocuments()
