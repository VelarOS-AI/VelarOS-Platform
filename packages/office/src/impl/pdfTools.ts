/**
 * 五个 PDF 工具的入参 schema，以及要跟宿主打交道的两件事：找本机可用的 LaTeX 编译器、按顺序跑编译命令。
 * 页面原语、LaTeX 命令行与 pdfjs 运行时已经搬进 utils/pdf/*。
 */

import { z } from 'zod'

import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/agent/tool-contract'

import { OfficeInputLimits, OfficePdfLimits } from '../contract/constants.js'
import type {
  OfficeEnvironmentCommandAvailability,
  OfficeNativeCommand,
  OfficeSystemCommandResult,
} from '../types/office.js'
import type { LatexCompiler } from '../types/pdf.js'
import { resolveLatexCompilerCandidates } from '../utils/pdf/latex.js'
import { OfficeTuning } from '../utils/tuning.js'

import {
  findAvailableCommand,
  type OfficeToolContext,
  outputPathSchema,
  runOfficeSystemCommand,
} from './officeShared'

// ─── Zod schemas ───────────────────────────────────────────────────────────────

// PDF 输入路径 schema 会在具体执行时解析成工作区内的真实文件路径。
export const inputPdfPathSchema = z
  .string()
  .min(1)
  .max(OfficeInputLimits.pathChars)
  .describe(
    parameterDescription({
      description: '输入 PDF 文件路径。',
      usage: ['支持相对当前工作区的路径。'],
    })
  )

// PDF 转 Word 参数校验，maxPages 用于限制提取页数，避免超大 PDF 长时间运行。
export const convertPdfToWordSchema = z.object({
  cwd: z.string().optional(),
  inputPath: inputPdfPathSchema,
  outputPath: outputPathSchema,
  title: z.string().min(1).max(OfficeInputLimits.titleChars).optional(),
  author: z.string().min(1).max(OfficeInputLimits.shortFieldChars).optional(),
  maxPages: z.number().int().min(1).max(OfficePdfLimits.convertPages).optional(),
  overwrite: z.boolean().optional(),
})

// PDF 文本读取必须显式选择页码或接受有界前缀；两种选择方式不能同时出现。
export const extractPdfTextSchema = z
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

// Word 输入路径允许 .docx/.doc，后续会按扩展名补全查找。
export const inputWordPathSchema = z
  .string()
  .min(1)
  .max(OfficeInputLimits.pathChars)
  .describe(
    parameterDescription({
      description: '输入 Word 文件路径。',
      usage: ['支持 .docx 或 .doc，也支持相对当前工作区的路径。'],
    })
  )

// Word 转 PDF 参数校验，只负责路径和覆盖策略，实际转换由 LibreOffice 完成。
export const convertWordToPdfSchema = z.object({
  cwd: z.string().optional(),
  inputPath: inputWordPathSchema,
  outputPath: outputPathSchema,
  overwrite: z.boolean().optional(),
})

// 文字戳 schema 控制文本长度、字号、透明度和目标页范围。
export const pdfTextStampSchema = z.object({
  text: z.string().min(1).max(OfficePdfLimits.textStampChars),
  page: z.number().int().positive().optional(),
  allPages: z.boolean().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  size: z.number().min(OfficePdfLimits.minFontSize).max(OfficePdfLimits.maxFontSize).optional(),
  color: z.string().optional(),
  opacity: z.number().min(0).max(1).optional(),
})

// PDF 编辑 schema 汇总页面操作、文字戳和元数据写入。
export const editPdfDocumentSchema = z.object({
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

// LaTeX 源文件路径可选；省略时根据 outputPath 推导出同名 .tex。
export const latexSourcePathSchema = z
  .string()
  .min(1)
  .max(OfficeInputLimits.pathChars)
  .describe(
    parameterDescription({
      description: '可选的 .tex 源文件输出路径。',
      notes: ['省略时与 PDF 同名写在同目录。'],
    })
  )

// LaTeX 生成 PDF 参数校验，同时限制源码长度和编译轮数。
export const createLatexPdfSchema = z.object({
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

// ─── LaTeX helpers（要问宿主的那两件事） ────────────────────────────────────────

// 在当前系统环境中查找实际可用的 LaTeX 编译器。
export async function resolveLatexCompiler(input: {
  ctx: OfficeToolContext
  compiler?: LatexCompiler
}): Promise<Nullable<OfficeEnvironmentCommandAvailability>> {
  return findAvailableCommand(input.ctx, resolveLatexCompilerCandidates(input.compiler))
}

// 顺序执行 LaTeX 命令，遇到失败即停止，方便把失败点返回给调用方。
export async function runLatexCompileCommands(input: {
  ctx: OfficeToolContext
  commands: OfficeNativeCommand[]
  cwd: string
}): Promise<OfficeSystemCommandResult[]> {
  const results: OfficeSystemCommandResult[] = []
  for (const command of input.commands) {
    const result = await runOfficeSystemCommand(
      input.ctx,
      command,
      input.cwd,
      OfficeTuning.command.latexRunTimeoutMs
    )
    results.push(result)
    if (!result.success) break
  }
  return results
}
