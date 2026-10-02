/**
 * 办公文档能力（`velaros:office`）的操作：`OfficeOperations` 与整个进程唯一的 `officeOperations`。接口 `OfficeOperationsApi` 在本文件的类上方。
 * 一份实现挂在哪个空间都一样，空间之间的差别全在调用上下文里的端口 `OfficeSpacePort`（工作区根、跑外部命令）上。
 */

import type { OfficeOperationContext } from '../contract/requires.js'
import type {
  OfficeEditPdfInput,
  OfficeLatexCompiled,
  OfficeLatexInput,
  OfficeMarkdown,
  OfficeMarkdownInput,
  OfficePdfText,
  OfficePresentationInput,
  OfficePreview,
  OfficePreviewInput,
  OfficeReadPdfInput,
  OfficeSpreadsheetInput,
  OfficeWordInput,
  OfficeWordToPdfInput,
  OfficeWritten,
} from '../types/office.js'
import {
  editPdfInput,
  latexInput,
  markdownInput,
  presentationInput,
  previewInput,
  readPdfInput,
  spreadsheetInput,
  wordInput,
  wordToPdfInput,
} from '../utils/input.js'

import type { OfficeDocumentOperationsApi } from './operations/OfficeDocumentOperations.js'
import { officeDocumentOperations } from './operations/OfficeDocumentOperations.js'
import type { OfficeMarkdownOperationsApi } from './operations/OfficeMarkdownOperations.js'
import { officeMarkdownOperations } from './operations/OfficeMarkdownOperations.js'
import type { OfficePdfOperationsApi } from './operations/OfficePdfOperations.js'
import { officePdfOperations } from './operations/OfficePdfOperations.js'
import type { OfficePreviewOperationsApi } from './operations/OfficePreviewOperations.js'
import { officePreviewOperations } from './operations/OfficePreviewOperations.js'

/**
 * @AgentView
 * 办公文档：生成 Word、PowerPoint、Excel，读 PDF 的文字、编辑 PDF，Word 转 PDF、LaTeX 编译成 PDF，预览 Office 文档，把文档转成 Markdown。
 * 路径怎么写、能到哪儿由当前空间决定（环境报告里写着），出了空间的根一律拒绝；目标文件已经在时要传 overwrite: true 才覆盖。
 * 失败抛的错误带 code：OFFICE_OUTPUT_EXISTS 文件已在、OFFICE_INPUT_MISSING 输入文件不在、OFFICE_PATH_OUTSIDE_PROJECT 出了工作区根、
 * OFFICE_CONVERTER_MISSING 本机缺 LibreOffice 或 LaTeX 编译器（照 message 告诉用户，不要自己去装）、
 * OFFICE_CONVERSION_FAILED 外部转换失败（message 里有命令输出的结尾，LaTeX 就照着改源码再编）、OFFICE_MARKITDOWN_UNAVAILABLE 没装 MarkItDown。
 * 要把 PDF 变成 Word：readPdf 读出文字，再用 createWord 按页写成标题与段落。
 */
export interface OfficeOperationsApi {
  /** @AgentView 生成 Word 文档（.docx），或把新内容接在已有文档末尾。
   * @OperationEffect write
   */
  createWord(input: OfficeWordInput, ctx: OfficeOperationContext): Promise<OfficeWritten>
  /** @AgentView 生成 PowerPoint 演示文稿（.pptx）：给 Markdown 自动排版，或逐页给元素精细控制。
   * @OperationEffect write
   */
  createPresentation(
    input: OfficePresentationInput,
    ctx: OfficeOperationContext
  ): Promise<OfficeWritten>
  /** @AgentView 生成 Excel 工作簿（.xlsx）：给 CSV、Markdown 表格自动成表，或给结构化工作表（多表、公式、样式、合并、冻结）。
   * @OperationEffect write
   */
  createSpreadsheet(
    input: OfficeSpreadsheetInput,
    ctx: OfficeOperationContext
  ): Promise<OfficeWritten>
  /** @AgentView 按页读文本型 PDF 的可选择文字。
   * @OperationEffect none
   */
  readPdf(input: OfficeReadPdfInput, ctx: OfficeOperationContext): Promise<OfficePdfText>
  /** @AgentView 把 Word 文档转成 PDF，尽量保留排版（要本机装了 LibreOffice）。
   * @OperationEffect write
   */
  wordToPdf(input: OfficeWordToPdfInput, ctx: OfficeOperationContext): Promise<OfficeWritten>
  /** @AgentView 把 LaTeX 源码编译成 PDF：论文、数学公式、要求严格排版的文档；普通文档用 createWord 就好。
   * @OperationEffect write
   */
  latexToPdf(input: OfficeLatexInput, ctx: OfficeOperationContext): Promise<OfficeLatexCompiled>
  /** @AgentView 编辑 PDF 写成新文件：挑页、重排、删页、旋转、贴文字、改文档信息。
   * @OperationEffect write
   */
  editPdf(input: OfficeEditPdfInput, ctx: OfficeOperationContext): Promise<OfficeWritten>
  /** @AgentView 预览 Word、PowerPoint、Excel 文档的实际结构与正文；生成之后按产物路径调用可核对能否解析及实际数量。summary 是整份计数，条目受 maxItems 限制、正文另看 contentTruncated；结构解析不等于布局与全部业务内容通过。不给 outputPath 只读，也可以写出 HTML 或 PNG 预览给人看。
   * @OperationEffect write
   */
  preview(input: OfficePreviewInput, ctx: OfficeOperationContext): Promise<OfficePreview>
  /** @AgentView 用 MarkItDown 把 PDF、Office、HTML、CSV、JSON、EPub 这类文档转成 Markdown 来读（要装了 MarkItDown）。
   * @OperationEffect write
   */
  toMarkdown(input: OfficeMarkdownInput, ctx: OfficeOperationContext): Promise<OfficeMarkdown>
}

