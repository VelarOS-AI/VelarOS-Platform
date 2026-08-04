/**
 * presentationTool.ts
 *
 * PowerPoint (.pptx) 演示文稿生成工具。
 * 依赖：officeShared（共享类型 + 路径辅助）
 */

import { z } from 'zod'

import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/agent/tool-contract'
import { isArray, isEmpty, isNonBlankString, isPresent, isString, optionalWhen } from '@velaros-ai/core'

import {
  outputPathSchema,
} from './officeShared'

// ─── Types ─────────────────────────────────────────────────────────────────────

type PptxPresentation = InstanceType<typeof import('pptxgenjs').default>
type PptxSlide = ReturnType<PptxPresentation['addSlide']>
type PptxTextOptions = NonNullable<Parameters<PptxSlide['addText']>[1]>
type PptxTableRows = Parameters<PptxSlide['addTable']>[0]
type PptxTableOptions = NonNullable<Parameters<PptxSlide['addTable']>[1]>
type PptxShape = Parameters<PptxSlide['addShape']>[0]
type PptxShapeOptions = NonNullable<Parameters<PptxSlide['addShape']>[1]>
type PptxImageOptions = Parameters<PptxSlide['addImage']>[0]
type PptxChartName = Parameters<PptxSlide['addChart']>[0]
type PptxChartOptions = NonNullable<Parameters<PptxSlide['addChart']>[2]>
type PptxTheme = PptxPresentation['theme']

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

/** office:create_presentation 工具输入。 */
export type CreatePresentationInput = {
  cwd?: string
  outputPath: string
  title?: string
  author?: string
  layout?: 'LAYOUT_4x3' | 'LAYOUT_16x9' | 'LAYOUT_16x10' | 'LAYOUT_WIDE'
  rtlMode?: boolean
  template?: PresentationTemplate
  theme?: PptxTheme
  slides?: PresentationSlideInput[] | string
  content?: string
  overwrite?: boolean
}

// ─── Zod schema ────────────────────────────────────────────────────────────────

/** PPT 富文本 schema。 */
export const pptTextPropsSchema = z.object({
  text: z.string(),
  options: z.record(z.string(), z.any()).optional(),
})

/** 幻灯片元素 schema。 */
export const pptElementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    value: z.union([z.string(), z.array(pptTextPropsSchema)]),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    options: z.record(z.string(), z.any()).optional(),
  }),
  z.object({
    kind: z.literal('table'),
    rows: z.array(z.array(z.any())).min(1),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    options: z.record(z.string(), z.any()).optional(),
  }),
  z.object({
    kind: z.literal('shape'),
    shape: z.string(),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    options: z.record(z.string(), z.any()).optional(),
  }),
  z.object({
    kind: z.literal('image'),
    data: z.string(),
    type: z.enum(['png', 'jpeg', 'gif', 'svg', 'bmp', 'webp']).optional(),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    options: z.record(z.string(), z.any()).optional(),
  }),
  z.object({
    kind: z.literal('chart'),
    chartType: z.string().min(1),
    data: z.array(z.record(z.string(), z.any())).min(1),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    options: z.record(z.string(), z.any()).optional(),
  }),
])

/** 支持结构化 slides 或直接传 Markdown/纯文本。 */
export const presentationSlidesInputSchema = z
  .union([
    z
      .array(
        z.object({
          background: z.record(z.string(), z.any()).optional(),
          elements: z.array(pptElementSchema).max(200),
          notes: z.string().optional(),
        })
      )
      .min(1)
      .max(200),
    z
      .string()
      .min(1)
      .max(1_000_000)
      .describe(
        parameterDescription({
          description: '大段 Markdown 或纯文本内容。',
          notes: ['工具会自动转为简单标题/正文幻灯片。'],
        })
      ),
  ])
  .describe(
    parameterDescription({
      description: 'PPT 幻灯片输入。',
      values: [
        '结构化 slides 数组：完整控制元素和布局。',
        '字符串：按 Markdown 或纯文本自动拆页。',
      ],
    })
  )

