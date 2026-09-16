/** PowerPoint 域的数据形状：元素、单页输入、模板与配色；坐标与样式沿用随包 pptxgenjs 的模型。 */

import type PptxGenJS from '../../vendor/pptxgenjs/pptxgen.es.js'

/** 随包 pptxgenjs 的演示文稿实例类型。 */
export type PptxPresentation = InstanceType<typeof PptxGenJS>
/** 一页幻灯片的实例类型。 */
export type PptxSlide = ReturnType<PptxPresentation['addSlide']>
/** 文本元素的样式选项。 */
export type PptxTextOptions = NonNullable<Parameters<PptxSlide['addText']>[1]>
/** 表格元素的行数据。 */
export type PptxTableRows = Parameters<PptxSlide['addTable']>[0]
/** 表格元素的样式选项。 */
export type PptxTableOptions = NonNullable<Parameters<PptxSlide['addTable']>[1]>
/** 形状元素的形状名。 */
export type PptxShape = Parameters<PptxSlide['addShape']>[0]
/** 形状元素的样式选项。 */
export type PptxShapeOptions = NonNullable<Parameters<PptxSlide['addShape']>[1]>
/** 图片元素的选项。 */
export type PptxImageOptions = Parameters<PptxSlide['addImage']>[0]
/** 图表类型名。 */
export type PptxChartName = Parameters<PptxSlide['addChart']>[0]
/** 图表元素的选项。 */
export type PptxChartOptions = NonNullable<Parameters<PptxSlide['addChart']>[2]>
/** 演示文稿主题（字体族）。 */
export type PptxTheme = PptxPresentation['theme']

/** PPT 富文本片段。 */
export type PptTextProps = {
  text: string
  options?: PptxTextOptions
}

/** PPT 自动排版模板。 */
export type PresentationTemplate = 'modern' | 'consulting' | 'academic' | 'minimal'

/** 单个 PPT 元素，使用 pptxgenjs 的坐标和样式模型。 */
export type PptElement =
  | {
      kind: 'text'
      value: string | PptTextProps[]
      x: number
      y: number
      w: number
      h: number
      options?: PptxTextOptions
    }
  | {
      kind: 'table'
      rows: PptxTableRows
      x: number
      y: number
      w: number
      h: number
      options?: PptxTableOptions
    }
  | {
      kind: 'shape'
      shape: PptxShape | string
      x: number
      y: number
      w: number
      h: number
      options?: PptxShapeOptions
    }
  | {
      kind: 'image'
      data: string
      type?: 'png' | 'jpeg' | 'gif' | 'svg' | 'bmp' | 'webp'
      x: number
      y: number
      w: number
      h: number
      options?: PptxImageOptions
    }
  | {
      kind: 'chart'
      chartType: string
      data: Array<Record<string, unknown>>
      x: number
      y: number
      w: number
      h: number
      options?: PptxChartOptions
    }

/** 单页幻灯片输入。 */
export type PresentationSlideInput = {
  background?: { color?: string; path?: string; data?: string }
  elements: PptElement[]
  notes?: string
}

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
