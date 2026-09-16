/**
 * 包内可调参数：外部命令的超时与输出窗口、各种缺省条数、排版与渲染的尺寸。都是取舍，没有唯一正确的值；要调就改这一个文件，全包跟着变。
 *
 * 常量按四处放（ADR 0007）：
 * - 对外承诺的（工具名、错误码、环境变量、写进工具说明和 schema 的上限）在 `contract/constants.ts`，改了等于改契约；
 * - 可调的都在这里，按用途分组、每项一句说明；impl 与 utils 里不再散写数字缺省值，门禁核对；
 * - 某个类里固定用的文案、模式、名单写成那个类的 `private static readonly`；
 * - 规则本身的数据（净化白名单、学术模板名单、模板配色）跟着规则写在各自的 utils 文件里。
 */

/** office 包的可调参数，按用途分组。 */
export const OfficeTuning = Object.freeze({
  /** 跑外部命令：LibreOffice、LaTeX 编译器、MarkItDown 都经宿主端口的 runCommand。 */
  command: Object.freeze({
    /** 没有特别指定时，外部命令跑多久算超时，毫秒。 */
    timeoutMs: 120_000,
    /** LibreOffice 的 headless 转换给多久，毫秒；它冷启动慢，比通用超时宽。 */
    libreOfficeTimeoutMs: 180_000,
    /** LaTeX 每一轮编译给多久，毫秒。 */
    latexRunTimeoutMs: 180_000,
    /** MarkItDown 单次转换给多久，毫秒。 */
    markItDownTimeoutMs: 180_000,
    /** 从命令的 stdout、stderr 各收多少字符；办公转换输出较多，比宿主缺省宽。 */
    outputChars: 20_000,
  }),
  /** 文档转 Markdown。 */
  markdown: Object.freeze({
    /** 没传 maxChars 时，工具返回多少字符的 Markdown。 */
    returnChars: 60_000,
    /** 走 stdout 时，命令输出窗口在 maxChars 之上再多留多少字符，用来分辨「真被窗口截过」。 */
    stdoutHeadroomChars: 4_000,
  }),
  /** Word 文档生成。 */
  word: Object.freeze({
    /** 纯文本段落超过多少字符就拆成多个 Word 段落，避免单个段落节点过大。 */
    plainParagraphChars: 12_000,
    /** 段落没声明 spaceAfter 时的段后间距（docx 的二十分之一磅）。 */
    paragraphSpaceAfter: 160,
  }),
  /** PowerPoint 生成。 */
  presentation: Object.freeze({
    /** 自动拆页时单页正文最多多少字符，再多就会溢出版心。 */
    slideBodyChars: 2_800,
    /** 宽屏版心宽度，英寸。 */
    slideWidthInches: 13.333,
    /** 宽屏版心高度，英寸。 */
    slideHeightInches: 7.5,
  }),
  /** PDF 处理与渲染。 */
  pdf: Object.freeze({
    /** 没传 scale 时按多少倍渲染页面。 */
    renderScale: 1.5,
    /** 单页渲染结果最多多少像素，超了拒绝渲染而不是吃满内存。 */
    renderPixels: 40_000_000,
    /** xelatex / pdflatex 没传 runs 时跑几轮，够解析目录与交叉引用。 */
    latexRuns: 2,
    /** 文字戳没给字号时用多大。 */
    textStampFontSize: 14,
    /** 文字戳没给坐标时距页面左边多少点。 */
    textStampX: 48,
    /** 文字戳没给坐标时距页面底边多少点。 */
    textStampY: 48,
    /** 文字戳没给透明度时的不透明度。 */
    textStampOpacity: 0.9,
  }),
  /** 文档预览与预览图。 */
  preview: Object.freeze({
    /** 没传 maxItems 时预览多少个条目（幻灯片、工作表、标题）。 */
    items: 80,
    /** 工具结果里的 contentHtml 最多带多少字符，超出部分标成已截断。 */
    contentHtmlChars: 16_000,
    /** 预览 HTML 里内嵌图片的 data URL 最多多少字符，超了直接丢弃这张图。 */
    imageDataUrlChars: 8_388_608,
    /** 预览图画布宽度，像素。 */
    imageWidth: 1200,
    /** 预览图四周留白，像素。 */
    imagePadding: 56,
    /** 预览图里一行内容占多高，像素。 */
    imageRowHeight: 54,
    /** 预览图最矮多少像素。 */
    imageMinHeight: 420,
    /** 预览图最高多少像素。 */
    imageMaxHeight: 1_800,
    /** 预览图表头（类型标签与标题）占多高，像素；正文行从它下面开始排。 */
    imageHeaderHeight: 238,
    /** 预览图最多画多少行内容。 */
    imageRows: 18,
  }),
} as const)