/** office:create_presentation 完整输入 schema。 */
export const createPresentationSchema = z
  .object({
    cwd: z.string().optional(),
    outputPath: outputPathSchema,
    title: z.string().min(1).max(200).optional(),
    author: z.string().min(1).max(120).optional(),
    layout: z
      .enum(['LAYOUT_4x3', 'LAYOUT_16x9', 'LAYOUT_16x10', 'LAYOUT_WIDE'])
      .optional()
      .describe(
        parameterDescription({
          description: '演示文稿页面比例。',
          values: [
            'LAYOUT_4x3：标准 4:3。',
            'LAYOUT_16x9：宽屏 16:9。',
            'LAYOUT_16x10：宽屏 16:10。',
            'LAYOUT_WIDE：pptxgenjs 宽屏布局。',
          ],
        })
      ),
    rtlMode: z.boolean().optional(),
    template: z
      .enum(['modern', 'consulting', 'academic', 'minimal'])
      .optional()
      .describe(
        parameterDescription({
          description: '自动排版模板。',
          values: [
            'modern：现代演示风格。',
            'consulting：咨询汇报风格。',
            'academic：学术表达风格。',
            'minimal：极简文档风格。',
          ],
        })
      ),
    theme: z.record(z.string(), z.any()).optional(),
    slides: presentationSlidesInputSchema.optional(),
    content: z
      .string()
      .min(1)
      .max(1_000_000)
      .optional()
      .describe(
        parameterDescription({
          description: '大段 Markdown 或纯文本内容。',
          usage: ['不需要精细结构化 slides 时使用。'],
        })
      ),
    overwrite: z.boolean().optional(),
  })
  .refine((input) => isPresent(input.slides) || isNonBlankString(input.content), {
    path: ['slides'],
    message: 'slides 或 content 至少提供一个。',
  })

export const createPresentationPresetSchema = z.object({
  outputPath: outputPathSchema,
  title: z.string().min(1).max(200).optional(),
  content: z
    .string()
    .min(1)
    .max(1_000_000)
    .describe(
      parameterDescription({
        description: 'Markdown 或纯文本内容。',
        notes: ['# 标题和 --- 会自动拆成幻灯片。'],
      })
    ),
  template: z
    .enum(['modern', 'consulting', 'academic', 'minimal'])
    .optional()
    .describe(
      parameterDescription({
        description: '自动排版模板。',
        values: [
          'modern：现代演示风格。',
          'consulting：咨询汇报风格。',
          'academic：学术表达风格。',
          'minimal：极简文档风格。',
        ],
      })
    ),
  overwrite: z.boolean().optional(),
})

export type CreatePresentationPresetInput = z.infer<typeof createPresentationPresetSchema>

export function normalizeCreatePresentationPreset(
  input: CreatePresentationPresetInput
): CreatePresentationInput {
  return {
    outputPath: input.outputPath,
    title: input.title,
    content: input.content,
    template: input.template,
    overwrite: input.overwrite,
  }
}

export const createPresentationGuidedSchema = z.object({
  cwd: z.string().optional(),
  outputPath: outputPathSchema,
  title: z.string().min(1).max(200).optional(),
  author: z.string().min(1).max(120).optional(),
  layout: z
    .enum(['LAYOUT_4x3', 'LAYOUT_16x9', 'LAYOUT_16x10', 'LAYOUT_WIDE'])
    .optional()
    .describe(
      parameterDescription({
        description: '演示文稿页面比例。',
        values: [
          'LAYOUT_4x3：标准 4:3。',
          'LAYOUT_16x9：宽屏 16:9。',
          'LAYOUT_16x10：宽屏 16:10。',
          'LAYOUT_WIDE：pptxgenjs 宽屏布局。',
        ],
      })
    ),
  rtlMode: z.boolean().optional(),
  template: z
    .enum(['modern', 'consulting', 'academic', 'minimal'])
    .optional()
    .describe(
      parameterDescription({
        description: '自动排版模板。',
        values: [
          'modern：现代演示风格。',
          'consulting：咨询汇报风格。',
          'academic：学术表达风格。',
          'minimal：极简文档风格。',
        ],
      })
    ),
  content: z
    .string()
    .min(1)
    .max(1_000_000)
    .describe(
      parameterDescription({
        description: 'Markdown 或纯文本内容。',
        notes: ['需要元素坐标、图片、图表或主题对象时切到 direct/expert。'],
      })
    ),
  overwrite: z.boolean().optional(),
})

