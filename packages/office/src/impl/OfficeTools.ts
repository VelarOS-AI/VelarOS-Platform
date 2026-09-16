/**
 * office 空间的十个模型面工具：说明、入参 schema、surface、权限与能力声明都在这里；
 * 每个 execute 只写一行，交给 `impl/operations/` 里的执行类。文件末尾是工具集合与内核挂载。
 *
 * 人读这个包从这里开始：先看十个工具的信息面，再看 `contract/` 的三个文件与各执行类上方的接口。
 */

import { z } from 'zod'

import {
  createToolCallableOperations,
  renderParameterDescription as parameterDescription,
  structureToolDescriptionsForCategory,
} from '@velaros-ai/agent/tool-contract'
import { isNonBlankString, isPresent } from '@velaros-ai/core'
import {
  type CapabilityToken,
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  KernelModuleApiVersion,
  type KernelModuleDefinition,
} from '@velaros-ai/kernel/contracts/abi'

import {
  OfficeInputLimits,
  OfficeKernelModuleVersion,
  OfficeMarkdownLimits,
  OfficeModId,
  OfficePdfLimits,
  OfficePreviewLimits,
  OfficeToolNames,
} from '../contract/constants.js'
import type { OfficeCapabilityService, OfficeToolCollection } from '../contract/provides.js'
import type { CreateOfficeKernelModuleOptions } from '../contract/requires.js'
import type {
  ConvertDocumentToMarkdownInput,
  ConvertPdfToWordInput,
  ConvertWordToPdfInput,
  CreateLatexPdfInput,
  CreatePresentationInput,
  CreateSpreadsheetInput,
  CreateWordDocumentInput,
  EditPdfDocumentInput,
  ExtractPdfTextInput,
  PreviewOfficeDocumentInput,
} from '../types/inputs.js'
import type { OfficeToolCapabilitySchema } from '../types/tool.js'
import { spreadsheetSheetArraySchema } from '../utils/spreadsheet/content.js'
import { defineOfficeTool } from '../utils/tool.js'
import { OfficeTuning } from '../utils/tuning.js'

import { officeDocumentOperations } from './operations/OfficeDocumentOperations.js'
import { officeMarkdownOperations } from './operations/OfficeMarkdownOperations.js'
import { officePdfOperations } from './operations/OfficePdfOperations.js'
import { officePreviewOperations } from './operations/OfficePreviewOperations.js'
import { officeWorkspace } from './operations/OfficeWorkspace.js'

// ── 能力声明：三档（只读、写盘、写盘且要跑外部命令） ──────────────

const OfficeDocumentReadCapability = {
  effectKind: 'read',
  readScopes: ['project', 'system'],
  filesystem: { read: 'project', write: 'none' },
  canReadArbitrarySource: false,
  metadata: {
    project: {
      requiresActiveProject: true,
      requiresProjectSwitchForExternalCwd: true,
      arbitraryRead: true,
    },
    canMutateProject: false,
  },
  concurrency: 'safe',
  reason: 'office document inspection',
} satisfies OfficeToolCapabilitySchema

const OfficeDocumentWriteCapability = {
  effectKind: 'write',
  readScopes: ['project', 'system'],
  writeScopes: ['project'],
  filesystem: { read: 'project', write: 'project' },
  metadata: {
    project: {
      requiresActiveProject: true,
      requiresProjectSwitchForExternalCwd: true,
      mutation: 'non-transactional',
      arbitraryRead: true,
    },
    canMutateProject: true,
  },
  concurrency: 'unsafe',
  reason: 'office document creation or conversion',
} satisfies OfficeToolCapabilitySchema

const OfficeDocumentProcessCapability = {
  ...OfficeDocumentWriteCapability,
  process: { execution: 'input-dependent' },
  reason: 'office document conversion with local process execution',
} satisfies OfficeToolCapabilitySchema

// ── 共用 schema 片段 ───────────────────────────────────────────

/** Office 输出路径 schema；具体工具会再按扩展名校验。 */
const outputPathSchema = z
  .string()
  .min(1)
  .max(OfficeInputLimits.pathChars)
  .describe(
    parameterDescription({
      description: '输出文件路径。',
      usage: ['支持相对当前工作区的路径。'],
      notes: ['无扩展名时会按工具类型自动补齐。'],
    })
  )

