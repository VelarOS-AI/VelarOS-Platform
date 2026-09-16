/**
 * 预览工具的执行者：`OfficePreviewOperations` 与整个进程唯一的 `officePreviewOperations`。
 * 接口 `OfficePreviewOperationsApi` 在本文件的类上方。解析 docx/doc/pptx/xlsx 的结构，
 * 可选地把 HTML 或 PNG 预览写到工作区里；旧版 .doc 先借 LibreOffice 转成临时 .docx。
 */

import { rm, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'

import { toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { OfficeToolContext } from '../../contract/requires.js'
import type { PreviewOfficeDocumentInput } from '../../types/inputs.js'
import type { NormalizedWordInput } from '../../types/office.js'
import type {
  OfficePreviewArtifact,
  OfficePreviewKind,
  ParsedOfficePreview,
} from '../../types/preview.js'
import { getFileStats } from '../../utils/paths.js'
import { createCommandFailureResult } from '../../utils/results.js'
import { OfficeTuning } from '../../utils/tuning.js'
import type { OfficeDocumentRendererApi } from '../runtime/OfficeDocumentRenderer.js'
import { officeDocumentRenderer } from '../runtime/OfficeDocumentRenderer.js'

import type { OfficeConvertersApi } from './OfficeConverters.js'
import { officeConverters } from './OfficeConverters.js'
import type { OfficeWorkspaceApi } from './OfficeWorkspace.js'
import { officeWorkspace } from './OfficeWorkspace.js'

/**
 * 预览工具的执行者：解析文档结构、生成给人看的 HTML 或 PNG。
 * 只读解析不申请授权；要写预览文件时先过工作区授权，被拒就只返回解析结果之外的跳过结构。
 */
export interface OfficePreviewOperationsApi {
  /** 解析一份 Office 文档并按需写出预览；返回标题、摘要、大纲/分页数据与截断过的正文 HTML。 */
  preview(input: PreviewOfficeDocumentInput, ctx: OfficeToolContext): Promise<unknown>
}

export class OfficePreviewOperations implements OfficePreviewOperationsApi {
  /** 预览接受的输入扩展名。 */
  private static readonly InputExtensions = ['.docx', '.doc', '.pptx', '.xlsx']

  /** 缺 LibreOffice、无法预览旧版 .doc 时给宿主安装卡的原因与提示。 */
  private static readonly LibreOfficeMissing = {
    reason: '需要使用 LibreOffice headless 将旧版 .doc 转换为 .docx 后再解析预览。',
    message: '当前 shell 未找到 soffice/libreoffice，暂时无法预览旧版 .doc 文档。',
  }

  constructor(
    private readonly workspace: OfficeWorkspaceApi,
    private readonly converters: OfficeConvertersApi,
    private readonly renderer: OfficeDocumentRendererApi
  ) {}

  public async preview(
    input: PreviewOfficeDocumentInput,
    ctx: OfficeToolContext
  ): Promise<unknown> {
    ctx.abortSignal.throwIfAborted()

    if (input.outputPath) {
      const denied = await this.workspace.authorizeMutation(ctx, {
        operation: '生成 Office 预览',
        targetPath: input.outputPath,
      })
      if (denied) return denied
    }

    const inputPath = await this.workspace.resolveInput(
      ctx,
      input.inputPath,
      OfficePreviewOperations.InputExtensions
    )
    const normalized = await this.normalizeInput(ctx, inputPath)
    if (!normalized.success) return normalized.result

    try {
      const parsed = await this.renderer.parsePreview(
        normalized.path,
        normalized.kind,
        input.maxItems ?? OfficeTuning.preview.items
      )
      const html = this.renderer.buildPreviewHtml({
        parsed,
        inputPath,
        normalizedInput: toNullable(normalized.wordInput),
        // 缺省不塞自动刷新脚本：它会往用户自己的 HTML 文件里写一段定时 reload。
        autoRefresh: !!input.autoRefresh,
      })
      const output = input.outputPath
        ? await this.writePreview(ctx, input.outputPath, html, parsed, input.overwrite)
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
          contentHtml: parsed.htmlBody.slice(0, OfficeTuning.preview.contentHtmlChars),
          contentTruncated: parsed.htmlBody.length > OfficeTuning.preview.contentHtmlChars,
        },
        previewArtifact: output,
      }
    } finally {
      if (normalized.wordInput) await this.converters.cleanupNormalizedWordInput(normalized.wordInput)
    }
  }

  /** 认出输入类型；旧版 .doc 先借 LibreOffice 转成临时 .docx 再解析。 */
  private async normalizeInput(
    ctx: OfficeToolContext,
    inputPath: string
  ): Promise<
    | { success: true; path: string; kind: OfficePreviewKind; wordInput?: NormalizedWordInput }
    | { success: false; result: Record<string, unknown> }
  > {
    const extension = extname(inputPath).toLowerCase()
    switch (extension) {
      case '.pptx':
        return { success: true, path: inputPath, kind: 'pptx' }
      case '.xlsx':
        return { success: true, path: inputPath, kind: 'xlsx' }
      case '.docx':
        return {
          success: true,
          path: inputPath,
          kind: 'docx',
          wordInput: {
            path: inputPath,
            originalPath: inputPath,
            sourceExtension: '.docx',
            convertedFromLegacyDoc: false,
            tempDir: null,
          },
        }
    }

    const libreOffice = await this.converters.findLibreOffice(ctx)
    if (!libreOffice) return {
        success: false,
        result: this.converters.missingToolResult({
          command: 'soffice',
          reason: OfficePreviewOperations.LibreOfficeMissing.reason,
          message: OfficePreviewOperations.LibreOfficeMissing.message,
        }),
      }

    const normalized = await this.converters.normalizeWordInput({
      ctx,
      inputPath,
      libreOffice,
      timeoutMs: OfficeTuning.command.libreOfficeTimeoutMs,
    })
    if (!normalized.success) {
      if (normalized.tempDir) {
        await rm(normalized.tempDir, { recursive: true, force: true }).catch(() => undefined /* arch-guard:silent-catch-ok 尽力清理临时目录，删除失败非致命 */)
      }
      return {
        success: false,
        result: createCommandFailureResult({
          outputPath: inputPath,
          kind: 'docx',
          operation: 'DOC 转 DOCX 预处理',
          commandResult: normalized.commandResult,
        }),
      }
    }

    return { success: true, path: normalized.input.path, kind: 'docx', wordInput: normalized.input }
  }

  /** 把预览写到磁盘：.html 直接写 HTML，.png 先渲染成图片再写。 */
  private async writePreview(
    ctx: OfficeToolContext,
    outputPath: string,
    html: string,
    parsed: ParsedOfficePreview,
    overwrite?: boolean
  ): Promise<OfficePreviewArtifact> {
    const requestedExtension = extname(outputPath).toLowerCase()
    const extension = requestedExtension || '.html'
    if (extension !== '.html' && extension !== '.png') {
      throw new AppError('VALIDATION', 'Office 预览输出文件扩展名必须是 .html 或 .png。')
    }
    const prepared = await this.workspace.prepareOutput(ctx, outputPath, extension, overwrite)
    const image = extension === '.png' ? await this.renderer.renderPreviewPng(parsed) : null
    if (image) await writeFile(prepared.path, image.buffer)
    else await writeFile(prepared.path, html, 'utf8')
    const stats = await getFileStats(prepared.path)
    const artifact: OfficePreviewArtifact = {
      path: prepared.path,
      bytes: stats ? Number(stats.size) : (image?.buffer.byteLength ?? Buffer.byteLength(html)),
      created: prepared.created,
      changed: true,
      kind: extension === '.png' ? 'png' : 'html',
    }
    if (image) {
      artifact.width = image.width
      artifact.height = image.height
    }
    return artifact
  }
}

/** 整个进程共用的预览操作。 */
export const officePreviewOperations: OfficePreviewOperationsApi = new OfficePreviewOperations(
  officeWorkspace,
  officeConverters,
  officeDocumentRenderer
)
