/**
 * office:create_word_document 的入参 schema（含 preset / guided 两个 surface）。
 * 内容解析、docx 构建与 OOXML 追加写已经搬进 utils/word/*，这里只剩 wire 面的校验。
 */

import { z } from 'zod'

import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/agent/tool-contract'
import { isNonBlankString, isPresent } from '@velaros-ai/core'

import { OfficeInputLimits } from '../contract/constants.js'

import { outputPathSchema } from './officeShared'

/** Word rich text run 的输入 schema。 */
export const wordTextRunSchema = z.object({
  text: z.string(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  color: z.string().optional(),
  highlight: z.string().optional(),
  fontSize: z.number().optional(),
  font: z.string().optional(),
  superScript: z.boolean().optional(),
  subScript: z.boolean().optional(),
  link: z.string().optional(),
  break: z.number().optional(),
})

/** Word 表格单元格 schema。 */
export const wordTableCellSchema = z.object({
  text: z.string().optional(),
  runs: z.array(wordTextRunSchema).optional(),
  bold: z.boolean().optional(),
  color: z.string().optional(),
  bgColor: z.string().optional(),
  align: z.enum(['left', 'center', 'right', 'justify']).optional(),
  verticalAlign: z.enum(['top', 'center', 'bottom']).optional(),
  columnSpan: z.number().int().positive().optional(),
  rowSpan: z.number().int().positive().optional(),
})

/** Word 高层排版模板 schema。 */
export const wordDocumentProfileSchema = z.enum(['standard', 'academic-paper', 'thesis'])

/** 论文/报告元数据 schema。 */
export const wordDocumentMetadataSchema = z.object({
  subtitle: z.string().max(OfficeInputLimits.titleChars).optional(),
  school: z.string().max(OfficeInputLimits.shortFieldChars).optional(),
  department: z.string().max(OfficeInputLimits.shortFieldChars).optional(),
  major: z.string().max(OfficeInputLimits.shortFieldChars).optional(),
  course: z.string().max(OfficeInputLimits.shortFieldChars).optional(),
  className: z.string().max(OfficeInputLimits.tinyFieldChars).optional(),
  studentId: z.string().max(OfficeInputLimits.tinyFieldChars).optional(),
  advisor: z.string().max(OfficeInputLimits.shortFieldChars).optional(),
  date: z.string().max(OfficeInputLimits.tinyFieldChars).optional(),
  organization: z.string().max(OfficeInputLimits.shortFieldChars).optional(),
})

/** Word 内容块 schema，按 kind 区分标题、段落、列表、表格和分页。 */
export const wordBlockSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('heading'),
    text: z.string().min(1).max(OfficeInputLimits.word.headingChars),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    color: z.string().optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
  }),
  z.object({
    kind: z.literal('paragraph'),
    text: z.string().max(OfficeInputLimits.word.paragraphChars).optional(),
    runs: z.array(wordTextRunSchema).optional(),
    align: z.enum(['left', 'center', 'right', 'justify']).optional(),
    spaceBefore: z.number().optional(),
    spaceAfter: z.number().optional(),
    indent: z.number().optional(),
  }),
  z.object({
    kind: z.literal('bullets'),
    items: z
      .array(
        z.union([
          z.string().min(1).max(OfficeInputLimits.word.bulletChars),
          z.object({
            text: z.string(),
            runs: z.array(wordTextRunSchema).optional(),
            level: z.number().int().min(0).max(OfficeInputLimits.word.bulletLevel).optional(),
          }),
        ])
      )
      .min(1)
      .max(OfficeInputLimits.word.bulletItems),
  }),
  z.object({
    kind: z.literal('table'),
    rows: z
      .array(z.array(wordTableCellSchema).min(1).max(OfficeInputLimits.word.tableColumns))
      .min(1)
      .max(OfficeInputLimits.word.tableRows),
    header: z.boolean().optional(),
    headerBgColor: z.string().optional(),
    borderColor: z.string().optional(),
    widthPct: z
      .number()
      .min(OfficeInputLimits.word.minWidthPercent)
      .max(OfficeInputLimits.word.maxWidthPercent)
      .optional(),
  }),
  z.object({ kind: z.literal('pageBreak') }),
])

