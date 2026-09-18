/** 把结构化元素画到 pptxgenjs 的幻灯片上：文本、表格、形状、图片、图表。模型面的 options 原样交过去，类型在这一处对上。 */

import { isString } from '@velaros-ai/core'

import type { PptElement } from '../../types/office.js'
import type {
  PptxChartName,
  PptxChartOptions,
  PptxImageOptions,
  PptxShape,
  PptxShapeOptions,
  PptxSlide,
  PptxTableOptions,
  PptxTableRows,
  PptxTextOptions,
} from '../../types/pptx.js'

/** 将结构化元素添加到 pptxgenjs slide。 */
export function addSlideElements(slide: PptxSlide, elements: PptElement[]): void {
  for (const el of elements) {
    switch (el.kind) {
      case 'text': {
        // value 可以是普通字符串，也可以是 pptxgenjs rich text 数组。
        const textValue = isString(el.value)
          ? el.value
          : el.value.map((p) => ({ text: p.text, options: (p.options ?? {}) as PptxTextOptions }))
        slide.addText(textValue, {
          x: el.x,
          y: el.y,
          w: el.w,
          h: el.h,
          ...(el.options as PptxTextOptions),
        })
        break
      }
      case 'table':
        slide.addTable(el.rows as PptxTableRows, {
          x: el.x,
          y: el.y,
          w: el.w,
          h: el.h,
          ...(el.options as PptxTableOptions),
        })
        break
      case 'shape':
        slide.addShape(el.shape as PptxShape, {
          x: el.x,
          y: el.y,
          w: el.w,
          h: el.h,
          ...(el.options as PptxShapeOptions),
        })
        break
      // 图片 data 使用 base64，并按 type 组装 data URI。
      case 'image':
        slide.addImage({
          data: `data:image/${el.type ?? 'png'};base64,${el.data}`,
          x: el.x,
          y: el.y,
          w: el.w,
          h: el.h,
          ...(el.options as Partial<PptxImageOptions>),
        })
        break
      case 'chart':
        slide.addChart(el.chartType as PptxChartName, el.data, {
          x: el.x,
          y: el.y,
          w: el.w,
          h: el.h,
          ...(el.options as PptxChartOptions),
        })
        break
    }
  }
}
