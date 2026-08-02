/**
 * wordTool.ts
 *
 * Word (.docx) 文档生成工具。
 * 依赖：officeShared（共享类型 + 路径辅助）
 */

import {
  Document,
  Packer,
} from 'docx'
import { type z } from 'zod'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  buildProjectMutationSkippedResult,
  defineOfficeTool,
  OfficeDocumentWriteCapability,
  type OfficeToolContext,
  runWithDirectory,
  toolRequiresProject,
  writeOfficeBuffer,
} from './officeShared'
import type { CreateWordDocumentInput } from './wordTool'
import { appendWordDocumentBuffer, buildWordChildren, buildWordDocument, createWordDocumentGuidedSchema, createWordDocumentPresetSchema, createWordDocumentSchema, normalizeCreateWordDocumentGuided, normalizeCreateWordDocumentPreset, normalizeWordBlocks, prepareWordDocumentOutputPath } from './wordTool'

// ─── Tool definition ────────────────────────────────────────────────────────────

const createWordDocument = defineOfficeTool<CreateWordDocumentInput>({
  name: 'office:create_word_document',
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
      normalize: normalizeCreateWordDocumentPreset,
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
      normalize: normalizeCreateWordDocumentGuided,
    },
  },
  permissions: ['fs:read', 'fs:write'],
  capabilities: OfficeDocumentWriteCapability,
  isAvailable: toolRequiresProject,
  isConcurrencySafe: () => false,
  execute: async (input: CreateWordDocumentInput, ctx: OfficeToolContext) => {
    const blocks = normalizeWordBlocks(input)
    if (isEmpty(blocks))
      throw new AppError(
        'VALIDATION',
        'office:create_word_document: blocks/content 为空或缺失。请传入结构化 blocks 数组，或传入 Markdown/纯文本字符串。'
      )
    ctx.abortSignal.throwIfAborted()
    // Office 产物写入前统一请求工作区 mutation 授权。
    const authorization = await ctx.office.project.prepareMutation({
      cwd: input.cwd,
      operation: '生成 Word 文档',
      targetPath: input.outputPath,
    })
    if (!authorization.approved) return buildProjectMutationSkippedResult(authorization)

    return runWithDirectory(ctx, input.cwd, async () => {
      const output = await prepareWordDocumentOutputPath(ctx, input)
      if (output.append) {
        // append 模式先生成临时 fragment docx，再把 XML body 合并进原文档。
        const fragmentDocument = new Document({
          title: input.title,
          creator: input.author ?? 'VelarOS',
          sections: [{ children: buildWordChildren({ blocks }) }],
        })
        const fragmentBuffer = await Packer.toBuffer(fragmentDocument)
        return appendWordDocumentBuffer(output, fragmentBuffer)
      }
      // 新建模式直接构建完整 document。
      const document = buildWordDocument({ ...input, blocks })
      const buffer = await Packer.toBuffer(document)
      return writeOfficeBuffer(output, buffer, 'docx')
    })
  },
})
const wordTools = {
  'office:create_word_document': createWordDocument,
}

export { wordTools }
