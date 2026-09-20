/**
 * 随包 PptxGenJS 的实例类型：只在单元内部把模型面的页与元素画上幻灯片时用，不进模型面、不随可移植入口出包。
 * 运行时经包清单的子路径导入 `#pptxgenjs` 取随包那份审过的 ESM 运行时。
 */

import type PptxGenJS from '#pptxgenjs'

/** 演示文稿实例。 */
export type PptxPresentation = InstanceType<typeof PptxGenJS>
/** 一页幻灯片实例。 */
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
/** 一页的背景。 */
export type PptxBackground = NonNullable<PptxSlide['background']>
