/**
 * PDF 相关操作的执行者：`OfficePdfOperations` 与整个进程唯一的 `officePdfOperations`。
 * 接口 `OfficePdfOperationsApi` 在本文件的类上方。按页取文、Word 转 PDF、LaTeX 编译、PDF 编辑；
 * 外部命令都经 OfficeConverters，缺命令或命令失败时抛带 `OfficeErrorCodes` 的错误。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'

import { degrees, PDFDocument, StandardFonts } from 'pdf-lib'

import { OfficePdfLimits } from '../../contract/constants.js'
import type { OfficeOperationContext } from '../../contract/requires.js'
import type {
  OfficeEditPdfInput,
  OfficeLatexCompiled,
  OfficeLatexInput,
  OfficePdfText,
  OfficeReadPdfInput,
  OfficeWordToPdfInput,
  OfficeWritten,
} from '../../types/office.js'
import { conversionFailedError, converterMissingError, missingOutputError } from '../../utils/errors.js'
import { copyOfficeOutput, findGeneratedPdf, writeOfficeFile } from '../../utils/paths.js'
import { buildLatexCompileCommands, getDefaultLatexSourcePath } from '../../utils/pdf/latex.js'
import { applyPdfMetadata, applyPdfTextStamp, assertTextStampsEncodable, resolvePdfPageNumbers } from '../../utils/pdf/pages.js'
import { OfficeTuning } from '../../utils/tuning.js'
import { pdfjsRuntime, type PdfjsRuntimeApi } from '../runtime/PdfjsRuntime.js'

import type { OfficeConvertersApi } from './OfficeConverters.js'
import { officeConverters } from './OfficeConverters.js'
import type { OfficeWorkspaceApi } from './OfficeWorkspace.js'
import { officeWorkspace } from './OfficeWorkspace.js'

/**
 * PDF 相关操作的执行者。只读的按页取文不写任何东西，其余三个都写出新文件；
 * 缺 LibreOffice / LaTeX 编译器时抛 `converterMissing`，命令失败或没有产出时抛 `conversionFailed`。
 */
export interface OfficePdfOperationsApi {
  /** 按页提取文本型 PDF 的可选择文本；hasMore 表示还有没读的页。 */
  readText(input: OfficeReadPdfInput, ctx: OfficeOperationContext): Promise<OfficePdfText>
  /** 借本机 LibreOffice 把 .docx/.doc 转成 PDF。 */
  wordToPdf(input: OfficeWordToPdfInput, ctx: OfficeOperationContext): Promise<OfficeWritten>
  /** 把 LaTeX 源码写成 .tex 再编译成 PDF；编译失败时 .tex 留着，报错里带编译日志的结尾。 */
  latexToPdf(input: OfficeLatexInput, ctx: OfficeOperationContext): Promise<OfficeLatexCompiled>
  /** 选页、删页、旋转、贴文字戳、改元数据，输出成新的 PDF。 */
  editPdf(input: OfficeEditPdfInput, ctx: OfficeOperationContext): Promise<OfficeWritten>
}

export class OfficePdfOperations implements OfficePdfOperationsApi {
  /** 缺 LibreOffice 时说明它是干什么用的。 */
  private static readonly LibreOfficePurpose = 'Word 转 PDF 要用它的 headless 转换'

  /** 缺 LaTeX 编译器时说明它是干什么用的。 */
  private static readonly LatexPurpose = '把 LaTeX 源码编译成 PDF 要用它'

  constructor(
    private readonly workspace: OfficeWorkspaceApi,
    private readonly converters: OfficeConvertersApi,
    private readonly pdfjs: PdfjsRuntimeApi
  ) {}

