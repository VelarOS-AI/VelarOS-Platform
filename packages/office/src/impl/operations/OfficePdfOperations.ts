/**
 * 五个 PDF 工具的执行者：`OfficePdfOperations` 与整个进程唯一的 `officePdfOperations`。
 * 接口 `OfficePdfOperationsApi` 在本文件的类上方。按页取文、PDF 转 Word、Word 转 PDF、
 * LaTeX 编译、PDF 编辑；凡是要写盘的都先过工作区授权，外部命令都经 OfficeConverters。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'

// docx 必须与 Word 生成链路同一种导入方式（静态）：曾用动态 import('docx') 拿 Document/Packer，
// 在 packages:'external' 构建下解析到 ESM 副本，与 buildWordChildren 产的 CJS 实例原型不匹配，
// Packer 把段落序列化成 <rootKey> 垃圾——PDF 转 Word 静默产出空文档（真机取证）。
import { Document, Packer } from 'docx'
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib'

import { toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { OfficePdfLimits } from '../../contract/constants.js'
import type { OfficeToolContext } from '../../contract/requires.js'
import type {
  ConvertPdfToWordInput,
  ConvertWordToPdfInput,
  CreateLatexPdfInput,
  EditPdfDocumentInput,
  ExtractPdfTextInput,
} from '../../types/inputs.js'
import { copyOfficeOutput, findGeneratedPdf, writeOfficeBuffer } from '../../utils/paths.js'
import { buildLatexCompileCommands, getDefaultLatexSourcePath } from '../../utils/pdf/latex.js'
import { applyPdfMetadata, applyPdfTextStamp, resolvePdfPageNumbers } from '../../utils/pdf/pages.js'
import { createCommandFailureResult } from '../../utils/results.js'
import { OfficeTuning } from '../../utils/tuning.js'
import { buildWordChildren } from '../../utils/word/docx.js'
import { pdfjsRuntime, type PdfjsRuntimeApi } from '../runtime/PdfjsRuntime.js'

import type { OfficeConvertersApi } from './OfficeConverters.js'
import { officeConverters } from './OfficeConverters.js'
import type { OfficeWorkspaceApi } from './OfficeWorkspace.js'
import { officeWorkspace } from './OfficeWorkspace.js'

/**
 * 五个 PDF 工具的执行者。只读的按页取文不申请授权，其余四个都会写出新文件，一律先过工作区授权；
 * 缺 LibreOffice / LaTeX 编译器时返回带安装建议的结构化跳过结果，不抛通用执行错误。
 */
export interface OfficePdfOperationsApi {
  /** 按页提取文本型 PDF 的可选择文本；hasMore 表示还有没读的页。 */
  extractText(input: ExtractPdfTextInput, ctx: OfficeToolContext): Promise<unknown>
  /** 把 PDF 的可提取文本按页写成 .docx。 */
  convertPdfToWord(input: ConvertPdfToWordInput, ctx: OfficeToolContext): Promise<unknown>
  /** 借本机 LibreOffice 把 .docx/.doc 转成 PDF。 */
  convertWordToPdf(input: ConvertWordToPdfInput, ctx: OfficeToolContext): Promise<unknown>
  /** 把 LaTeX 源码写成 .tex 再编译成 PDF；编译失败时保留 .tex 并带回每轮命令输出。 */
  createLatexPdf(input: CreateLatexPdfInput, ctx: OfficeToolContext): Promise<unknown>
  /** 选页、删页、旋转、贴文字戳、改元数据，输出成新的 PDF。 */
  editPdf(input: EditPdfDocumentInput, ctx: OfficeToolContext): Promise<unknown>
}

export class OfficePdfOperations implements OfficePdfOperationsApi {
  /** 缺 LibreOffice 时给宿主安装卡的原因与提示。 */
  private static readonly LibreOfficeMissing = {
    reason: '需要使用 LibreOffice headless 将 Word 文档转换为 PDF。',
    message: '当前 shell 未找到 soffice/libreoffice，暂时无法执行 Word 转 PDF。',
  }

  /** 缺 LaTeX 编译器时给宿主安装卡的原因与提示。 */
  private static readonly LatexMissing = {
    reason: '需要 LaTeX 编译器将模型编写的 .tex 源码转换为 PDF。',
    message: '当前 shell 未找到可用的 LaTeX 编译器，暂时无法生成 PDF。',
  }

  constructor(
    private readonly workspace: OfficeWorkspaceApi,
    private readonly converters: OfficeConvertersApi,
    private readonly pdfjs: PdfjsRuntimeApi
  ) {}

  public async extractText(input: ExtractPdfTextInput, ctx: OfficeToolContext): Promise<unknown> {
    ctx.abortSignal.throwIfAborted()
    const inputPath = await this.workspace.resolveInput(ctx, input.inputPath, ['.pdf'])
    const extracted = await this.pdfjs.extractTextPages(inputPath, {
      pages: input.pages,
      maxPages: input.pages ? undefined : (input.maxPages ?? OfficePdfLimits.defaultReadPages),
    })
    return {
      inputPath,
      pageCount: extracted.pageCount,
      pages: extracted.pages,
      hasMore: extracted.pages.length < extracted.pageCount,
    }
  }

