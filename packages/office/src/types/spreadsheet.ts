/** Excel 域的数据形状：字体、填充、边框、对齐、单元格、列定义与工作表输入。 */

import type { CellValue } from 'exceljs'

/** Excel 字体配置，最终会被翻译成 ExcelJS 的 cell.font。 */
export type ExcelFont = {
  name?: string
  size?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean | 'none' | 'single' | 'double' | 'singleAccounting' | 'doubleAccounting'
  strike?: boolean
  color?: string
}

/** Excel 填充配置，支持纯色 pattern 和渐变 gradient 两类。 */
export type ExcelFill =
  | { type: 'pattern'; pattern?: string; fgColor?: string; bgColor?: string }
  | {
      type: 'gradient'
      gradient?: 'angle' | 'path'
      degree?: number
      stops?: Array<{ position: number; color: string }>
    }

/** 单条边框边的样式，ExcelJS 会按 top/left/bottom/right 分别接收。 */
export type ExcelBorderSide = {
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

/** 一个单元格的四边边框定义。 */
export type ExcelBorders = {
  top?: ExcelBorderSide
  left?: ExcelBorderSide
  bottom?: ExcelBorderSide
  right?: ExcelBorderSide
}

/** 对齐配置直接映射到 ExcelJS 的 alignment，控制水平/垂直对齐、换行和缩进。 */
export type ExcelAlignment = {
  horizontal?: 'left' | 'center' | 'right' | 'fill' | 'justify' | 'centerContinuous' | 'distributed'
  vertical?: 'top' | 'middle' | 'bottom' | 'distributed' | 'justify'
  wrapText?: boolean
  shrinkToFit?: boolean
  indent?: number
  textRotation?: number
}

/** 可复用的单元格样式，既可用于单个单元格，也可用于工作表表头。 */
export type ExcelCellStyle = {
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

/** 单元格输入支持简单值，也支持对象格式来声明公式、富文本、样式、超链接和合并范围。 */
export type ExcelCellInput = LooseOptional<
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
>

/** 列定义既可以只给表头，也可以给 key、列宽和默认列样式。 */
export type ExcelColumnDef =
  | string
  | {
      header: string
      key?: string
      width?: number
      style?: ExcelCellStyle
    }

/** 单个工作表输入；冻结行列和标签颜色在创建 worksheet 时使用。 */
export type SpreadsheetSheetInput = {
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

/** 单元格翻译的中间结果：值、样式和布局信息拆开，便于执行阶段统一应用。 */
export type ExcelCellBuildResult = {
  excelValue: CellValue
  cellStyle: object
  rowHeight?: number
  link?: { hyperlink: string; tooltip?: string }
  colSpan?: number
  rowSpan?: number
}