  public async readText(input: OfficeReadPdfInput, ctx: OfficeOperationContext): Promise<OfficePdfText> {
    ctx.abortSignal.throwIfAborted()
    const path = await this.workspace.resolveInput(ctx, input.inputPath, ['.pdf'])
    const extracted = await this.pdfjs.extractTextPages(path, {
      pages: input.pages,
      maxPages: input.pages ? undefined : (input.maxPages ?? OfficePdfLimits.defaultReadPages),
    })
    return {
      path,
      pageCount: extracted.pageCount,
      pages: extracted.pages,
      hasMore: extracted.pages.length < extracted.pageCount,
    }
  }

  public async wordToPdf(input: OfficeWordToPdfInput, ctx: OfficeOperationContext): Promise<OfficeWritten> {
    ctx.abortSignal.throwIfAborted()
    // Word 转 PDF 依赖 LibreOffice 的 headless 转换能力；本机缺命令时不静默失败。
    const libreOffice = await this.converters.findLibreOffice(ctx)
    if (!libreOffice) throw converterMissingError('LibreOffice（soffice）', OfficePdfOperations.LibreOfficePurpose)

    // 输入支持 .doc/.docx；输出路径统一补 .pdf。
    const inputPath = await this.workspace.resolveInput(ctx, input.inputPath, ['.docx', '.doc'])
    const output = await this.workspace.prepareOutput(ctx, input.outputPath, '.pdf', input.overwrite)
    // 旧版 .doc 先转成临时 .docx；转换失败时转换器自己清掉临时目录再抛错。
    const normalizedWord = await this.converters.normalizeWordInput({
      ctx,
      inputPath,
      libreOffice,
      timeoutMs: OfficeTuning.command.libreOfficeTimeoutMs,
    })
    // 使用临时目录接收 LibreOffice 生成物，避免污染用户目录。
    const tempDir = await mkdtemp(join(tmpdir(), 'velaros-office-word-pdf-'))
    try {
      const normalizedInputPath = normalizedWord.path
      const commandResult = await this.converters.runLibreOffice(
        ctx,
        {
          file: libreOffice.path || libreOffice.name,
          args: ['--headless', '--convert-to', 'pdf', '--outdir', tempDir, normalizedInputPath],
        },
        dirname(normalizedInputPath),
        OfficeTuning.command.libreOfficeTimeoutMs
      )
      if (!commandResult.success) throw conversionFailedError('Word 转 PDF ', commandResult)
      // LibreOffice 会按原文件名生成 PDF，所以需要从临时目录中定位实际产物。
      const generatedPdf = await findGeneratedPdf(tempDir, `${basename(normalizedInputPath, extname(normalizedInputPath))}.pdf`)
      if (!generatedPdf) throw missingOutputError('Word 转 PDF ', 'PDF')
      return await copyOfficeOutput(output, generatedPdf)
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined /* arch-guard:silent-catch-ok 尽力清理临时目录，删除失败非致命 */)
      await this.converters.cleanupNormalizedWordInput(normalizedWord)
    }
  }

  public async latexToPdf(input: OfficeLatexInput, ctx: OfficeOperationContext): Promise<OfficeLatexCompiled> {
    ctx.abortSignal.throwIfAborted()
    // 根据指定或 auto 策略查找本机可用编译器。
    const compiler = await this.converters.findLatexCompiler(ctx, input.compiler)
    if (!compiler) {
      const requested = input.compiler && input.compiler !== 'auto' ? input.compiler : 'LaTeX 编译器（tectonic、latexmk、xelatex、pdflatex 都没有）'
      throw converterMissingError(requested, OfficePdfOperations.LatexPurpose)
    }

    const output = await this.workspace.prepareOutput(ctx, input.outputPath, '.pdf', input.overwrite)
    const source = await this.workspace.prepareOutput(
      ctx,
      input.sourcePath ?? getDefaultLatexSourcePath(input.outputPath),
      '.tex',
      input.overwrite
    )
    // 先把源码写到用户可见的位置；即使后续编译失败，也能保留可修复的 .tex 文件。
    await writeFile(source.path, input.latexSource, 'utf8')

    const tempDir = await mkdtemp(join(tmpdir(), 'velaros-office-latex-pdf-'))
    try {
      // 编译产物写入临时目录，成功后再复制到目标路径。
      const commandResults = await this.converters.runLatexCompile({
        ctx,
        commands: buildLatexCompileCommands({
          compiler,
          sourceFileName: basename(source.path),
          tempDir,
          runs: input.runs,
        }),
        cwd: dirname(source.path),
      })
      const lastResult = commandResults.at(-1)
      // 编译失败时 .tex 留着，报错里带编译日志的结尾，照着改源码再编。
      if (!lastResult) throw missingOutputError(`用 ${compiler.name} 编译 LaTeX `, 'PDF')
      if (!lastResult.success) throw conversionFailedError(`用 ${compiler.name} 编译 LaTeX `, lastResult, `；源码已写在 ${source.path}`)
      // 不同编译器都应在临时目录生成同名 PDF，这里统一查找。
      const generatedPdf = await findGeneratedPdf(tempDir, `${basename(source.path, extname(source.path))}.pdf`)
      if (!generatedPdf) throw missingOutputError(`用 ${compiler.name} 编译 LaTeX `, 'PDF')
      return { ...(await copyOfficeOutput(output, generatedPdf)), sourcePath: source.path, compiler: compiler.name }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined /* arch-guard:silent-catch-ok 尽力清理临时目录，删除失败非致命 */)
    }
  }

  public async editPdf(input: OfficeEditPdfInput, ctx: OfficeOperationContext): Promise<OfficeWritten> {
    ctx.abortSignal.throwIfAborted()
    const outputDocument = await PDFDocument.create()
    const font = await outputDocument.embedFont(StandardFonts.Helvetica)
    // 文字戳写不了的字先拒绝，路径都还没碰。
    assertTextStampsEncodable(input.textStamps ?? [], font.getCharacterSet())
    const inputPath = await this.workspace.resolveInput(ctx, input.inputPath, ['.pdf'])
    const output = await this.workspace.prepareOutput(ctx, input.outputPath, '.pdf', input.overwrite)
    const sourceDocument = await PDFDocument.load(await readFile(inputPath))
    // 先根据选择/删除规则确定要复制的源页码，再按顺序复制到新文档。
    const sourcePageNumbers = resolvePdfPageNumbers(sourceDocument.getPageCount(), input.pageSelection, input.removePages)
    const copiedPages = await outputDocument.copyPages(
      sourceDocument,
      sourcePageNumbers.map((page) => page - 1)
    )

    copiedPages.forEach((page) => outputDocument.addPage(page))
    // 元数据写在输出文档上，不改动原始 PDF。
    applyPdfMetadata(outputDocument, input.metadata)

    // 旋转配置按源页码索引，确保 pageSelection 重排后仍能命中原页。
    const rotateBySourcePage = new Map((input.rotatePages ?? []).map((entry) => [entry.page, entry.degrees] as const))

    outputDocument.getPages().forEach((page, index) => {
      const sourcePageNumber = sourcePageNumbers[index] ?? index + 1
      const rotation = rotateBySourcePage.get(sourcePageNumber)
      if (rotation) page.setRotation(degrees(rotation))
      for (const stamp of input.textStamps ?? []) {
        // 文字戳既可以作用到所有页，也可以按源 PDF 页码匹配到某一页。
        if (stamp.allPages || stamp.page === sourcePageNumber || (!stamp.page && !stamp.allPages)) {
          applyPdfTextStamp({ page, stamp, font })
        }
      }
    })

    // 保存新文档并走统一的写出回执。
    return writeOfficeFile(output, await outputDocument.save())
  }
}

/** 整个进程共用的 PDF 操作。 */
export const officePdfOperations: OfficePdfOperationsApi = new OfficePdfOperations(officeWorkspace, officeConverters, pdfjsRuntime)
