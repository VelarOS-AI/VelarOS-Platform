declare module 'velaros:office' {
  /**
   * 办公文档：生成 Word、PowerPoint、Excel，读 PDF 的文字、编辑 PDF，Word 转 PDF、LaTeX 编译成 PDF，预览 Office 文档，把文档转成 Markdown。
   * 路径怎么写、能到哪儿由当前空间决定（环境报告里写着），出了空间的根一律拒绝；目标文件已经在时要传 overwrite: true 才覆盖。
   * 失败抛的错误带 code：OFFICE_OUTPUT_EXISTS 文件已在、OFFICE_INPUT_MISSING 输入文件不在、OFFICE_PATH_OUTSIDE_PROJECT 出了工作区根、
   * OFFICE_CONVERTER_MISSING 本机缺 LibreOffice 或 LaTeX 编译器（照 message 告诉用户，不要自己去装）、
   * OFFICE_CONVERSION_FAILED 外部转换失败（message 里有命令输出的结尾，LaTeX 就照着改源码再编）、OFFICE_MARKITDOWN_UNAVAILABLE 没装 MarkItDown。
   * 要把 PDF 变成 Word：readPdf 读出文字，再用 createWord 按页写成标题与段落。
   */

  /** 生成 Word 文档（.docx），或把新内容接在已有文档末尾。
   */
  export function createWord(input: OfficeWordInput): Promise<OfficeWritten>

  /** 生成 PowerPoint 演示文稿（.pptx）：给 Markdown 自动排版，或逐页给元素精细控制。
   */
  export function createPresentation(input: OfficePresentationInput): Promise<OfficeWritten>

  /** 生成 Excel 工作簿（.xlsx）：给 CSV、Markdown 表格自动成表，或给结构化工作表（多表、公式、样式、合并、冻结）。
   */
  export function createSpreadsheet(input: OfficeSpreadsheetInput): Promise<OfficeWritten>

  /** 按页读文本型 PDF 的可选择文字。
   */
  export function readPdf(input: OfficeReadPdfInput): Promise<OfficePdfText>

  /** 把 Word 文档转成 PDF，尽量保留排版（要本机装了 LibreOffice）。
   */
  export function wordToPdf(input: OfficeWordToPdfInput): Promise<OfficeWritten>

  /** 把 LaTeX 源码编译成 PDF：论文、数学公式、要求严格排版的文档；普通文档用 createWord 就好。
   */
  export function latexToPdf(input: OfficeLatexInput): Promise<OfficeLatexCompiled>

  /** 编辑 PDF 写成新文件：挑页、重排、删页、旋转、贴文字、改文档信息。
   */
  export function editPdf(input: OfficeEditPdfInput): Promise<OfficeWritten>

  /** 预览 Word、PowerPoint、Excel 文档的结构与正文，检查生成的文档对不对；也可以写出 HTML 或 PNG 预览给人看。
   */
  export function preview(input: OfficePreviewInput): Promise<OfficePreview>

  /** 用 MarkItDown 把 PDF、Office、HTML、CSV、JSON、EPub 这类文档转成 Markdown 来读（要装了 MarkItDown）。
   */
  export function toMarkdown(input: OfficeMarkdownInput): Promise<OfficeMarkdown>

  /**
   * 生成 Word（.docx）：outputPath 必填（最多 1200 个字符，没写扩展名补 .docx）；正文给 content（Markdown 或纯文本，自动排成标题、段落、列表、表格）
   * 或 blocks（结构化内容块，最多 500 块），只给一样。
   * title 最多 200 个字符；author 最多 120 个字符，不给就留空。profile 选排版：standard 普通文档、academic-paper 学术论文、thesis 毕业论文，
   * 后两种会用上 metadata（封面信息）、abstract（摘要，最多 20000 个字符）、keywords（最多 30 个，每个最多 80 个字符）与 includeTableOfContents（目录）；
   * language 是封面标签与默认字体的语言。文件已在时要 overwrite: true 才覆盖；appendMode: true 且文件已在时把新内容接在原文末尾（不需要 overwrite）。
   */
  interface OfficeWordInput {
    outputPath: string
    content?: string
    blocks?: WordBlock[]
    title?: string
    author?: string
    profile?: WordDocumentProfile
    language?: WordDocumentLanguage
    metadata?: WordDocumentMetadata
    abstract?: string
    keywords?: string[]
    includeTableOfContents?: boolean
    overwrite?: boolean
    appendMode?: boolean
  }

  /** 写出的一个文件：path 是绝对路径，bytes 是字节数；created 为假表示覆盖（或追加）了已有的文件。 */
  interface OfficeWritten {
    path: string
    bytes: number
    created: boolean
  }

  /**
   * 生成 PowerPoint（.pptx）：outputPath 必填（没写扩展名补 .pptx）；给 content（Markdown 或纯文本：# 标题开新页、--- 分页，自动排版）
   * 或 slides（结构化页面，最多 200 页，每页最多 200 个元素），只给一样。template 选自动排版的风格（缺省 modern），
   * layout 选页面比例（缺省 LAYOUT_WIDE，13.333×7.5 英寸），theme 改标题与正文字体（PptxGenJS 的 headFontFace、bodyFontFace）。
   * title 最多 200 个字符，author 最多 120 个字符，不给就留空；rtlMode 是从右往左排版。文件已在时要 overwrite: true 才覆盖。
   */
  interface OfficePresentationInput {
    outputPath: string
    content?: string
    slides?: PresentationSlideInput[]
    template?: PresentationTemplate
    layout?: 'LAYOUT_4x3' | 'LAYOUT_16x9' | 'LAYOUT_16x10' | 'LAYOUT_WIDE'
    theme?: { headFontFace?: string; bodyFontFace?: string }
    title?: string
    author?: string
    rtlMode?: boolean
    overwrite?: boolean
  }

  /**
   * 生成 Excel（.xlsx）：outputPath 必填（没写扩展名补 .xlsx）；给 content（CSV、TSV、Markdown 表格或 JSON 行数组，自动成一张表）
   * 或 sheets（结构化工作表，最多 100 张），只给一样。title 最多 200 个字符，author 最多 120 个字符，不给就留空。
   * 文件已在时要 overwrite: true 才覆盖。
   */
  interface OfficeSpreadsheetInput {
    outputPath: string
    content?: string
    sheets?: SpreadsheetSheetInput[]
    title?: string
    author?: string
    overwrite?: boolean
  }

  /**
   * 读 PDF 的可选择文本：inputPath 是 .pdf。pages 指定页码（从 1 起，最多 100 个），maxPages 从第一页起读几页（最多 100）；
   * 两样只能给一样，都不给就读前 20 页。扫描件或图片型 PDF 读不出文字（这里不做 OCR）。
   */
  interface OfficeReadPdfInput {
    inputPath: string
    pages?: number[]
    maxPages?: number
  }

  /**
   * 读出的 PDF 文本：pageCount 是总页数，pages 是这次读到的页（按你给的顺序，重复的页码只读一次）；
   * hasMore 为真表示还有没读的页，要读就再调一次、用 pages 指定。
   */
  interface OfficePdfText {
    path: string
    pageCount: number
    pages: OfficePdfPage[]
    hasMore: boolean
  }

  /** Word 转 PDF：inputPath 是 .docx 或 .doc，outputPath 没写扩展名补 .pdf；文件已在时要 overwrite: true 才覆盖。要本机装了 LibreOffice。 */
  interface OfficeWordToPdfInput {
    inputPath: string
    outputPath: string
    overwrite?: boolean
  }

  /**
   * 编译 LaTeX 成 PDF：latexSource 是完整源码，先写成 .tex（sourcePath，缺省与 PDF 同名同目录）再编译到 outputPath。
   * compiler 缺省 auto（按 tectonic、latexmk、xelatex、pdflatex 的顺序找本机装了的）；runs 是 xelatex、pdflatex 编几轮（缺省 2，最多 3），
   * 另两个编译器自己决定轮数。.tex 或 PDF 已在时要 overwrite: true 才覆盖。
   */
  interface OfficeLatexInput {
    outputPath: string
    latexSource: string
    sourcePath?: string
    compiler?: LatexCompiler
    runs?: number
    overwrite?: boolean
  }

  /** 编译出的 PDF：写出的 PDF，加上 .tex 源码写在哪（sourcePath）与用的是哪个编译器。 */
  interface OfficeLatexCompiled extends OfficeWritten {
    sourcePath: string
    compiler: string
  }

  /**
   * 编辑 PDF，写成新文件：页码都指原 PDF 的页（从 1 起）。pageSelection 按给的顺序挑页（可以重排、重复），removePages 去掉这些页，
   * rotatePages 把某页转 90、180 或 270 度；三个列表各最多 1000 项。textStamps 贴文字（最多 500 条），metadata 改文档信息。
   * outputPath 已经在（比如就是输入的那个文件）时要 overwrite: true。
   */
  interface OfficeEditPdfInput {
    inputPath: string
    outputPath: string
    pageSelection?: number[]
    removePages?: number[]
    rotatePages?: Array<{ page: number; degrees: 90 | 180 | 270 }>
    textStamps?: PdfTextStampInput[]
    metadata?: PdfMetadataInput
    overwrite?: boolean
  }

  /**
   * 预览 Office 文档：inputPath 是 .docx、.doc、.pptx 或 .xlsx（.doc 要本机装了 LibreOffice）。maxItems 是大纲、幻灯片、工作表最多列几条（缺省 80，最多 200）。
   * 要预览文件就给 outputPath：.html 写净化过的 HTML 页（没写扩展名就是它），.png 写一张预览图；已在时要 overwrite: true。
   * autoRefresh: true 才往 HTML 里加定时刷新的脚本。
   */
  interface OfficePreviewInput {
    inputPath: string
    maxItems?: number
    outputPath?: string
    overwrite?: boolean
    autoRefresh?: boolean
  }

  /**
   * 文档预览：kind 是文档类型，title 是标题；summary 是整份文档的计数——Word 有 headings、paragraphs、tables、images，
   * PowerPoint 有 slides、charts、images 与这次预览了几页 previewedSlides，Excel 有 sheets 与 previewedSheets。
   * outline（Word 的标题大纲）、slides（每页的标题与要点）、sheets（每张表的行列数与前几行）只有对应类型才有，
   * 条数最多 maxItems。contentHtml 是正文的净化 HTML，太长时截断、contentTruncated 为真。written 只在给了 outputPath 时出现。
   */
  interface OfficePreview {
    path: string
    kind: 'docx' | 'pptx' | 'xlsx'
    title: string
    summary: Record<string, number>
    outline?: PreviewOutlineItem[]
    slides?: PreviewSlide[]
    sheets?: PreviewSheet[]
    contentHtml: string
    contentTruncated: boolean
    written?: OfficePreviewWritten
  }

  /**
   * 用 MarkItDown 把文档转成 Markdown：inputPath 是 .pdf、.doc、.docx、.ppt、.pptx、.xls、.xlsx、.html、.htm、.csv、.json、.xml、.zip、.epub、.txt、.md 或 .markdown，
   * 只认工作区里的文件、不收网址。maxChars 是交回多少字符（缺省 60000，1000 到 200000）；给 outputPath 就把完整 Markdown 写进去（没写扩展名补 .md），
   * 已在时要 overwrite: true。
   */
  interface OfficeMarkdownInput {
    inputPath: string
    maxChars?: number
    outputPath?: string
    overwrite?: boolean
  }

  /**
   * 转出的 Markdown：markdown 最多 maxChars 个字符，truncated 为真表示没交全。给了 outputPath 时交回的是开头，完整的文件照样写下（written）；
   * 没给时文档太长只拿得到结尾一段（markdown 第一行有注释说明）——要看全就给 outputPath，再按需读那个文件。
   */
  interface OfficeMarkdown {
    path: string
    markdown: string
    truncated: boolean
    written?: OfficeWritten
  }

  /**
   * 一个内容块，kind 说是哪种：heading 标题（text 最多 500 个字符，level 1 到 3，缺省 1）；paragraph 段落（text 最多 20000 个字符，或 runs 富文本；
   * spaceBefore、spaceAfter 是段前段后间距，单位是二十分之一磅；indent 是缩进）；bullets 列表（ordered 为真是 1. 2. 3. 编号列表，否则是项目符号；最多 200 项，
   * 每项最多 1000 个字符，level 是缩进层级 0 到 8）；
   * table 表格（最多 500 行、每行最多 30 格；header 为真第一行当表头，widthPct 是宽度占页宽的百分比 10 到 100）；pageBreak 分页。
   */
  type WordBlock =
    | {
        kind: 'heading'
        text: string
        level?: 1 | 2 | 3
        color?: string
        align?: 'left' | 'center' | 'right'
      }
    | {
        kind: 'paragraph'
        text?: string
        runs?: WordTextRun[]
        align?: 'left' | 'center' | 'right' | 'justify'
        spaceBefore?: number
        spaceAfter?: number
        indent?: number
      }
    | {
        kind: 'bullets'
        ordered?: boolean
        items: Array<string | { text: string; runs?: WordTextRun[]; level?: number }>
      }
    | {
        kind: 'table'
        rows: WordTableCellInput[][]
        header?: boolean
        headerBgColor?: string
        borderColor?: string
        widthPct?: number
      }
    | { kind: 'pageBreak' }

  /** 排版模板：standard 普通文档、academic-paper 学术论文、thesis 毕业论文。 */
  type WordDocumentProfile = 'standard' | 'academic-paper' | 'thesis'

  /** 文档语言：决定封面标签的文字与默认字体，zh-CN 中文、en-US 英文。 */
  type WordDocumentLanguage = 'zh-CN' | 'en-US'

  /** 封面信息（学术论文、毕业论文用）：subtitle 最多 200 个字符；学校、院系、专业、课程、导师、单位最多 120 个字符；班级、学号、日期最多 80 个字符。 */
  type WordDocumentMetadata = {
    subtitle?: string
    school?: string
    department?: string
    major?: string
    course?: string
    className?: string
    studentId?: string
    advisor?: string
    date?: string
    organization?: string
  }

  /**
   * 一页幻灯片：elements 是这页的元素（最多 200 个），notes 是演讲者备注；
   * background 是背景色（color，六位十六进制如 'F5F5F5'）或背景图（path 是工作区里的图片，或 data 给 base64）。
   */
  interface PresentationSlideInput {
    background?: { color?: string; path?: string; data?: string }
    elements: PptElement[]
    notes?: string
  }

  /** 自动排版的风格：modern 现代、consulting 咨询汇报、academic 学术、minimal 极简。 */
  type PresentationTemplate = 'modern' | 'consulting' | 'academic' | 'minimal'

  /**
   * 一张工作表：name 最多 31 个字符；rows 是各行的格（最多 100000 行、每行最多 1000 格），columns 给了第一行就是表头。
   * freezeRows、freezeCols 冻结前几行、前几列；tabColor 是标签颜色；headerStyle 是表头样式；
   * numberFormats 按区域定数字格式，比如 { 'B2:B100': '#,##0.00' }（一个区域最多 100000 格）。
   */
  type SpreadsheetSheetInput = {
    name: string
    columns?: ExcelColumnDef[]
    rows: ExcelCellInput[][]
    freezeRows?: number
    freezeCols?: number
    tabColor?: string
    showGridLines?: boolean
    headerStyle?: ExcelCellStyle
    numberFormats?: Record<string, string>
  }

  /** PDF 的一页：page 从 1 起；text 是这页的可选择文本，扫描件或纯图片页是空串。 */
  interface OfficePdfPage {
    page: number
    text: string
  }

  /** LaTeX 编译器：auto 按 tectonic、latexmk、xelatex、pdflatex 的顺序找本机装了的，也可以点名一个。 */
  type LatexCompiler = 'auto' | 'tectonic' | 'latexmk' | 'xelatex' | 'pdflatex'

  /**
   * 贴在 PDF 上的一段文字（水印、批注）：text 最多 2000 个字符，只写得了拉丁字母、数字和常见西文标点（用的是标准字体 Helvetica，中文等其他文字会被拒绝）。page 指原 PDF 的页码，allPages 为真就每页都贴，两样都不给也是每页都贴。
   * x、y 是离页面左下角的距离（点，缺省 48、48），size 是字号（4 到 96，缺省 14），color 是六位十六进制颜色（可带 #，缺省 DC2626 红色），opacity 是 0 到 1（缺省 0.9）。
   */
  type PdfTextStampInput = {
    text: string
    page?: number
    allPages?: boolean
    x?: number
    y?: number
    size?: number
    color?: string
    opacity?: number
  }

  /** PDF 的文档信息：title 最多 200 个字符，author 最多 120 个字符，subject 最多 300 个字符，keywords 最多 30 个。 */
  type PdfMetadataInput = {
    title?: string
    author?: string
    subject?: string
    keywords?: string[]
  }

  /** 大纲里的一条标题：level 是标题级别（1 最高）。 */
  type PreviewOutlineItem = {
    level?: number
    title: string
  }

  /** 一页幻灯片的摘录：index 从 1 起，title 是标题，bullets 是这页的文字要点。 */
  type PreviewSlide = {
    index: number
    title: string
    bullets: string[]
  }

  /** 一张工作表的摘录：rowCount、columnCount 是整张表的行列数，rows 是前几行的文字。 */
  type PreviewSheet = {
    name: string
    rowCount: number
    columnCount: number
    rows: string[][]
  }

  /** 写出的预览文件；PNG 还带图的宽高（像素）。 */
  interface OfficePreviewWritten extends OfficeWritten {
    width?: number
    height?: number
  }

  /**
   * 一段富文本：text 加上样式。color 是六位十六进制（如 '1F4E79'），highlight 是荧光笔颜色，fontSize 是磅数，font 是字体名；
   * link 给了就是超链接；break 是这段前面换几行。
   */
  type WordTextRun = {
    text: string
    bold?: boolean
    italic?: boolean
    underline?: boolean
    strike?: boolean
    color?: string
    highlight?:
      | 'yellow'
      | 'green'
      | 'cyan'
      | 'magenta'
      | 'blue'
      | 'red'
      | 'darkBlue'
      | 'darkCyan'
      | 'darkGreen'
      | 'darkMagenta'
      | 'darkRed'
      | 'darkYellow'
      | 'darkGray'
      | 'lightGray'
      | 'black'
    fontSize?: number
    font?: string
    superScript?: boolean
    subScript?: boolean
    link?: string
    break?: number
  }

  /** 表格的一格：text 或 runs（富文本）给一样，bgColor 是底色；columnSpan、rowSpan 是向右、向下合并几格。 */
  type WordTableCellInput = {
    text?: string
    runs?: WordTextRun[]
    bold?: boolean
    color?: string
    bgColor?: string
    align?: 'left' | 'center' | 'right' | 'justify'
    verticalAlign?: 'top' | 'center' | 'bottom'
    columnSpan?: number
    rowSpan?: number
  }

  /**
   * 一页上的一个元素：x、y、w、h 是位置与大小（英寸，宽屏页是 13.333×7.5），options 是 PptxGenJS 同名方法的选项，原样交过去。
   * text 的 value 是文字或富文本段；table 的 rows 是二维表；shape 是形状名（rect、roundRect、ellipse、line……）；
   * image 的 data 是图片的 base64（不带 data: 前缀），type 缺省 png；chart 的 chartType 是 bar、line、pie、area、doughnut 这类，
   * data 是 PptxGenJS 的系列数组（每项 { name, labels, values }）。
   */
  type PptElement =
    | {
        kind: 'text'
        value: string | PptTextProps[]
        x: number
        y: number
        w: number
        h: number
        options?: Record<string, unknown>
      }
    | {
        kind: 'table'
        rows: PptTableCell[][]
        x: number
        y: number
        w: number
        h: number
        options?: Record<string, unknown>
      }
    | {
        kind: 'shape'
        shape: string
        x: number
        y: number
        w: number
        h: number
        options?: Record<string, unknown>
      }
    | {
        kind: 'image'
        data: string
        type?: 'png' | 'jpeg' | 'gif' | 'svg' | 'bmp' | 'webp'
        x: number
        y: number
        w: number
        h: number
        options?: Record<string, unknown>
      }
    | {
        kind: 'chart'
        chartType: string
        data: Array<Record<string, unknown>>
        x: number
        y: number
        w: number
        h: number
        options?: Record<string, unknown>
      }

  /** 一列：只写表头文字，或写对象给 header、width（列宽，字符数）与这一列的缺省样式 style。 */
  type ExcelColumnDef =
    | string
    | {
        header: string
        key?: string
        width?: number
        style?: ExcelCellStyle
      }

  /**
   * 一格：直接写值（文字、数字、布尔，null 是空格），或写对象——value 值，dateValue 日期（ISO 8601，如 '2026-09-18'），formula 公式（不带 =），
   * 加上 numFmt、font、fill、border、alignment 这些样式；link 超链接，richText 富文本，colSpan、rowSpan 向右、向下合并几格。
   */
  type ExcelCellInput = (
    | string
    | number
    | boolean
    | {
        value?: string | number | boolean
        dateValue?: string
        formula?: string
        numFmt?: string
        font?: ExcelFont
        fill?: ExcelFill
        border?: ExcelBorders
        alignment?: ExcelAlignment
        rowHeight?: number
        link?: string
        tooltip?: string
        richText?: Array<{ text: string; font?: ExcelFont }>
        colSpan?: number
        rowSpan?: number
      }
  ) | null

  /** 一套单元格样式，用在表头（headerStyle）与列的缺省样式上：numFmt 是数字格式（如 '#,##0.00'、'0%'、'yyyy-mm-dd'，最多 120 个字符）。 */
  type ExcelCellStyle = {
    numFmt?: string
    font?: ExcelFont
    fill?: ExcelFill
    border?: ExcelBorders
    alignment?: ExcelAlignment
    /** 常用表头样式的扁平简写；复杂样式仍使用 font/fill。 */
    bold?: boolean
    italic?: boolean
    color?: string
    bgColor?: string
  }

  /** 富文本的一段：options 是 PptxGenJS 的文本选项（bold、italic、color、fontSize、fontFace、breakLine……），原样交过去。 */
  interface PptTextProps {
    text: string
    options?: Record<string, unknown>
  }

  /** 表格的一格：文字、数字，或带 PptxGenJS 单元格选项（fill、color、bold、align……）的一格。 */
  type PptTableCell = string | number | { text: string; options?: Record<string, unknown> }

  /** 字体：name 字体名，size 磅数，color 六位十六进制（如 '1F2937'）。 */
  type ExcelFont = {
    name?: string
    size?: number
    bold?: boolean
    italic?: boolean
    underline?: boolean | 'none' | 'single' | 'double' | 'singleAccounting' | 'doubleAccounting'
    strike?: boolean
    color?: string
  }

  /** 填充：纯色写 { type: 'pattern', pattern: 'solid', fgColor: 'FFF2CC' }；渐变写 type: 'gradient' 加 stops。 */
  type ExcelFill =
    | { type: 'pattern'; pattern?: string; fgColor?: string; bgColor?: string }
    | {
        type: 'gradient'
        gradient?: 'angle' | 'path'
        degree?: number
        stops?: Array<{ position: number; color: string }>
      }

  /** 单元格的四条边框。 */
  type ExcelBorders = {
    top?: ExcelBorderSide
    left?: ExcelBorderSide
    bottom?: ExcelBorderSide
    right?: ExcelBorderSide
  }

  /** 对齐：horizontal、vertical 是水平与垂直对齐，wrapText 自动换行，indent 缩进，textRotation 文字旋转角度。 */
  type ExcelAlignment = {
    horizontal?: 'left' | 'center' | 'right' | 'fill' | 'justify' | 'centerContinuous' | 'distributed'
    vertical?: 'top' | 'middle' | 'bottom' | 'distributed' | 'justify'
    wrapText?: boolean
    shrinkToFit?: boolean
    indent?: number
    textRotation?: number
  }

  /** 一条边框：style 是线型，color 六位十六进制。 */
  type ExcelBorderSide = {
    style?:
      | 'thin'
      | 'dotted'
      | 'hair'
      | 'medium'
      | 'double'
      | 'thick'
      | 'dashed'
      | 'dashDot'
      | 'dashDotDot'
      | 'slantDashDot'
      | 'mediumDashed'
      | 'mediumDashDotDot'
      | 'mediumDashDot'
    color?: string
  }
}
