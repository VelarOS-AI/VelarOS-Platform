/**
 * office:create_presentation 的入参 schema（含 preset / guided 两个 surface）。
 * 拆页、模板版式与元素绘制已经搬进 utils/presentation/*，这里只剩 wire 面的校验。
 */

import { z } from 'zod'

import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/agent/tool-contract'
import { isNonBlankString, isPresent } from '@velaros-ai/core'

import { OfficeInputLimits } from '../contract/constants.js'

import { outputPathSchema } from './officeShared'

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
          elements: z.array(pptElementSchema).max(OfficeInputLimits.presentation.elements),
          notes: z.string().optional(),
        })
      )
      .min(1)
      .max(OfficeInputLimits.presentation.slides),
    z
      .string()
      .min(1)
      .max(OfficeInputLimits.textChars)
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
    title: z.string().min(1).max(OfficeInputLimits.titleChars).optional(),
    author: z.string().min(1).max(OfficeInputLimits.shortFieldChars).optional(),
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
      .max(OfficeInputLimits.textChars)
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

/** preset 档：只收 outputPath、content、标题与模板。 */
export const createPresentationPresetSchema = z.object({
  outputPath: outputPathSchema,
  title: z.string().min(1).max(OfficeInputLimits.titleChars).optional(),
  content: z
    .string()
    .min(1)
    .max(OfficeInputLimits.textChars)
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

/** guided 档：在 preset 之上加作者、版面比例与 RTL 模式。 */
export const createPresentationGuidedSchema = z.object({
  cwd: z.string().optional(),
  outputPath: outputPathSchema,
  title: z.string().min(1).max(OfficeInputLimits.titleChars).optional(),
  author: z.string().min(1).max(OfficeInputLimits.shortFieldChars).optional(),
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
    .max(OfficeInputLimits.textChars)
    .describe(
      parameterDescription({
        description: 'Markdown 或纯文本内容。',
        notes: ['需要元素坐标、图片、图表或主题对象时切到 direct/expert。'],
      })
    ),
  overwrite: z.boolean().optional(),
})