/** 顺序是固定的：先查取消、再核对入参、最后交给执行类——入参错了一步都不做。整个进程共用一份，无状态。 */
export class OfficeOperations implements OfficeOperationsApi {
  constructor(
    private readonly documents: OfficeDocumentOperationsApi,
    private readonly pdfs: OfficePdfOperationsApi,
    private readonly previews: OfficePreviewOperationsApi,
    private readonly markdown: OfficeMarkdownOperationsApi
  ) {}

  public async createWord(
    input: OfficeWordInput,
    ctx: OfficeOperationContext
  ): Promise<OfficeWritten> {
    ctx.abortSignal.throwIfAborted()
    return this.documents.createWord(wordInput(input), ctx)
  }

  public async createPresentation(
    input: OfficePresentationInput,
    ctx: OfficeOperationContext
  ): Promise<OfficeWritten> {
    ctx.abortSignal.throwIfAborted()
    return this.documents.createPresentation(presentationInput(input), ctx)
  }

  public async createSpreadsheet(
    input: OfficeSpreadsheetInput,
    ctx: OfficeOperationContext
  ): Promise<OfficeWritten> {
    ctx.abortSignal.throwIfAborted()
    return this.documents.createSpreadsheet(spreadsheetInput(input), ctx)
  }

  public async readPdf(
    input: OfficeReadPdfInput,
    ctx: OfficeOperationContext
  ): Promise<OfficePdfText> {
    ctx.abortSignal.throwIfAborted()
    return this.pdfs.readText(readPdfInput(input), ctx)
  }

  public async wordToPdf(
    input: OfficeWordToPdfInput,
    ctx: OfficeOperationContext
  ): Promise<OfficeWritten> {
    ctx.abortSignal.throwIfAborted()
    return this.pdfs.wordToPdf(wordToPdfInput(input), ctx)
  }

  public async latexToPdf(
    input: OfficeLatexInput,
    ctx: OfficeOperationContext
  ): Promise<OfficeLatexCompiled> {
    ctx.abortSignal.throwIfAborted()
    return this.pdfs.latexToPdf(latexInput(input), ctx)
  }

  public async editPdf(
    input: OfficeEditPdfInput,
    ctx: OfficeOperationContext
  ): Promise<OfficeWritten> {
    ctx.abortSignal.throwIfAborted()
    return this.pdfs.editPdf(editPdfInput(input), ctx)
  }

  public async preview(
    input: OfficePreviewInput,
    ctx: OfficeOperationContext
  ): Promise<OfficePreview> {
    ctx.abortSignal.throwIfAborted()
    const request = previewInput(input)
    // 不给 outputPath 只是读：这次调用对外界没有效果
    if (!request.outputPath) ctx.recordEffect?.('none')
    return this.previews.preview(request, ctx)
  }

  public async toMarkdown(
    input: OfficeMarkdownInput,
    ctx: OfficeOperationContext
  ): Promise<OfficeMarkdown> {
    ctx.abortSignal.throwIfAborted()
    const request = markdownInput(input)
    if (!request.outputPath) ctx.recordEffect?.('none')
    return this.markdown.toMarkdown(request, ctx)
  }
}

/** 整个进程只有一份的办公文档操作；空间把它挂在代码面的 `office` 命名空间上。 */
export const officeOperations: OfficeOperationsApi = new OfficeOperations(
  officeDocumentOperations,
  officePdfOperations,
  officePreviewOperations,
  officeMarkdownOperations
)
