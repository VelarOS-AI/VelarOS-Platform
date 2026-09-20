/**
 * 约定的常量表（对外合同的一部分）：错误码、环境变量表、写进声明给模型看的上限、MarkItDown 认的扩展名。
 * 程序与宿主按错误码判断失败、按环境变量表配置本单元；上限写进 `velaros:office` 的声明，也是入参核对用的那一份。
 * 包内可调、不对外承诺的参数不在这里，在 `utils/tuning.ts`。
 * 不 import 任何东西、不用 Node 专属类型，整个文件随 `./office/contracts` 入口出包。
 */

/**
 * office 能力对外承诺的错误语义：操作失败时抛的专属码，模型的程序与宿主都按它分支。
 *
 * 失败关闭是默认姿态：路径越界、目标已存在、缺转换器时一律拒绝执行，不降级、不静默覆盖。
 * 码本身是契约的一部分，不得改名；文字说明随时可能改。
 * 没有专属码的失败沿用 `@velaros-ai/core` 的通用 `AppError` 码（入参不对是 `VALIDATION`）。
 */
export const OfficeErrorCodes = Object.freeze({
  /** 读写目标按真实路径算不在空间给的工作区根内（含符号链接逃逸）。 */
  pathOutsideProject: 'OFFICE_PATH_OUTSIDE_PROJECT',
  /** 目标文件已存在且没有显式传 overwrite。 */
  outputExists: 'OFFICE_OUTPUT_EXISTS',
  /** 输入或输出路径的扩展名不是这个操作接受的那几种。 */
  invalidExtension: 'OFFICE_INVALID_EXTENSION',
  /** 输入文件不存在，或存在但不是普通文件。 */
  inputMissing: 'OFFICE_INPUT_MISSING',
  /** blocks / slides / sheets / content 都为空，没有可写入的内容。 */
  emptyContent: 'OFFICE_EMPTY_CONTENT',
  /** 本机缺少完成这次转换所需的外部命令（LibreOffice、LaTeX 编译器）。 */
  converterMissing: 'OFFICE_CONVERTER_MISSING',
  /** 外部转换命令失败（退出码不为零、编译出错）或跑完了却没有产出预期文件；message 带命令输出的结尾。 */
  conversionFailed: 'OFFICE_CONVERSION_FAILED',
  /** MarkItDown runtime 没安装或被用户停用。 */
  markItDownUnavailable: 'OFFICE_MARKITDOWN_UNAVAILABLE',
  /** Word 追加模式的目标文档结构不完整，续写下去会写坏文件。 */
  appendTargetInvalid: 'OFFICE_APPEND_TARGET_INVALID',
  /** 请求的 PDF 页码不是正整数。 */
  pdfPageInvalid: 'OFFICE_PDF_PAGE_INVALID',
  /** 请求的 PDF 页码超出文档实际页数。 */
  pdfPageOutOfRange: 'OFFICE_PDF_PAGE_OUT_OF_RANGE',
  /** PDF 渲染倍率不是正数。 */
  pdfRenderScaleInvalid: 'OFFICE_PDF_RENDER_SCALE_INVALID',
  /** 按当前倍率渲染这一页会超过像素安全上限。 */
  pdfRenderPixelLimit: 'OFFICE_PDF_RENDER_PIXEL_LIMIT',
} as const)

/** 错误码的联合类型，外面按它分支处理失败。 */
export type OfficeErrorCode = (typeof OfficeErrorCodes)[keyof typeof OfficeErrorCodes]

/** 本包读的环境变量；宿主要改本包行为只能经这张表，代码里冒出未登记的名字门禁会拦。 */
export const OfficeEnvironmentVariables = Object.freeze({
  markItDownResourceRoot: {
    name: 'VELAROS_MARKITDOWN_RESOURCE_ROOT',
    direction: 'input',
    description:
      'MarkItDown runtime 的额外资源根，多个用平台的路径分隔符隔开；配了就只认它，不再推导默认根。',
  },
  pdfjsStandardFontsRoot: {
    name: 'VELAROS_PDFJS_STANDARD_FONTS_ROOT',
    direction: 'input',
    description: 'pdfjs 标准字体目录的根；打包产物把字体挪了位置时用它指过去。',
  },
} as const)

