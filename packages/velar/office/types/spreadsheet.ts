/** Excel 域的内部形状：单元格翻译的中间结果。模型面的字体、填充、边框、对齐、单元格、列与工作表在 `office.ts`。 */

import type { CellValue } from 'exceljs'

/** 单元格翻译的中间结果：值、样式和布局信息拆开，便于执行阶段统一应用。 */
export type ExcelCellBuildResult = {
  excelValue: CellValue
  cellStyle: object
  rowHeight?: number
  link?: { hyperlink: string; tooltip?: string }
  colSpan?: number
  rowSpan?: number
}
