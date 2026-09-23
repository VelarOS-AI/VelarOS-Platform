/** 把声明式样式翻译成 ExcelJS 认的对象：颜色、字体、填充、边框、对齐。 */

import { isNonBlankString, isPresent, optionalWhenLazy } from '@velaros-ai/core'

import type {
  ExcelAlignment,
  ExcelBorders,
  ExcelBorderSide,
  ExcelCellStyle,
  ExcelFill,
  ExcelFont,
} from '../../types/office.js'

/** ExcelJS 使用 ARGB；用户常传 6 位 RGB，这里自动补上不透明 Alpha。 */
export function toArgbColor(hex: string): string {
  const normalized = hex.trim().replace(/^#/u, '')
  return normalized.length === 6 ? `FF${normalized.toUpperCase()}` : normalized.toUpperCase()
}

/** 把工具层字体配置翻译成 ExcelJS 单元格字体对象。 */
export function applyExcelFont(target: { font?: object }, font?: ExcelFont): void {
  if (!font) return
  target.font = {
    name: font.name,
    size: font.size,
    bold: font.bold,
    italic: font.italic,
    underline: font.underline,
    strike: font.strike,
    color: optionalWhenLazy(font.color, () => ({ argb: toArgbColor(font.color!) })),
  }
}

/** 把 pattern/gradient 填充翻译成 ExcelJS 的 fill 对象。 */
export function applyExcelFill(target: { fill?: object }, fill?: ExcelFill): void {
  if (!fill) return
  if (fill.type === 'gradient') {
    target.fill = {
      type: 'gradient',
      gradient: fill.gradient ?? 'angle',
      degree: fill.degree ?? 0,
      stops:
        fill.stops?.map((s) => ({ position: s.position, color: { argb: toArgbColor(s.color) } })) ??
        [],
    }
  } else {
    // 判别联合在 else 分支已收窄到 pattern 变体，直接读字段即可（原先五处断言是多余的）。
    target.fill = {
      type: 'pattern',
      pattern: fill.pattern ?? 'solid',
      fgColor: optionalWhenLazy(fill.fgColor, () => ({ argb: toArgbColor(fill.fgColor!) })),
      bgColor: optionalWhenLazy(fill.bgColor, () => ({ argb: toArgbColor(fill.bgColor!) })),
    }
  }
}

/** 将四边边框分别转换成 ExcelJS 的 top/left/bottom/right 配置。 */
export function applyExcelBorder(target: { border?: object }, border?: ExcelBorders): void {
  if (!border) return
  const side = (b?: ExcelBorderSide): object | undefined =>
    optionalWhenLazy(b, () => ({
      style: b!.style ?? 'thin',
      color: optionalWhenLazy(b!.color, () => ({ argb: toArgbColor(b!.color!) })),
    }))
  target.border = {
    top: side(border.top),
    left: side(border.left),
    bottom: side(border.bottom),
    right: side(border.right),
  }
}

/** 对齐配置无需额外转换，直接挂到 ExcelJS cell.alignment。 */
export function applyExcelAlignment(
  target: { alignment?: object },
  alignment?: ExcelAlignment
): void {
  if (!alignment) return
  target.alignment = alignment
}

/** 把声明式样式统一转换成 ExcelJS 可以直接接收的对象。 */
export function buildExcelCellStyle(style?: ExcelCellStyle): Record<string, unknown> {
  const cellStyle: Record<string, unknown> = {}
  if (!style) return cellStyle
  const flatFont =
    isPresent(style.bold) || isPresent(style.italic) || isNonBlankString(style.color)
      ? { bold: style.bold, italic: style.italic, color: style.color }
      : undefined
  applyExcelFont(
    cellStyle,
    style.font || flatFont
      ? {
          ...flatFont,
          ...style.font,
        }
      : undefined
  )
  applyExcelFill(
    cellStyle,
    style.fill ??
      (isNonBlankString(style.bgColor)
        ? { type: 'pattern', pattern: 'solid', fgColor: style.bgColor }
        : undefined)
  )
  applyExcelBorder(cellStyle, style.border)
  applyExcelAlignment(cellStyle, style.alignment)
  if (style.numFmt) cellStyle.numFmt = style.numFmt
  return cellStyle
}
