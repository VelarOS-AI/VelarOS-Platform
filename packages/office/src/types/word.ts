/** Word 文档域的数据形状：富文本片段、表格单元格、内容块、排版模板与字体族。 */

/** Word 文本片段，可控制样式、上下标、链接和换行。 */
export type WordTextRun = {
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

/** Word 表格单元格输入，支持文本、富文本、合并和背景色。 */
export type WordTableCellInput = {
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

/** Word 文档高层排版模板。 */
export type WordDocumentProfile = 'standard' | 'academic-paper' | 'thesis'

/** 论文/报告封面和元数据字段。 */
export type WordDocumentMetadata = {
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

/** Word 文档的结构化内容块。 */
export type WordBlock =
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

/** 文档语言，决定封面标签文字与默认字体族。 */
export type WordDocumentLanguage = 'zh-CN' | 'en-US'

/** 一份文档正文与标题各用哪个字体族。 */
export interface WordFontFamilies {
  readonly body: string
  readonly heading: string
}

/** 学术模板封面与前言里用到的标签文字，按语言各一套。 */
export interface WordAcademicLabels {
  toc: string
  abstract: string
  keywords: string
  author: string
  advisor: string
  school: string
  department: string
  major: string
  course: string
  className: string
  studentId: string
  date: string
  organization: string
}

/** OOXML 支撑部件（编号、样式）的路径、内容类型与关系类型。 */
export type WordSupportPart = {
  path: string
  contentType: string
  relationshipType: string
}