  public async convertPdfToWord(
    input: ConvertPdfToWordInput,
    ctx: OfficeToolContext
  ): Promise<unknown> {
    ctx.abortSignal.throwIfAborted()
    // 生成 docx 属于写操作，先让宿主做权限/路径确认。
    const denied = await this.workspace.authorizeMutation(ctx, {
      operation: 'PDF 转 Word',
      targetPath: input.outputPath,
    })
    if (denied) return denied

    const inputPath = await this.workspace.resolveInput(ctx, input.inputPath, ['.pdf'])
    const output = await this.workspace.prepareOutput(ctx, input.outputPath, '.docx', input.overwrite)
    // 先把 PDF 中可提取文本按页读出，再映射成 Word 段落块。
    const { pages } = await this.pdfjs.extractTextPages(inputPath, { maxPages: input.maxPages })
    const blocks = pages.flatMap((page) => [
      { kind: 'heading' as const, text: `第 ${page.page} 页`, level: 2 as const },
      {
        kind: 'paragraph' as const,
        text: page.text || '（本页没有可提取的文本。）',
        spaceAfter: 180,
      },
    ])

    // 复用 Word 生成链路的 block -> docx children 逻辑，保持输出样式一致。
    const document = new Document({
      title: input.title ?? `由 ${input.inputPath} 转换`,
      creator: input.author ?? '',
      sections: [{ children: buildWordChildren({ title: input.title, blocks }) }],
    })
    const buffer = await Packer.toBuffer(document)
    return writeOfficeBuffer(output, buffer, 'docx')
  }

  public async convertWordToPdf(
    input: ConvertWordToPdfInput,
    ctx: OfficeToolContext
  ): Promise<unknown> {
    ctx.abortSignal.throwIfAborted()
    // 转换会写出新 PDF，先走工作区授权。
    const denied = await this.workspace.authorizeMutation(ctx, {
      operation: 'Word 转 PDF',
      targetPath: input.outputPath,
    })
    if (denied) return denied

    // Word 转 PDF 依赖 LibreOffice 的 headless 转换能力。
    const libreOffice = await this.converters.findLibreOffice(ctx)
    // 本机缺少命令时不静默失败，返回明确安装建议和线上替代方案。
    if (!libreOffice) return this.converters.missingToolResult({
        command: 'soffice',
        reason: OfficePdfOperations.LibreOfficeMissing.reason,
        message: OfficePdfOperations.LibreOfficeMissing.message,
      })

    // 输入支持 .doc/.docx 自动补全；输出路径统一补 .pdf。
    const inputPath = await this.workspace.resolveInput(ctx, input.inputPath, ['.docx', '.doc'])
    const output = await this.workspace.prepareOutput(ctx, input.outputPath, '.pdf', input.overwrite)
    const normalizedWord = await this.converters.normalizeWordInput({
      ctx,
      inputPath,
      libreOffice,
      timeoutMs: OfficeTuning.command.libreOfficeTimeoutMs,
    })
    if (!normalizedWord.success) {
      if (normalizedWord.tempDir) {
        await rm(normalizedWord.tempDir, { recursive: true, force: true }).catch(() => undefined /* arch-guard:silent-catch-ok 尽力清理临时目录，删除失败非致命 */)
      }
      return createCommandFailureResult({
        outputPath: output.path,
        kind: 'pdf',
        operation: 'DOC 转 DOCX 预处理',
        commandResult: normalizedWord.commandResult,
      })
    }
    // 使用临时目录接收 LibreOffice 生成物，避免污染用户目录。
    const tempDir = await mkdtemp(join(tmpdir(), 'velaros-office-word-pdf-'))
    try {
      const normalizedInputPath = normalizedWord.input.path
      const commandResult = await this.converters.runLibreOffice(
        ctx,
        {
          file: libreOffice.path || libreOffice.name,
          args: ['--headless', '--convert-to', 'pdf', '--outdir', tempDir, normalizedInputPath],
        },
        dirname(normalizedInputPath),
        OfficeTuning.command.libreOfficeTimeoutMs
      )
      if (!commandResult.success)
        return createCommandFailureResult({
          outputPath: output.path,
          kind: 'pdf',
          operation: 'Word 转 PDF',
          commandResult,
        })
      // LibreOffice 会按原文件名生成 PDF，所以需要从临时目录中定位实际产物。
      const generatedPdf = await findGeneratedPdf(
        tempDir,
        `${basename(normalizedInputPath, extname(normalizedInputPath))}.pdf`
      )
      if (!generatedPdf)
        throw new AppError('EXECUTION_FAILED', 'Word 转 PDF 命令已结束，但没有生成 PDF 文件。')
      return {
        ...(await copyOfficeOutput(output, generatedPdf, 'pdf')),
        converter: libreOffice.name,
        normalizedInput: {
          originalPath: normalizedWord.input.originalPath,
          sourceExtension: normalizedWord.input.sourceExtension,
          convertedFromLegacyDoc: normalizedWord.input.convertedFromLegacyDoc,
          intermediateFormat: 'docx',
          converter: toNullable(normalizedWord.input.converter),
        },
        legacyConversionCommandResult: toNullable(normalizedWord.input.conversionCommandResult),
        commandResult,
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined /* arch-guard:silent-catch-ok 尽力清理临时目录，删除失败非致命 */)
      await this.converters.cleanupNormalizedWordInput(normalizedWord.input)
    }
  }

