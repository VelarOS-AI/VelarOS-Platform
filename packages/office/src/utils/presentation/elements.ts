/** 把结构化元素画到 pptxgenjs 的幻灯片上：文本、表格、形状、图片、图表。 */

import { isString } from '@velaros-ai/core'

import type { PptElement, PptxChartName, PptxSlide } from '../../types/presentation.js'

/** 将结构化元素添加到 pptxgenjs slide。 */
export function addSlideElements(slide: PptxSlide, elements: PptElement[]): void {
  for (const el of elements) {
    switch (el.kind) {
      case 'text': {
        // value 可以是普通字符串，也可以是 pptxgenjs rich text 数组。
        const textValue = isString(el.value)
          ? el.value
          : el.value.map((p) => ({ text: p.text, options: p.options ?? {} }))
        slide.addText(textValue, {
          x: el.x,
          y: el.y,
          w: el.w,
          h: el.h,
          ...(el.options ?? {}),
        })
        break
      }
      case 'table':
        slide.addTable(el.rows, {
          x: el.x,
          y: el.y,
          w: el.w,
          h: el.h,
          ...(el.options ?? {}),
        })
        break
      case 'shape':
        slide.addShape(el.shape as Parameters<typeof slide.addShape>[0], {
          x: el.x,
          y: el.y,
          w: el.w,
          h: el.h,
          ...(el.options ?? {}),
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
          ...(el.options ?? {}),
        })
        break
      case 'chart':
        slide.addChart(el.chartType as PptxChartName, el.data, {
          x: el.x,
          y: el.y,
          w: el.w,
          h: el.h,
          ...(el.options ?? {}),
        })
        break
    }
  }
}