/** 三个创建操作的入参上限：写进声明给模型看，入参核对用的也是这一份。 */
export const OfficeInputLimits = Object.freeze({
  /** 输入与输出路径最多多少字符。 */
  pathChars: 1200,
  /** 文档标题最多多少字符。 */
  titleChars: 200,
  /** 作者、学校、院系、专业、课程、指导教师、单位这类短字段最多多少字符。 */
  shortFieldChars: 120,
  /** 班级、学号、日期、单个关键词这类更短字段最多多少字符。 */
  tinyFieldChars: 80,
  /** 关键词最多多少个。 */
  keywords: 30,
  /** PDF 元数据主题最多多少字符。 */
  subjectChars: 300,
  /** 一次传入的正文、Markdown 或 LaTeX 源码最多多少字符。 */
  textChars: 1_000_000,
  /** Word 文档的结构化上限。 */
  word: Object.freeze({
    /** 一篇文档最多多少个内容块。 */
    blocks: 500,
    /** 单个标题块最多多少字符。 */
    headingChars: 500,
    /** 单个段落块最多多少字符。 */
    paragraphChars: 20_000,
    /** 摘要最多多少字符。 */
    abstractChars: 20_000,
    /** 单个列表块最多多少项。 */
    bulletItems: 200,
    /** 单个列表项最多多少字符。 */
    bulletChars: 1000,
    /** 列表缩进层级最深到第几级（从 0 起）。 */
    bulletLevel: 8,
    /** 单张表格最多多少行。 */
    tableRows: 500,
    /** 单张表格每行最多多少列。 */
    tableColumns: 30,
    /** 表格宽度百分比的下限。 */
    minWidthPercent: 10,
    /** 表格宽度百分比的上限。 */
    maxWidthPercent: 100,
  }),
  /** PowerPoint 的结构化上限。 */
  presentation: Object.freeze({
    /** 一份演示文稿最多多少页。 */
    slides: 200,
    /** 单页最多多少个元素。 */
    elements: 200,
  }),
  /** Excel 的结构化上限。 */
  spreadsheet: Object.freeze({
    /** 一个工作簿最多多少张工作表。 */
    sheets: 100,
    /** 工作表名最多多少字符（Excel 本身的格式上限）。 */
    sheetNameChars: 31,
    /** 单张工作表最多多少行。 */
    rows: 100_000,
    /** 单行最多多少列。 */
    columns: 1000,
    /** 单个数字格式串最多多少字符。 */
    numberFormatChars: 120,
    /** 一次 numberFormats 区域最多覆盖多少个单元格，防止一条区间把整表刷一遍。 */
    numberFormatCells: 100_000,
  }),
} as const)

/** PDF 相关操作的入参上限：写进声明给模型看，入参核对用的也是这一份。 */
export const OfficePdfLimits = Object.freeze({
  /** 一次按页提取最多读多少页。 */
  readPages: 100,
  /** 既没给 pages 也没给 maxPages 时读前多少页（说明文字里的那个数字就是它）。 */
  defaultReadPages: 20,
  /** 页码列表（选页、删页、旋转）最多多少项。 */
  pageList: 1000,
  /** 一次最多贴多少条文字戳。 */
  textStamps: 500,
  /** 单条文字戳最多多少字符。 */
  textStampChars: 2000,
  /** 文字戳字号的下限。 */
  minFontSize: 4,
  /** 文字戳字号的上限。 */
  maxFontSize: 96,
  /** LaTeX 最多编译几轮。 */
  compileRuns: 3,
} as const)

/** 文档转 Markdown 的返回长度上限：写进声明给模型看，入参核对用的也是这一份。 */
export const OfficeMarkdownLimits = Object.freeze({
  /** 交回的 Markdown 最多多少字符；写进 outputPath 的文件不受它限制。 */
  maxReturnChars: 200_000,
  /** 允许设置的最小返回长度，再小就没有可读内容了。 */
  minReturnChars: 1_000,
} as const)

/** 文档预览的入参上限：写进声明给模型看，入参核对用的也是这一份。 */
export const OfficePreviewLimits = Object.freeze({
  /** 一次最多预览多少个条目（幻灯片、工作表、标题）。 */
  maxItems: 200,
} as const)

/** MarkItDown 接受的输入扩展名；声明里 toMarkdown 能读的清单就是它。 */
export const OfficeMarkItDownInputExtensions = Object.freeze([
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.html',
  '.htm',
  '.csv',
  '.json',
  '.xml',
  '.zip',
  '.epub',
  '.txt',
  '.md',
  '.markdown',
] as const)

/** MarkItDown 接受的单个扩展名类型。 */
export type OfficeMarkItDownInputExtension = (typeof OfficeMarkItDownInputExtensions)[number]