// ── Word schema ───────────────────────────────────────────────

const wordTextRunSchema = z.object({
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

const wordTableCellSchema = z.object({
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

const wordDocumentProfileSchema = z.enum(['standard', 'academic-paper', 'thesis'])

const wordDocumentMetadataSchema = z.object({
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

const wordBlockSchema = z.discriminatedUnion('kind', [
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

const wordBlocksInputSchema = z
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

const createWordDocumentSchema = z
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

const createWordDocumentPresetSchema = z.object({
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

const createWordDocumentGuidedSchema = z.object({
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

// ── PowerPoint schema ─────────────────────────────────────────

const pptTextPropsSchema = z.object({
  text: z.string(),
  options: z.record(z.string(), z.any()).optional(),
})

const pptElementSchema = z.discriminatedUnion('kind', [
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

const presentationSlidesInputSchema = z
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

const createPresentationSchema = z
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

const createPresentationPresetSchema = z.object({
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

const createPresentationGuidedSchema = z.object({
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

// ── Excel schema ──────────────────────────────────────────────

const spreadsheetSheetsInputSchema = z
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

const createSpreadsheetSchema = z
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

const createSpreadsheetPresetSchema = z.object({
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

const createSpreadsheetGuidedSchema = z.object({
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

// ── PDF schema ────────────────────────────────────────────────

const inputPdfPathSchema = z
  .string()
  .min(1)
  .max(OfficeInputLimits.pathChars)
  .describe(
    parameterDescription({
      description: '输入 PDF 文件路径。',
      usage: ['支持相对当前工作区的路径。'],
    })
  )

const convertPdfToWordSchema = z.object({
  cwd: z.string().optional(),
  inputPath: inputPdfPathSchema,
  outputPath: outputPathSchema,
  title: z.string().min(1).max(OfficeInputLimits.titleChars).optional(),
  author: z.string().min(1).max(OfficeInputLimits.shortFieldChars).optional(),
  maxPages: z.number().int().min(1).max(OfficePdfLimits.convertPages).optional(),
  overwrite: z.boolean().optional(),
})

const extractPdfTextSchema = z
  .object({
    cwd: z.string().optional(),
    inputPath: inputPdfPathSchema,
    pages: z
      .array(z.number().int().positive())
      .min(1)
      .max(OfficePdfLimits.readPages)
      .optional()
      .describe(
        parameterDescription({
          description: '要提取的 PDF 页码，使用从 1 开始的编号。',
          notes: ['按传入顺序返回；重复页码只提取一次。'],
        })
      ),
    maxPages: z
      .number()
      .int()
      .min(1)
      .max(OfficePdfLimits.readPages)
      .optional()
      .describe(
        parameterDescription({
          description: '从第一页开始最多提取的页数。',
          notes: [`省略 pages 和 maxPages 时默认读取前 ${OfficePdfLimits.defaultReadPages} 页。`],
        })
      ),
  })
  .superRefine((input, context) => {
    if (input.pages && input.maxPages) {
      context.addIssue({
        code: 'custom',
        message: 'pages 和 maxPages 不能同时传入。',
        path: ['pages'],
      })
    }
  })

const inputWordPathSchema = z
  .string()
  .min(1)
  .max(OfficeInputLimits.pathChars)
  .describe(
    parameterDescription({
      description: '输入 Word 文件路径。',
      usage: ['支持 .docx 或 .doc，也支持相对当前工作区的路径。'],
    })
  )

const convertWordToPdfSchema = z.object({
  cwd: z.string().optional(),
  inputPath: inputWordPathSchema,
  outputPath: outputPathSchema,
  overwrite: z.boolean().optional(),
})

const pdfTextStampSchema = z.object({
  text: z.string().min(1).max(OfficePdfLimits.textStampChars),
  page: z.number().int().positive().optional(),
  allPages: z.boolean().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  size: z.number().min(OfficePdfLimits.minFontSize).max(OfficePdfLimits.maxFontSize).optional(),
  color: z.string().optional(),
  opacity: z.number().min(0).max(1).optional(),
})

const editPdfDocumentSchema = z.object({
  cwd: z.string().optional(),
  inputPath: inputPdfPathSchema,
  outputPath: outputPathSchema,
  overwrite: z.boolean().optional(),
  pageSelection: z.array(z.number().int().positive()).min(1).max(OfficePdfLimits.pageList).optional(),
  removePages: z.array(z.number().int().positive()).max(OfficePdfLimits.pageList).optional(),
  rotatePages: z
    .array(
      z.object({
        page: z.number().int().positive(),
        degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]),
      })
    )
    .max(OfficePdfLimits.pageList)
    .optional(),
  textStamps: z.array(pdfTextStampSchema).max(OfficePdfLimits.textStamps).optional(),
  metadata: z
    .object({
      title: z.string().min(1).max(OfficeInputLimits.titleChars).optional(),
      author: z.string().min(1).max(OfficeInputLimits.shortFieldChars).optional(),
      subject: z.string().min(1).max(OfficeInputLimits.subjectChars).optional(),
      keywords: z
        .array(z.string().min(1).max(OfficeInputLimits.tinyFieldChars))
        .max(OfficeInputLimits.keywords)
        .optional(),
    })
    .optional(),
})

const latexSourcePathSchema = z
  .string()
  .min(1)
  .max(OfficeInputLimits.pathChars)
  .describe(
    parameterDescription({
      description: '可选的 .tex 源文件输出路径。',
      notes: ['省略时与 PDF 同名写在同目录。'],
    })
  )

const createLatexPdfSchema = z.object({
  cwd: z.string().optional(),
  outputPath: outputPathSchema,
  sourcePath: latexSourcePathSchema.optional(),
  latexSource: z
    .string()
    .min(1)
    .max(OfficeInputLimits.textChars)
    .describe(
      parameterDescription({
        description: '完整 LaTeX 源码。',
        notes: ['工具会写入 .tex 并编译为 PDF。'],
      })
    ),
  compiler: z
    .enum(['auto', 'tectonic', 'latexmk', 'xelatex', 'pdflatex'])
    .optional()
    .describe(
      parameterDescription({
        description: 'LaTeX 编译器选择。',
        values: [
          'auto：按可用性自动尝试。',
          'tectonic：使用 tectonic。',
          'latexmk：使用 latexmk。',
          'xelatex：使用 xelatex。',
          'pdflatex：使用 pdflatex。',
        ],
      })
    ),
  runs: z
    .number()
    .int()
    .min(1)
    .max(OfficePdfLimits.compileRuns)
    .optional()
    .describe(
      parameterDescription({
        description: 'xelatex 或 pdflatex 编译轮数。',
        notes: [`默认 ${OfficeTuning.pdf.latexRuns}；latexmk 和 tectonic 会忽略该值。`],
      })
    ),
  overwrite: z.boolean().optional(),
})

// ── 预览与 Markdown schema ────────────────────────────────────

const previewOfficeDocumentSchema = z.object({
  cwd: z.string().optional(),
  inputPath: z
    .string()
    .min(1)
    .max(OfficeInputLimits.pathChars)
    .describe(
      parameterDescription({
        description: '输入 Office 文件路径。',
        usage: ['支持 .docx、.doc、.pptx、.xlsx，也支持相对当前工作区的路径。'],
      })
    ),
  outputPath: outputPathSchema
    .optional()
    .describe(
      parameterDescription({
        description: '可选预览输出路径，支持 .html 或 .png。',
        notes: ['无扩展名时自动补齐 .html；需要静态预览图时显式使用 .png。'],
      })
    ),
  overwrite: z.boolean().optional(),
  maxItems: z.number().int().min(1).max(OfficePreviewLimits.maxItems).optional(),
  autoRefresh: z
    .boolean()
    .optional()
    .describe(
      parameterDescription({
        description: '生成 HTML 预览时是否加入自动刷新脚本。',
        usage: ['便于在浏览器中查看最新预览。'],
      })
    ),
})

const convertDocumentToMarkdownSchema = z.object({
  cwd: z.string().optional(),
  inputPath: z
    .string()
    .min(1)
    .max(OfficeInputLimits.pathChars)
    .describe(
      parameterDescription({
        description: '输入文件路径。',
        usage: ['支持 PDF、Word、PowerPoint、Excel、HTML、CSV、JSON、XML、ZIP、EPub 和文本文件。'],
        notes: ['只支持本地工作区内文件，不接受 URL。'],
      })
    ),
  outputPath: outputPathSchema.optional().describe(
    parameterDescription({
      description: '可选 Markdown 输出路径。',
      notes: ['无扩展名时自动补齐 .md；写入前会走工作区 mutation 授权。'],
    })
  ),
  overwrite: z.boolean().optional(),
  maxChars: z
    .number()
    .int()
    .min(OfficeMarkdownLimits.minReturnChars)
    .max(OfficeMarkdownLimits.maxReturnChars)
    .optional()
    .describe(
      parameterDescription({
        description: '返回结果中最多包含的 Markdown 字符数。',
        notes: ['写入 outputPath 时仍会保存完整 Markdown；该限制只影响工具返回文本。'],
      })
    ),
})

// ── 工具：生成 Word 文档 ──────────────────────────────────────

const createWordDocument = defineOfficeTool<CreateWordDocumentInput>({
  name: OfficeToolNames.createWordDocument,
  role: 'render',
  summary: '生成 .docx Word 文档。',
  suitable: ['需要生成普通文档、学术论文、论文模板或带表格的 Word 文件。'],
  forbidden: ['不要用它生成 PDF、PPT 或 Excel。'],
  usage: ['传 outputPath，并提供 blocks 或 content；复杂样式用结构化 blocks。'],
  examples: [
    // 简单：Markdown/纯文本自动排版
    { outputPath: 'report.docx', content: '# Summary\nDetails' },
    // 结构化：blocks 精细控制标题/正文/项目符号/表格/分页
    {
      outputPath: 'spec.docx',
      blocks: [
        { kind: 'heading', text: '设计说明', level: 1 },
        { kind: 'paragraph', text: '本节描述整体架构。' },
        { kind: 'bullets', items: ['模块 A', '模块 B'] },
        {
          kind: 'table',
          header: true,
          rows: [
            [{ text: '字段' }, { text: '类型' }],
            [{ text: 'id' }, { text: 'string' }],
          ],
        },
        { kind: 'pageBreak' },
      ],
    },
  ],
  notes: ['结构化 blocks 支持富文本、多级标题、列表、表格和分页符。'],
  schema: createWordDocumentSchema as z.ZodType<CreateWordDocumentInput>,
  surfaces: {
    preset: {
      role: 'render',
      summary: '用文本内容快速生成 Word 文档。',
      suitable: ['只需要 outputPath、content 和少量元数据。'],
      forbidden: ['不要用于富文本 runs 或精细表格样式。'],
      usage: ['传 outputPath 和 content；可传 title、overwrite。'],
      examples: [{ outputPath: "note.docx", content: "# Note\nBody" }],
      notes: ['content 支持 Markdown 和纯文本自动排版。'],
      schema: createWordDocumentPresetSchema,
      normalize: (input): CreateWordDocumentInput => ({
        outputPath: input.outputPath,
        title: input.title,
        content: input.content,
        overwrite: input.overwrite,
      }),
    },
    guided: {
      role: 'render',
      summary: '用文本内容和常见元数据生成 Word 文档。',
      suitable: ['需要设置作者、语言、模板、摘要、关键词或目录。'],
      forbidden: ['不要用于富文本 runs 和精细表格单元格样式。'],
      usage: ['传 outputPath 和 content；按需传 profile、metadata、includeTableOfContents。'],
      examples: [{ outputPath: "paper.docx", content: "# Abstract", profile: "academic-paper" }],
      notes: ['复杂内容块保留给 direct/expert。'],
      schema: createWordDocumentGuidedSchema,
      normalize: (input): CreateWordDocumentInput => ({ ...input, content: input.content }),
    },
  },
  permissions: ['fs:read', 'fs:write'],
  capabilities: OfficeDocumentWriteCapability,
  isAvailable: (ctx) => officeWorkspace.hasRoot(ctx),
  isConcurrencySafe: () => false,
  execute: (input, ctx) => officeDocumentOperations.createWordDocument(input, ctx),
})

// ── 工具：生成 PowerPoint 演示文稿 ────────────────────────────

const createPresentation = defineOfficeTool<CreatePresentationInput>({
  name: OfficeToolNames.createPresentation,
  role: 'render',
  summary: '生成 .pptx PowerPoint 演示文稿。',
  suitable: ['需要生成自动排版幻灯片，或用结构化元素精细控制 PPTX。'],
  forbidden: ['不要用它生成电子表格或 Word 文档。'],
  usage: ['传 outputPath，并提供 slides 或 content；模板用 template 选择。'],
  examples: [
    // 简单：用 Markdown/纯文本自动拆页（# 标题、--- 分页）
    { outputPath: 'deck.pptx', content: '# Title\n---\n## Agenda' },
    // 结构化：slides + elements 精细控制坐标（x/y/w/h 单位英寸），可加 speaker notes
    {
      outputPath: 'q3-review.pptx',
      template: 'consulting',
      slides: [
        {
          elements: [
            { kind: 'text', value: 'Q3 Review', x: 0.5, y: 0.4, w: 9, h: 1 },
            {
              kind: 'table',
              rows: [
                ['Metric', 'Value'],
                ['Revenue', '1.2M'],
              ],
              x: 0.5,
              y: 2,
              w: 9,
              h: 3,
            },
          ],
          notes: '强调环比增长',
        },
      ],
    },
  ],
  notes: ['direct/expert 可用 elements 控制 text、table、shape、image、chart。'],
  schema: createPresentationSchema,
  surfaces: {
    preset: {
      role: 'render',
      summary: '用文本内容快速生成 PowerPoint。',
      suitable: ['只需要 outputPath、content 和少量元数据。'],
      forbidden: ['不要用于自定义坐标、图片或图表。'],
      usage: ['传 outputPath 和 content；可传 title、template、overwrite。'],
      examples: [{ outputPath: "brief.pptx", content: "# Brief\n---\nDetails" }],
      notes: ['content 会用 # 标题和 --- 自动拆页。'],
      schema: createPresentationPresetSchema,
      normalize: (input): CreatePresentationInput => ({
        outputPath: input.outputPath,
        title: input.title,
        content: input.content,
        template: input.template,
        overwrite: input.overwrite,
      }),
    },
    guided: {
      role: 'render',
      summary: '用文本内容和常见选项生成 PowerPoint。',
      suitable: ['需要选择模板、布局、作者或 RTL 模式。'],
      forbidden: ['不要用于精细元素坐标和复杂主题对象。'],
      usage: ['传 outputPath 和 content；按需传 layout、template、rtlMode。'],
      examples: [{ outputPath: "deck.pptx", content: "# Plan", template: "consulting" }],
      notes: ['复杂元素保留给 direct/expert。'],
      schema: createPresentationGuidedSchema,
      normalize: (input): CreatePresentationInput => ({ ...input, content: input.content }),
    },
  },
  permissions: ['fs:read', 'fs:write'],
  capabilities: OfficeDocumentWriteCapability,
  isAvailable: (ctx) => officeWorkspace.hasRoot(ctx),
  isConcurrencySafe: () => false,
  execute: (input, ctx) => officeDocumentOperations.createPresentation(input, ctx),
})

// ── 工具：生成 Excel 工作簿 ───────────────────────────────────

const createSpreadsheet = defineOfficeTool<CreateSpreadsheetInput>({
  name: OfficeToolNames.createSpreadsheet,
  role: 'render',
  summary: '生成 .xlsx Excel 工作簿。',
  suitable: ['需要生成表格、公式、多工作表或带格式的 Excel 文件。'],
  forbidden: ['不要用它生成 Word、PowerPoint 或 PDF 文档。'],
  usage: ['传 outputPath，并提供 sheets 或 content；复杂样式用结构化 sheets。'],
  examples: [
    // 简单：CSV/TSV/Markdown 表格自动生成单表
    { outputPath: 'data.xlsx', content: 'name,value\nA,1' },
    // 结构化：多工作表 + 单元格样式，rows 里可混用原始值与样式对象
    {
      outputPath: 'report.xlsx',
      sheets: [
        {
          name: 'Sales',
          columns: ['Region', 'Q1'],
          rows: [
            [
              { value: 'Region', font: { bold: true } },
              { value: 'Q1', font: { bold: true } },
            ],
            ['North', 1200],
            ['South', 980],
          ],
          freezeRows: 1,
        },
      ],
    },
  ],
  notes: ['结构化单元格支持字体、填充、边框、数字格式、富文本、链接和合并。'],
  schema: createSpreadsheetSchema as z.ZodType<CreateSpreadsheetInput>,
  surfaces: {
    preset: {
      role: 'render',
      summary: '用文本内容快速生成 Excel 工作簿。',
      suitable: ['只需要 outputPath、content 和少量元数据。'],
      forbidden: ['不要用于多工作表或精细单元格样式。'],
      usage: ['传 outputPath 和 content；可传 title、overwrite。'],
      examples: [{ outputPath: "table.xlsx", content: "a,b\n1,2" }],
      notes: ['content 支持 CSV、TSV、Markdown 表格或 JSON rows。'],
      schema: createSpreadsheetPresetSchema,
      normalize: (input): CreateSpreadsheetInput => ({
        outputPath: input.outputPath,
        title: input.title,
        content: input.content,
        overwrite: input.overwrite,
      }),
    },
    guided: {
      role: 'render',
      summary: '用文本内容和常见元数据生成 Excel 工作簿。',
      suitable: ['需要设置 cwd、title、author 或覆盖策略。'],
      forbidden: ['不要用于多工作表、公式对象或精细样式。'],
      usage: ['传 outputPath 和 content；按需传 title、author、overwrite。'],
      examples: [{ outputPath: "metrics.xlsx", content: "| k | v |\n|---|---|\n| a | 1 |" }],
      notes: ['复杂工作簿保留给 direct/expert。'],
      schema: createSpreadsheetGuidedSchema,
      normalize: (input): CreateSpreadsheetInput => ({ ...input, content: input.content }),
    },
  },
  permissions: ['fs:read', 'fs:write'],
  capabilities: OfficeDocumentWriteCapability,
  isAvailable: (ctx) => officeWorkspace.hasRoot(ctx),
  isConcurrencySafe: () => false,
  execute: (input, ctx) => officeDocumentOperations.createSpreadsheet(input, ctx),
})

// ── 工具：按页提取 PDF 文本 ───────────────────────────────────

const extractPdfText = defineOfficeTool<ExtractPdfTextInput>({
  name: OfficeToolNames.extractPdfText,
  role: 'inspect',
  summary: '按页提取文本型 PDF 中的可选择文本。',
  suitable: ['读取 PDF 的指定页、核对正文，或为后续总结提取有界文本。'],
  forbidden: ['不要用于扫描件或图片型 PDF 的 OCR，也不要用于编辑或转换 PDF。'],
  protocol: [
    '页码使用从 1 开始的编号；指定页使用 pages，读取前若干页使用 maxPages。',
    `省略 pages 和 maxPages 时只读取前 ${OfficePdfLimits.defaultReadPages} 页；hasMore=true 表示仍有未读取页面。`,
  ],
  usage: ['传 inputPath；需要单页或离散页面时传 pages，例如 pages=[2,5]。'],
  examples: [{ inputPath: 'paper.pdf', pages: [2] }],
  notes: ['返回总页数和逐页文本；重复页码只提取一次并保持首次出现顺序。'],
  schema: extractPdfTextSchema,
  permissions: ['fs:read'],
  capabilities: OfficeDocumentReadCapability,
  isAvailable: (ctx) => officeWorkspace.hasRoot(ctx),
  isConcurrencySafe: () => true,
  execute: (input, ctx) => officePdfOperations.extractText(input, ctx),
})

// ── 工具：PDF 转 Word ─────────────────────────────────────────

const convertPdfToWord = defineOfficeTool<ConvertPdfToWordInput>({
  name: OfficeToolNames.convertPdfToWord,
  role: 'render',
  summary: '将 PDF 可提取文本转换为 Word 文档。',
  suitable: ['需要把 PDF 文本抽取到 .docx 中继续编辑。'],
  forbidden: ['不要期待它对扫描件或图片型 PDF 做 OCR。'],
  usage: ['传 inputPath 和 outputPath；可传 maxPages 限制页数。'],
  examples: [{ inputPath: "paper.pdf", outputPath: "paper.docx", maxPages: 20 }],
  notes: ['输出按页生成 Word 段落。'],
  schema: convertPdfToWordSchema,
  permissions: ['fs:read', 'fs:write'],
  capabilities: OfficeDocumentWriteCapability,
  isAvailable: (ctx) => officeWorkspace.hasRoot(ctx),
  isConcurrencySafe: () => false,
  execute: (input, ctx) => officePdfOperations.convertPdfToWord(input, ctx),
})

// ── 工具：Word 转 PDF ─────────────────────────────────────────

const convertWordToPdf = defineOfficeTool<ConvertWordToPdfInput>({
  name: OfficeToolNames.convertWordToPdf,
  role: 'render',
  summary: '将 Word 文档转换为 PDF。',
  suitable: ['需要把 .docx 或 .doc 文件导出为 .pdf 并尽量保留排版。'],
  forbidden: ['不要用于扫描图片 OCR 或 PDF 编辑。'],
  usage: ['传 inputPath 和 outputPath；覆盖已有文件时传 overwrite=true。'],
  examples: [{ inputPath: "report.docx", outputPath: "report.pdf" }],
  notes: ['旧版 .doc 会先临时归一化为 .docx；转换依赖本机 LibreOffice。'],
  schema: convertWordToPdfSchema,
  permissions: ['fs:read', 'fs:write', 'process:exec'],
  capabilities: OfficeDocumentProcessCapability,
  isAvailable: (ctx) => officeWorkspace.hasRoot(ctx),
  isConcurrencySafe: () => false,
  execute: (input, ctx) => officePdfOperations.convertWordToPdf(input, ctx),
})

// ── 工具：LaTeX 生成 PDF ──────────────────────────────────────

const createLatexPdf = defineOfficeTool<CreateLatexPdfInput>({
  name: OfficeToolNames.createLatexPdf,
  role: 'render',
  summary: '编译 LaTeX 源码并输出 PDF。',
  suitable: ['需要生成论文、数学公式、严肃排版或依赖 LaTeX 的 PDF。'],
  forbidden: ['不要用于普通文本转 PDF；普通文档优先生成 Word 或演示稿。'],
  protocol: ['先写入 .tex 源码；编译失败时读取命令输出后修正源码再重试。'],
  usage: ['传 outputPath 和 latexSource；可指定 compiler、sourcePath 和 runs。'],
  examples: [{ outputPath: "paper.pdf", latexSource: "\\documentclass{article}..." }],
  notes: ['会尝试 tectonic、latexmk、xelatex、pdflatex。'],
  schema: createLatexPdfSchema,
  permissions: ['fs:read', 'fs:write', 'process:exec'],
  capabilities: OfficeDocumentProcessCapability,
  isAvailable: (ctx) => officeWorkspace.hasRoot(ctx),
  isConcurrencySafe: () => false,
  execute: (input, ctx) => officePdfOperations.createLatexPdf(input, ctx),
})

// ── 工具：编辑 PDF ────────────────────────────────────────────

const editPdfDocument = defineOfficeTool<EditPdfDocumentInput>({
  name: OfficeToolNames.editPdfDocument,
  role: 'edit',
  summary: '编辑现有 PDF 并输出新 PDF。',
  suitable: ['需要复制、拆分、重排、删除、旋转页面，添加文字戳或修改元数据。'],
  forbidden: ['不要用它直接覆盖原文件，除非明确传 overwrite=true 且输出路径可覆盖。'],
  usage: ['传 inputPath 和 outputPath；按需传 pageSelection、removePages、rotatePages、textStamps 或 metadata。'],
  examples: [{ inputPath: "in.pdf", outputPath: "out.pdf", removePages: [1] }],
  notes: ['页码使用 1-based 编号。'],
  schema: editPdfDocumentSchema,
  permissions: ['fs:read', 'fs:write'],
  capabilities: OfficeDocumentWriteCapability,
  isAvailable: (ctx) => officeWorkspace.hasRoot(ctx),
  isConcurrencySafe: () => false,
  execute: (input, ctx) => officePdfOperations.editPdf(input, ctx),
})

// ── 工具：预览 Office 文档 ────────────────────────────────────

const previewOfficeDocument = defineOfficeTool<PreviewOfficeDocumentInput>({
  name: OfficeToolNames.previewDocument,
  role: 'render',
  summary: '解析 Office 文档并可生成 HTML 或 PNG 预览。',
  suitable: ['需要检查生成后的 Word、PowerPoint 或 Excel 文档结构和摘要。'],
  forbidden: ['不要用它编辑文档内容。'],
  usage: [
    '传 inputPath；需要预览文件时传 .html 或 .png outputPath。',
    '重复写入同一个 outputPath 时传 overwrite=true。',
  ],
  examples: [
    { inputPath: 'report.docx', outputPath: 'preview.html' },
    { inputPath: 'metrics.xlsx', outputPath: 'preview.png' },
  ],
  notes: ['.doc 会先临时转为 .docx 后解析。'],
  schema: previewOfficeDocumentSchema,
  permissions: ['fs:read', 'fs:write', 'process:exec'],
  capabilities: OfficeDocumentProcessCapability,
  isAvailable: (ctx) => officeWorkspace.hasRoot(ctx),
  isConcurrencySafe: (input) => !input.outputPath,
  execute: (input, ctx) => officePreviewOperations.preview(input, ctx),
})

// ── 工具：文档转 Markdown ─────────────────────────────────────

const convertDocumentToMarkdown = defineOfficeTool<ConvertDocumentToMarkdownInput>({
  name: OfficeToolNames.convertDocumentToMarkdown,
  role: 'inspect',
  summary: '用 MarkItDown 将工作区文档转换成 Markdown，便于模型读取。',
  suitable: ['需要把 PDF、Office、HTML 或结构化文本文件转换成模型可读 Markdown。'],
  forbidden: ['不要用它读取工作区外路径或远程 URL。', '不要把它当成高保真排版转换器。'],
  protocol: ['先传工作区内 inputPath；需要持久化结果时再传 outputPath。'],
  usage: ['传 inputPath；可选 outputPath 写入 .md；用 maxChars 控制返回文本长度。'],
  examples: [{ inputPath: 'report.pdf', outputPath: 'report.md', maxChars: 40000 }],
  notes: ['使用随应用打包的 Microsoft MarkItDown runtime，不要求用户自行安装 CLI。'],
  schema: convertDocumentToMarkdownSchema,
  permissions: ['fs:read', 'fs:write', 'process:exec'],
  capabilities: OfficeDocumentProcessCapability,
  hideWhenUnavailable: true,
  isAvailable: (ctx) => officeWorkspace.hasRoot(ctx) && !!officeMarkdownOperations.locateMarkItDown(ctx),
  isConcurrencySafe: (input) => !input.outputPath,
  execute: (input, ctx) => officeMarkdownOperations.convertToMarkdown(input, ctx),
})

// ── 工具集合 ──────────────────────────────────────────────────

/** office 空间公开的十个工具，按工具名索引。 */
export const officeTools: OfficeToolCollection = structureToolDescriptionsForCategory(
  {
    [OfficeToolNames.createWordDocument]: createWordDocument,
    [OfficeToolNames.createPresentation]: createPresentation,
    [OfficeToolNames.createSpreadsheet]: createSpreadsheet,
    [OfficeToolNames.extractPdfText]: extractPdfText,
    [OfficeToolNames.convertPdfToWord]: convertPdfToWord,
    [OfficeToolNames.convertWordToPdf]: convertWordToPdf,
    [OfficeToolNames.createLatexPdf]: createLatexPdf,
    [OfficeToolNames.editPdfDocument]: editPdfDocument,
    [OfficeToolNames.previewDocument]: previewOfficeDocument,
    [OfficeToolNames.convertDocumentToMarkdown]: convertDocumentToMarkdown,
  },
  'office',
) as OfficeToolCollection

// ── 作为能力服务挂进 VelarOS 内核 ─────────────────────────────

/** office 能力服务在内核里的身份令牌，宿主按它取到注入的 office 工具集合。 */
export const OfficeCapability: CapabilityToken<OfficeCapabilityService> =
  createCapabilityToken<OfficeCapabilityService>(OfficeModId)

/** 创建 office 空间的内核模块：激活时把十个工具登记成能力服务；宿主给了上下文解析器，工具才能被按名调用。 */
export function createOfficeKernelModule(
  options: CreateOfficeKernelModuleOptions = {},
): KernelModuleDefinition {
  return defineKernelModule({
    manifest: {
      id: OfficeModId,
      version: OfficeKernelModuleVersion,
      apiVersion: KernelModuleApiVersion,
      provides: [OfficeCapability],
      requires: [],
      optionalRequires: [],
      permissions: ['fs:read', 'fs:write', 'process:exec'],
      isolation: 'in-process',
    },
    activate(context) {
      const callable = createKernelCallableCapability(
        createToolCallableOperations(officeTools, options.resolveContext, { label: '办公' }),
      )
      const service: OfficeCapabilityService = Object.freeze({
        ...callable,
        tools: Object.freeze({ ...officeTools }),
      })
      context.registerService(OfficeCapability, service)
    },
  })
}