/** 支持结构化 blocks 或直接传 Markdown/纯文本字符串。 */
export const wordBlocksInputSchema = z
  .union([
    z.array(wordBlockSchema).min(1).max(OfficeInputLimits.word.blocks),
    z
      .string()
      .min(1)
      .max(OfficeInputLimits.textChars)
      .describe(
        parameterDescription({
          description: '大段 Markdown 或纯文本内容。',
          notes: ['工具会自动转为 Word 段落、标题和列表。'],
        })
      ),
  ])
  .describe(
    parameterDescription({
      description: 'Word 内容块输入。',
      values: [
        '结构化 blocks 数组：完整控制段落、标题、表格和分页。',
        '字符串：按 Markdown 或纯文本自动生成内容块。',
      ],
    })
  )

/** office:create_word_document 完整输入 schema。 */
export const createWordDocumentSchema = z
  .object({
    cwd: z.string().optional(),
    outputPath: outputPathSchema,
    title: z.string().min(1).max(OfficeInputLimits.titleChars).optional(),
    author: z.string().min(1).max(OfficeInputLimits.shortFieldChars).optional(),
    profile: wordDocumentProfileSchema.optional().describe(
      parameterDescription({
        description: '文档排版模板。',
        values: [
          'standard：普通文档。',
          'academic-paper：学术论文。',
          'thesis：论文/毕业论文。',
        ],
      })
    ),
    language: z
      .enum(['zh-CN', 'en-US'])
      .optional()
      .describe(
        parameterDescription({
          description: '文档语言。',
          values: ['zh-CN：中文。', 'en-US：英文。'],
        })
      ),
    metadata: wordDocumentMetadataSchema.optional(),
    abstract: z.string().max(OfficeInputLimits.word.abstractChars).optional(),
    keywords: z
      .array(z.string().min(1).max(OfficeInputLimits.tinyFieldChars))
      .max(OfficeInputLimits.keywords)
      .optional(),
    includeTableOfContents: z.boolean().optional(),
    blocks: wordBlocksInputSchema.optional(),
    content: z
      .string()
      .min(1)
      .max(OfficeInputLimits.textChars)
      .optional()
      .describe(
        parameterDescription({
          description: '大段 Markdown 或纯文本内容。',
          usage: ['不需要精细结构化 blocks 时使用。'],
        })
      ),
    overwrite: z.boolean().optional(),
    appendMode: z.boolean().optional(),
  })
  .refine((input) => isPresent(input.blocks) || isNonBlankString(input.content), {
    path: ['blocks'],
    message: 'blocks 或 content 至少提供一个。',
  })

/** preset 档：只收 outputPath、content 与少量元数据。 */
export const createWordDocumentPresetSchema = z.object({
  outputPath: outputPathSchema,
  title: z.string().min(1).max(OfficeInputLimits.titleChars).optional(),
  content: z
    .string()
    .min(1)
    .max(OfficeInputLimits.textChars)
    .describe(
      parameterDescription({
        description: 'Markdown 或纯文本正文。',
        notes: ['工具会自动转为标题、段落、列表和表格。'],
      })
    ),
  overwrite: z.boolean().optional(),
})

/** guided 档：在 preset 之上加作者、语言、模板、摘要、关键词与目录。 */
export const createWordDocumentGuidedSchema = z.object({
  cwd: z.string().optional(),
  outputPath: outputPathSchema,
  title: z.string().min(1).max(OfficeInputLimits.titleChars).optional(),
  author: z.string().min(1).max(OfficeInputLimits.shortFieldChars).optional(),
  profile: wordDocumentProfileSchema.optional().describe(
    parameterDescription({
      description: '文档排版模板。',
      values: [
        'standard：普通文档。',
        'academic-paper：学术论文。',
        'thesis：论文/毕业论文。',
      ],
    })
  ),
  language: z
    .enum(['zh-CN', 'en-US'])
    .optional()
    .describe(
      parameterDescription({
        description: '文档语言。',
        values: ['zh-CN：中文。', 'en-US：英文。'],
      })
    ),
  metadata: wordDocumentMetadataSchema.optional(),
  abstract: z.string().max(OfficeInputLimits.word.abstractChars).optional(),
  keywords: z
    .array(z.string().min(1).max(OfficeInputLimits.tinyFieldChars))
    .max(OfficeInputLimits.keywords)
    .optional(),
  includeTableOfContents: z.boolean().optional(),
  content: z
    .string()
    .min(1)
    .max(OfficeInputLimits.textChars)
    .describe(
      parameterDescription({
        description: 'Markdown 或纯文本正文。',
        notes: ['需要富文本 runs 或表格单元格样式时切到 direct/expert。'],
      })
    ),
  overwrite: z.boolean().optional(),
  appendMode: z.boolean().optional(),
})