export type CreatePresentationGuidedInput = z.infer<typeof createPresentationGuidedSchema>

export function normalizeCreatePresentationGuided(
  input: CreatePresentationGuidedInput
): CreatePresentationInput {
  return {
    ...input,
    content: input.content,
  }
}

// ─── Constants ─────────────────────────────────────────────────────────────────

export const PresentationTextMaxCharsPerSlide = 2_800
export const PresentationWideWidth = 13.333
export const PresentationWideHeight = 7.5

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

export const PresentationTemplatePalettes: Record<PresentationTemplate, PresentationTemplatePalette> = {
  modern: {
    background: 'F8FAFC',
    surface: 'FFFFFF',
    primary: '0F172A',
    secondary: '1D4ED8',
    accent: '14B8A6',
    accentSoft: 'CCFBF1',
    text: '111827',
    muted: '64748B',
    titleFont: 'Aptos Display',
    bodyFont: 'Aptos',
  },
  consulting: {
    background: 'F7F7F5',
    surface: 'FFFFFF',
    primary: '172554',
    secondary: '0F766E',
    accent: 'EAB308',
    accentSoft: 'FEF3C7',
    text: '111827',
    muted: '6B7280',
    titleFont: 'Aptos Display',
    bodyFont: 'Aptos',
  },
  academic: {
    background: 'F8FAFC',
    surface: 'FFFFFF',
    primary: '1E293B',
    secondary: '0F766E',
    accent: '2563EB',
    accentSoft: 'DBEAFE',
    text: '111827',
    muted: '64748B',
    titleFont: 'Times New Roman',
    bodyFont: 'Aptos',
  },
  minimal: {
    background: 'FFFFFF',
    surface: 'F8FAFC',
    primary: '111827',
    secondary: '475569',
    accent: 'DC2626',
    accentSoft: 'FEE2E2',
    text: '111827',
    muted: '71717A',
    titleFont: 'Aptos Display',
    bodyFont: 'Aptos',
  },
}

// ─── Content normalization ──────────────────────────────────────────────────────

/** 将输入统一转成 PresentationSlideInput 列表。 */
export function normalizePresentationSlides(input: CreatePresentationInput): PresentationSlideInput[] {
  if (isArray(input.slides)) return input.slides
  const content = isString(input.slides) ? input.slides : input.content
  if (!isString(content)) return []
  return parsePresentationContentToSlides(content, input.title, input.template ?? 'modern')
}

/** 把 Markdown/纯文本拆成简单标题+正文幻灯片。 */
export function parsePresentationContentToSlides(
  content: string,
  deckTitle?: string,
  template: PresentationTemplate = 'modern'
): PresentationSlideInput[] {
  const sections = splitPresentationContent(content).slice(0, 200)
  return sections
    .map((section, index) => buildPresentationSlideFromLines(section, index, deckTitle, template))
    .filter((slide) => !isEmpty(slide.elements))
}

/** 按 Markdown 一级标题或 --- 分隔内容块。 */
export function splitPresentationContent(content: string): string[][] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const sections: string[][] = []
  let current: string[] = []
  // flush 会跳过全空 section。
  const flush = (): void => {
    if (current.some((line) => line.trim())) sections.push(current)
    current = []
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^-{3,}$/.test(trimmed)) {
      flush()
      continue
    }
    // 新的一级标题会开启下一页。
    if (/^#\s+/.test(trimmed) && current.some((entry) => entry.trim())) flush()
    current.push(line)
  }
  flush()
  return sections
}

