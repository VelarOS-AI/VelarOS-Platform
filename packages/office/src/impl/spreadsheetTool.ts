/**
 * office:create_spreadsheet 的入参 schema（含 preset / guided 两个 surface）。
 * 内容解析、样式翻译与写表原语已经搬进 utils/spreadsheet/*，这里只剩 wire 面的校验。
 */

import { z } from 'zod'

import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/agent/tool-contract'
import { isNonBlankString, isPresent } from '@velaros-ai/core'

import { OfficeInputLimits } from '../contract/constants.js'
import { spreadsheetSheetArraySchema } from '../utils/spreadsheet/content.js'

import { outputPathSchema } from './officeShared'

/** sheets 既可以是结构化数组，也可以是待解析的 CSV/TSV/Markdown 表格文本。 */
export const spreadsheetSheetsInputSchema = z
  .union([
    spreadsheetSheetArraySchema,
    z
      .string()
      .min(1)
      .max(OfficeInputLimits.textChars)
      .describe(
        parameterDescription({
          description: 'CSV、TSV 或 Markdown 表格内容。',
          notes: ['工具会自动转为单个工作表。'],
        })
      ),
  ])
  .describe(
    parameterDescription({
      description: 'Excel 工作表输入。',
      values: [
        '结构化 sheets 数组：完整控制多工作表、列和单元格。',
        '字符串：按 CSV、TSV 或 Markdown 表格自动生成单表。',
      ],
    })
  )

/** 创建工作簿的入口 schema，最后 refine 保证至少有一种内容来源。 */
export const createSpreadsheetSchema = z
  .object({
    cwd: z.string().optional(),
    outputPath: outputPathSchema,
    title: z.string().min(1).max(OfficeInputLimits.titleChars).optional(),
    author: z.string().min(1).max(OfficeInputLimits.shortFieldChars).optional(),
    sheets: spreadsheetSheetsInputSchema.optional(),
    content: z
      .string()
      .min(1)
      .max(OfficeInputLimits.textChars)
      .optional()
      .describe(
        parameterDescription({
          description: 'CSV、TSV 或 Markdown 表格内容。',
          usage: ['不需要精细结构化 sheets 时使用。'],
        })
      ),
    overwrite: z.boolean().optional(),
  })
  .refine((input) => isPresent(input.sheets) || isNonBlankString(input.content), {
    path: ['sheets'],
    message: 'sheets 或 content 至少提供一个。',
  })

/** preset 档：只收 outputPath、content 与标题。 */
export const createSpreadsheetPresetSchema = z.object({
  outputPath: outputPathSchema,
  title: z.string().min(1).max(OfficeInputLimits.titleChars).optional(),
  content: z
    .string()
    .min(1)
    .max(OfficeInputLimits.textChars)
    .describe(
      parameterDescription({
        description: 'CSV、TSV、Markdown 表格或 JSON rows。',
        notes: ['工具会自动转为单张工作表。'],
      })
    ),
  overwrite: z.boolean().optional(),
})

/** guided 档：在 preset 之上加作者与覆盖策略。 */
export const createSpreadsheetGuidedSchema = z.object({
  cwd: z.string().optional(),
  outputPath: outputPathSchema,
  title: z.string().min(1).max(OfficeInputLimits.titleChars).optional(),
  author: z.string().min(1).max(OfficeInputLimits.shortFieldChars).optional(),
  content: z
    .string()
    .min(1)
    .max(OfficeInputLimits.textChars)
    .describe(
      parameterDescription({
        description: 'CSV、TSV、Markdown 表格或 JSON rows。',
        notes: ['多工作表、样式和公式对象请切到 direct/expert。'],
      })
    ),
  overwrite: z.boolean().optional(),
})
