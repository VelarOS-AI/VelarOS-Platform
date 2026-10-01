/**
 * 预览操作的执行者：`OfficePreviewOperations` 与整个进程唯一的 `officePreviewOperations`。
 * 接口 `OfficePreviewOperationsApi` 在本文件的类上方。解析 docx/doc/pptx/xlsx 的结构，
 * 可选地把 HTML 或 PNG 预览写到工作区里；旧版 .doc 先借 LibreOffice 转成临时 .docx。
 */

import { extname } from 'node:path'

import { toNullable } from '@velaros-ai/core'

import { OfficeErrorCodes } from '../../contract/constants.js'
import type { OfficeOperationContext } from '../../contract/requires.js'
import type {
  NormalizedWordInput,
  OfficePreview,
  OfficePreviewInput,
  OfficePreviewWritten,
} from '../../types/office.js'
import type { OfficePreviewKind, ParsedOfficePreview } from '../../types/preview.js'
import { converterMissingError, officeError } from '../../utils/errors.js'
import { writeOfficeFile } from '../../utils/paths.js'
import { OfficeTuning } from '../../utils/tuning.js'
import type { OfficeDocumentRendererApi } from '../runtime/OfficeDocumentRenderer.js'
import { officeDocumentRenderer } from '../runtime/OfficeDocumentRenderer.js'

import type { OfficeConvertersApi } from './OfficeConverters.js'
import { officeConverters } from './OfficeConverters.js'
import type { OfficeWorkspaceApi } from './OfficeWorkspace.js'
import { officeWorkspace } from './OfficeWorkspace.js'

/** 预览操作的执行者：解析文档结构，按需写出给人看的 HTML 或 PNG。 */
export interface OfficePreviewOperationsApi {
  /** 解析一份 Office 文档并按需写出预览；交回标题、摘要、大纲/分页数据与截断过的正文 HTML。 */
  preview(input: OfficePreviewInput, ctx: OfficeOperationContext): Promise<OfficePreview>
}

export class OfficePreviewOperations implements OfficePreviewOperationsApi {
  /** 预览接受的输入扩展名。 */
  private static readonly InputExtensions = ['.docx', '.doc', '.pptx', '.xlsx']

  /** 缺 LibreOffice 时说明它是干什么用的。 */
  private static readonly LibreOfficePurpose = '预览旧版 .doc 要先用它转成 .docx'

  constructor(
    private readonly workspace: OfficeWorkspaceApi,
    private readonly converters: OfficeConvertersApi,
    private readonly renderer: OfficeDocumentRendererApi
  ) {}

  public async preview(
    input: OfficePreviewInput,
    ctx: OfficeOperationContext
  ): Promise<OfficePreview> {
    ctx.abortSignal.throwIfAborted()
    const inputPath = await this.workspace.resolveInput(
      ctx,
      input.inputPath,
      OfficePreviewOperations.InputExtensions
    )
    const normalized = await this.normalizeInput(ctx, inputPath)

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
      const preview: OfficePreview = {
        path: inputPath,
        kind: normalized.kind,
        title: parsed.title,
        summary: parsed.summary,
        outline: parsed.outline,
        slides: parsed.slides,
        sheets: parsed.sheets,
        contentHtml: parsed.htmlBody.slice(0, OfficeTuning.preview.contentHtmlChars),
        contentTruncated: parsed.htmlBody.length > OfficeTuning.preview.contentHtmlChars,
      }
      if (input.outputPath)
        preview.written = await this.writePreview(
          ctx,
          input.outputPath,
          html,
          parsed,
          input.overwrite
        )
      return preview
    } finally {
      if (normalized.wordInput)
        await this.converters.cleanupNormalizedWordInput(normalized.wordInput)
    }
  }

  /** 认出输入类型；旧版 .doc 先借 LibreOffice 转成临时 .docx 再解析。 */
  private async normalizeInput(
    ctx: OfficeOperationContext,
    inputPath: string
  ): Promise<{ path: string; kind: OfficePreviewKind; wordInput?: NormalizedWordInput }> {
    const extension = extname(inputPath).toLowerCase()
    switch (extension) {
      case '.pptx':
        return { path: inputPath, kind: 'pptx' }
      case '.xlsx':
        return { path: inputPath, kind: 'xlsx' }
      case '.docx':
        return {
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
    if (!libreOffice)
      throw converterMissingError(
        'LibreOffice（soffice）',
        OfficePreviewOperations.LibreOfficePurpose
      )
    // 转换失败时转换器自己清掉临时目录再抛错。
    const wordInput = await this.converters.normalizeWordInput({
      ctx,
      inputPath,
      libreOffice,
      timeoutMs: OfficeTuning.command.libreOfficeTimeoutMs,
    })
    return { path: wordInput.path, kind: 'docx', wordInput }
  }

  /** 把预览写到磁盘：.html 直接写 HTML，.png 先渲染成图片再写。 */
  private async writePreview(
    ctx: OfficeOperationContext,
    outputPath: string,
    html: string,
    parsed: ParsedOfficePreview,
    overwrite?: boolean
  ): Promise<OfficePreviewWritten> {
    const extension = extname(outputPath).toLowerCase() || '.html'
    if (extension !== '.html' && extension !== '.png') {
      throw officeError(
        OfficeErrorCodes.invalidExtension,
        `预览文件的扩展名要是 .html 或 .png：${outputPath}`
      )
    }
    const prepared = await this.workspace.prepareOutput(ctx, outputPath, extension, overwrite)
    if (extension === '.html') return writeOfficeFile(prepared, html, ctx.abortSignal)
    const image = await this.renderer.renderPreviewPng(parsed)
    return {
      ...(await writeOfficeFile(prepared, image.buffer, ctx.abortSignal)),
      width: image.width,
      height: image.height,
    }
  }
}

/** 整个进程共用的预览操作。 */
export const officePreviewOperations: OfficePreviewOperationsApi = new OfficePreviewOperations(
  officeWorkspace,
  officeConverters,
  officeDocumentRenderer
)