  public async createLatexPdf(
    input: CreateLatexPdfInput,
    ctx: OfficeToolContext
  ): Promise<unknown> {
    ctx.abortSignal.throwIfAborted()
    // LaTeX 工具至少会写入 .tex，编译成功时还会写入 PDF，因此先请求写权限。
    const denied = await this.workspace.authorizeMutation(ctx, {
      operation: 'LaTeX 生成 PDF',
      targetPath: input.outputPath,
    })
    if (denied) return denied

    // 根据用户指定或 auto 策略查找本机可用编译器。
    const compiler = await this.converters.findLatexCompiler(ctx, input.compiler)
    if (!compiler) {
      const requestedCommand =
        input.compiler && input.compiler !== 'auto' ? input.compiler : 'tectonic'
      // 没有编译器时返回结构化缺失工具结果，包含可执行的替代方案描述。
      return this.converters.missingToolResult({
        command: requestedCommand,
        reason: OfficePdfOperations.LatexMissing.reason,
        message: OfficePdfOperations.LatexMissing.message,
      })
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
      if (!lastResult?.success) {
        // 编译失败时报告结果，但不删除已写出的源码，方便用户继续排查。
        return {
          changed: true,
          pdfCreated: false,
          kind: 'pdf',
          sourcePath: source.path,
          outputPath: output.path,
          compiler: compiler.name,
          commandResults,
          message:
            'LaTeX 源码已写入，但 PDF 编译失败；请查看 stdout/stderr 后修正源码或换用编译器。',
        }
      }
      // 不同编译器都应在临时目录生成同名 PDF，这里统一查找。
      const generatedPdf = await findGeneratedPdf(
        tempDir,
        `${basename(source.path, extname(source.path))}.pdf`
      )
      if (!generatedPdf)
        throw new AppError('EXECUTION_FAILED', 'LaTeX 编译命令已结束，但没有生成 PDF 文件。')
      return {
        ...(await copyOfficeOutput(output, generatedPdf, 'pdf')),
        sourcePath: source.path,
        sourceCreated: source.created,
        compiler: compiler.name,
        commandResults,
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined /* arch-guard:silent-catch-ok 尽力清理临时目录，删除失败非致命 */)
    }
  }

  public async editPdf(input: EditPdfDocumentInput, ctx: OfficeToolContext): Promise<unknown> {
    ctx.abortSignal.throwIfAborted()
    // 编辑 PDF 会创建新的输出文件，先进行工作区写入授权。
    const denied = await this.workspace.authorizeMutation(ctx, {
      operation: '编辑 PDF',
      targetPath: input.outputPath,
    })
    if (denied) return denied

    const inputPath = await this.workspace.resolveInput(ctx, input.inputPath, ['.pdf'])
    const output = await this.workspace.prepareOutput(ctx, input.outputPath, '.pdf', input.overwrite)
    const sourceDocument = await PDFDocument.load(await readFile(inputPath))
    const outputDocument = await PDFDocument.create()
    // 先根据选择/删除规则确定要复制的源页码，再按顺序复制到新文档。
    const sourcePageNumbers = resolvePdfPageNumbers(
      sourceDocument.getPageCount(),
      input.pageSelection,
      input.removePages
    )
    const copiedPages = await outputDocument.copyPages(
      sourceDocument,
      sourcePageNumbers.map((page) => page - 1)
    )

    copiedPages.forEach((page) => outputDocument.addPage(page))
    // 元数据写在输出文档上，不改动原始 PDF。
    applyPdfMetadata(outputDocument, input.metadata)

    // 旋转配置按源页码索引，确保 pageSelection 重排后仍能命中原页。
    const rotateBySourcePage = new Map(
      (input.rotatePages ?? []).map((entry) => [entry.page, entry.degrees] as const)
    )
    const font = await outputDocument.embedFont(StandardFonts.Helvetica)

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

    // 保存新文档并走统一的 Office 文件写入返回结构。
    const buffer = await outputDocument.save()
    return writeOfficeBuffer(output, Buffer.from(buffer), 'pdf')
  }
}

/** 整个进程共用的 PDF 操作。 */
export const officePdfOperations: OfficePdfOperationsApi = new OfficePdfOperations(
  officeWorkspace,
  officeConverters,
  pdfjsRuntime
)
