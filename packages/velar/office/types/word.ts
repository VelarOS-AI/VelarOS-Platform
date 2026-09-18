/** Word 文档域的内部形状：正文与标题的字体族、学术模板的标签文字、OOXML 支撑部件。模型面的富文本、表格、内容块与排版模板在 `office.ts`。 */

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
