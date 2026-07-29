/**
 * 文档解析与预览工具。
 *
 * `Word` 预览委托给 `mammoth` 生成语义化 `HTML`，演示文稿和表格则读取底层结构，
 * 生成摘要供模型与浏览器预览使用。
 */

import { toNullable } from '@velaros-ai/core'

import {
  buildWorkspaceMutationSkippedResult,
  cleanupNormalizedWordInput,
  defineOfficeTool,
  OfficeDocumentProcessCapability,
  type OfficeToolContext,
  resolveOfficeInputPathWithExtensions,
  runWithDirectory,
  toolRequiresWorkspace,
} from './officeShared'
import type { PreviewOfficeDocumentInput } from './previewTool'
import { buildOfficePreviewHtml, normalizePreviewInput, parseOfficePreview, previewOfficeDocumentSchema, writePreviewHtml } from './previewTool'

const previewOfficeDocument = defineOfficeTool<PreviewOfficeDocumentInput>({
  name: 'preview_office_document',
  role: 'render',
  summary: '解析 Office 文档并可生成 HTML 预览。',
  suitable: ['需要检查生成后的 Word、PowerPoint 或 Excel 文档结构和摘要。'],
  forbidden: ['不要用它编辑文档内容。'],
  usage: ['传 inputPath；需要浏览器预览时传 outputPath。'],
  examples: [{ inputPath: "report.docx", outputPath: "preview.html" }],
  notes: ['.doc 会先临时转为 .docx 后解析。'],
  schema: previewOfficeDocumentSchema,
  permissions: ['fs:read', 'fs:write', 'process:exec'],
  capabilities: OfficeDocumentProcessCapability,
  isAvailable: toolRequiresWorkspace,
  isConcurrencySafe: (input) => !input.outputPath,
  execute: async (input: PreviewOfficeDocumentInput, ctx: OfficeToolContext) => {
    ctx.abortSignal.throwIfAborted()

    if (input.outputPath) {
      const authorization = await ctx.workspace.prepareMutationWorkspace({
        cwd: input.cwd,
        operation: '生成 Office HTML 预览',
        targetPath: input.outputPath,
      })
      if (!authorization.approved) return buildWorkspaceMutationSkippedResult(authorization)
    }

    return runWithDirectory(ctx, input.cwd, async () => {
      const inputPath = await resolveOfficeInputPathWithExtensions(ctx, input.inputPath, [
        '.docx',
        '.doc',
        '.pptx',
        '.xlsx',
      ])
      const normalized = await normalizePreviewInput(ctx, inputPath)
      if (!normalized.success) return normalized.result

      try {
        const parsed = await parseOfficePreview(
          normalized.path,
          normalized.kind,
          input.maxItems ?? 80
        )
        const html = buildOfficePreviewHtml({
          parsed,
          inputPath,
          normalizedInput: toNullable(normalized.wordInput),
          autoRefresh: input.autoRefresh ?? true,
        })
        const output = input.outputPath
          ? await writePreviewHtml(ctx, input.outputPath, html, input.overwrite)
          : null

        return {
          changed: !!output?.changed,
          inputPath,
          kind: normalized.kind,
          normalizedInput: normalized.wordInput
            ? {
                originalPath: normalized.wordInput.originalPath,
                sourceExtension: normalized.wordInput.sourceExtension,
                convertedFromLegacyDoc: normalized.wordInput.convertedFromLegacyDoc,
                intermediateFormat: 'docx',
                converter: toNullable(normalized.wordInput.converter),
              }
            : null,
          preview: {
            title: parsed.title,
            summary: parsed.summary,
            outline: parsed.outline,
            slides: parsed.slides,
            sheets: parsed.sheets,
            messages: parsed.messages,
          },
          htmlPreview: output,
        }
      } finally {
        if (normalized.wordInput) await cleanupNormalizedWordInput(normalized.wordInput)
      }
    })
  },
})
const previewTools = {
  preview_office_document: previewOfficeDocument,
}

export { previewTools }