/** 将一个文本 section 转成默认版式幻灯片。 */
export function buildPresentationSlideFromLines(
  lines: string[],
  index: number,
  deckTitle?: string,
  template: PresentationTemplate = 'modern'
): PresentationSlideInput {
  let slideTitle = optionalWhen((index === 0), deckTitle)
  const bodyLines: string[] = []
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    const heading = line.match(/^#{1,6}\s+(.+)$/)
    if (heading?.[1]) {
      // 第一条 heading 作为页标题，后续 heading 退化为正文行。
      if (!slideTitle) {
        slideTitle = heading[1].trim()
      } else {
        bodyLines.push(heading[1].trim())
      }
      continue
    }
    const bullet = line.match(/^[-*•]\s+(.+)$/)
    bodyLines.push(bullet?.[1] ? `• ${bullet[1].trim()}` : line)
  }
  const title = (slideTitle || bodyLines.shift() || `Slide ${index + 1}`).slice(0, 120)
  // 自动模式限制单页正文长度，避免文字溢出幻灯片。
  const body = bodyLines.join('\n').slice(0, PresentationTextMaxCharsPerSlide)
  return buildTemplatePresentationSlide({
    title,
    body,
    index,
    template,
    isTitleSlide: index === 0,
  })
}

export function buildTemplatePresentationSlide(input: {
  title: string
  body: string
  index: number
  template: PresentationTemplate
  isTitleSlide: boolean
}): PresentationSlideInput {
  const palette = PresentationTemplatePalettes[input.template]
  const bodyLines = input.body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  const bullets = bodyLines
    .map((line) => line.replace(/^•\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 8)

  if (input.isTitleSlide) return {
      background: { color: palette.primary },
      elements: [
        {
          kind: 'shape',
          shape: 'rect',
          x: 0,
          y: 0,
          w: PresentationWideWidth,
          h: PresentationWideHeight,
          options: { fill: { color: palette.primary }, line: { color: palette.primary } },
        },
        {
          kind: 'shape',
          shape: 'rect',
          x: 0,
          y: 6.95,
          w: PresentationWideWidth,
          h: 0.55,
          options: { fill: { color: palette.accent }, line: { color: palette.accent } },
        },
        {
          kind: 'shape',
          shape: 'rect',
          x: 0.72,
          y: 0.72,
          w: 0.12,
          h: 4.4,
          options: { fill: { color: palette.accent }, line: { color: palette.accent } },
        },
        {
          kind: 'text',
          value: input.title,
          x: 1.05,
          y: 1.05,
          w: 10.9,
          h: 1.35,
          options: {
            fontFace: palette.titleFont,
            fontSize: input.template === 'academic' ? 34 : 40,
            bold: true,
            color: 'FFFFFF',
            margin: 0,
            fit: 'shrink' as const,
            breakLine: false,
          },
        },
        ...(!isEmpty(bodyLines)
          ? [
              {
                kind: 'text' as const,
                value: bodyLines.slice(0, 4).join('\n'),
                x: 1.08,
                y: 2.75,
                w: 8.8,
                h: 1.65,
                options: {
                  fontFace: palette.bodyFont,
                  fontSize: 18,
                  color: 'E2E8F0',
                  breakLine: false,
                  fit: 'shrink' as const,
                  valign: 'top' as const,
                },
              },
            ]
          : []),
        {
          kind: 'text',
          value: 'Generated by VelarOS',
          x: 1.05,
          y: 6.33,
          w: 4.2,
          h: 0.28,
          options: {
            fontFace: palette.bodyFont,
            fontSize: 10,
            color: 'CBD5E1',
            margin: 0,
          },
        },
      ],
    }

  const elements: PptElement[] = [
    {
      kind: 'shape',
      shape: 'rect',
      x: 0,
      y: 0,
      w: PresentationWideWidth,
      h: PresentationWideHeight,
      options: { fill: { color: palette.background }, line: { color: palette.background } },
    },
    {
      kind: 'shape',
      shape: 'rect',
      x: 0,
      y: 0,
      w: 0.18,
      h: PresentationWideHeight,
      options: { fill: { color: palette.accent }, line: { color: palette.accent } },
    },
    {
      kind: 'text',
      value: input.title,
      x: 0.72,
      y: 0.44,
      w: 11.7,
      h: 0.72,
      options: {
        fontFace: palette.titleFont,
        fontSize: input.template === 'academic' ? 25 : 28,
        bold: true,
        color: palette.primary,
        margin: 0,
        fit: 'shrink' as const,
        breakLine: false,
      },
    },
    {
      kind: 'shape',
      shape: 'rect',
      x: 0.72,
      y: 1.27,
      w: 2.35,
      h: 0.05,
      options: { fill: { color: palette.accent }, line: { color: palette.accent } },
    },
  ]

  if (bullets.length >= 2 && bullets.length <= 6) {
    elements.push(...buildPresentationCardGrid(bullets, palette))
  } else if (input.body) {
    elements.push({
      kind: 'shape',
      shape: 'roundRect',
      x: 0.72,
      y: 1.65,
      w: 11.78,
      h: 4.95,
      options: {
        fill: { color: palette.surface },
        line: {
          color: input.template === 'minimal' ? 'E5E7EB' : palette.accentSoft,
          transparency: 8,
        },
      },
    })
    elements.push({
      kind: 'text',
      value: input.body,
      x: 1.0,
      y: 1.92,
      w: 11.2,
      h: 4.3,
      options: {
        fontFace: palette.bodyFont,
        fontSize: input.template === 'academic' ? 16 : 18,
        color: palette.text,
        valign: 'top' as const,
        fit: 'shrink' as const,
        breakLine: false,
        margin: 0.02,
      },
    })
  }

  elements.push(
    {
      kind: 'text',
      value: `${input.index + 1}`.padStart(2, '0'),
      x: 11.78,
      y: 6.86,
      w: 0.7,
      h: 0.22,
      options: {
        fontFace: palette.bodyFont,
        fontSize: 9,
        color: palette.muted,
        align: 'right' as const,
        margin: 0,
      },
    },
    {
      kind: 'shape',
      shape: 'rect',
      x: 0.72,
      y: 6.97,
      w: 10.8,
      h: 0.02,
      options: { fill: { color: 'CBD5E1', transparency: 20 }, line: { color: 'CBD5E1' } },
    }
  )

  return {
    background: { color: palette.background },
    elements,
  }
}

export function buildPresentationCardGrid(
  bullets: string[],
  palette: PresentationTemplatePalette
): PptElement[] {
  const elements: PptElement[] = []
  const columns = bullets.length <= 3 ? bullets.length : 2
  const rows = Math.ceil(bullets.length / columns)
  const gap = 0.25
  const startX = 0.72
  const startY = 1.7
  const totalW = 11.78
  const totalH = 4.9
  const cardW = (totalW - gap * (columns - 1)) / columns
  const cardH = Math.min(1.55, (totalH - gap * (rows - 1)) / rows)

  bullets.forEach((item, index) => {
    const col = index % columns
    const row = Math.floor(index / columns)
    const x = startX + col * (cardW + gap)
    const y = startY + row * (cardH + gap)
    const markerColor = index % 2 === 0 ? palette.accent : palette.secondary

    elements.push(
      {
        kind: 'shape',
        shape: 'roundRect',
        x,
        y,
        w: cardW,
        h: cardH,
        options: {
          fill: { color: palette.surface },
          line: { color: palette.accentSoft },
        },
      },
      {
        kind: 'shape',
        shape: 'rect',
        x,
        y,
        w: 0.08,
        h: cardH,
        options: { fill: { color: markerColor }, line: { color: markerColor } },
      },
      {
        kind: 'text',
        value: item,
        x: x + 0.28,
        y: y + 0.18,
        w: cardW - 0.48,
        h: cardH - 0.32,
        options: {
          fontFace: palette.bodyFont,
          fontSize: 16,
          bold: index < 3,
          color: palette.text,
          fit: 'shrink' as const,
          valign: 'middle' as const,
          margin: 0,
          breakLine: false,
        },
      }
    )
  })

  return elements
}

export function buildPresentationTheme(template: PresentationTemplate): PptxTheme {
  const palette = PresentationTemplatePalettes[template]
  return {
    headFontFace: palette.titleFont,
    bodyFontFace: palette.bodyFont,
  }
}

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
