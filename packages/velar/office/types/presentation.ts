/** PowerPoint 域的内部形状：自动排版模板的配色与字体。模型面的页、元素与模板在 `office.ts`，从 PptxGenJS 派生的类型在 `pptx.ts`。 */

/** 一套自动排版模板的配色与字体。 */
export interface PresentationTemplatePalette {
  background: string
  surface: string
  primary: string
  secondary: string
  accent: string
  accentSoft: string
  text: string
  muted: string
  titleFont: string
  bodyFont: string
}
