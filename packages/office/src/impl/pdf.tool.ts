/**
 * PDF 工具集合：
 *
 *   - `convertWordToPdf`：`Word` 转 `PDF`（依赖 `LibreOffice`）
 *   - `convertPdfToWord`：提取 `PDF` 文本并生成 `Word`
 *   - `createLatexPdf`：编译 `LaTeX` 源码生成 `PDF`
 *   - `editPdfDocument`：处理 `PDF` 页面、文字水印和元数据
 *
 * 依赖：`officeShared`，提供共享类型、路径处理和系统辅助能力。
 */
import { readFile } from 'node:fs/promises'

// docx 必须与 wordTool 同一种导入方式（静态）:曾用动态 import('docx') 拿 Document/Packer,
// 在 packages:'external' 构建下解析到 ESM 副本,与 buildWordChildren 产的 CJS 实例原型不匹配,
// Packer 把段落序列化成 <rootKey> 垃圾——PDF 转 Word 静默产出空文档(真机取证)。
import { Document, Packer } from 'docx'
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib'

import { toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  basename,
  buildMissingSystemToolResult,
  buildProjectMutationSkippedResult,
  cleanupNormalizedWordInput,
  copyOfficeOutput,
  createBrowserOnlineAlternative,
  createCommandFailureResult,
  defineOfficeTool,
  dirname,
  extname,
  findGeneratedPdf,
  join,
  mkdtemp,
  normalizeWordInputToDocx,
  OfficeDocumentProcessCapability,
  OfficeDocumentReadCapability,
  OfficeDocumentWriteCapability,
  type OfficeToolContext,
  prepareOfficeOutputPath,
  resolveLibreOfficeCommand,
  resolveOfficeInputPath,
  resolveOfficeInputPathWithExtensions,
  rm,
  runLibreOfficeSystemCommand,
  runWithDirectory,
  tmpdir,
  toolRequiresProject,
  writeFile,
  writeOfficeBuffer,
} from './officeShared'
import type { ConvertPdfToWordInput, ConvertWordToPdfInput, CreateLatexPdfInput, EditPdfDocumentInput, ExtractPdfTextInput } from './pdfTools'
import { applyPdfMetadata, applyPdfTextStamp, buildLatexCompileCommands, convertPdfToWordSchema, convertWordToPdfSchema, createLatexPdfSchema, editPdfDocumentSchema, extractPdfTextPages, extractPdfTextSchema, getDefaultLatexSourcePath, resolveLatexCompiler, resolvePdfPageNumbers, runLatexCompileCommands } from './pdfTools'
import { buildWordChildren } from './wordTool'

// ─── Tool: convertWordToPdf ────────────────────────────────────────────────────

const convertWordToPdf = defineOfficeTool<ConvertWordToPdfInput>({
  name: 'office:convert_word_to_pdf',
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
  isAvailable: toolRequiresProject,
  isConcurrencySafe: () => false,
  execute: async (input: ConvertWordToPdfInput, ctx: OfficeToolContext) => {
    ctx.abortSignal.throwIfAborted()
    // 转换会写出新 PDF，先走工作区授权。
    const authorization = await ctx.office.project.prepareMutation({
      cwd: input.cwd,
      operation: 'Word 转 PDF',
      targetPath: input.outputPath,
    })
    if (!authorization.approved) return buildProjectMutationSkippedResult(authorization)

    return runWithDirectory(ctx, input.cwd, async () => {
      // Word 转 PDF 依赖 LibreOffice 的 headless 转换能力。
      const libreOffice = await resolveLibreOfficeCommand(ctx)
      if (!libreOffice) {
        // 本机缺少命令时不静默失败，返回明确安装建议和线上替代方案。
        return buildMissingSystemToolResult({
          ctx,
          command: 'soffice',
          reason: '需要使用 LibreOffice headless 将 Word 文档转换为 PDF。',
          message: '当前 shell 未找到 soffice/libreoffice，暂时无法执行 Word 转 PDF。',
          alternatives: [
            createBrowserOnlineAlternative({
              zhDescription:
                '不安装本机 LibreOffice，改用 Browser Use 打开在线 Word 转 PDF 服务；上传本地文件前会先确认目标网站和隐私风险。',
              enDescription:
                'Skip local LibreOffice and use Browser Use with an online Word-to-PDF service; confirm the target site and privacy risk before uploading files.',
              zhDraft:
                '我暂时不安装 LibreOffice。请改用 Browser Use 的线上流程继续刚才的 Word 转 PDF 任务；如果需要上传本地 Word 文件到第三方网站，请先告诉我目标网站和隐私风险，等我确认后再操作。',
              enDraft:
                'I do not want to install LibreOffice right now. Please use the Browser Use online workflow for the previous Word-to-PDF task. If you need to upload my local Word file to a third-party site, tell me the target site and privacy risk first and wait for confirmation.',
            }),
          ],
        })
      }

      // 输入支持 .doc/.docx 自动补全；输出路径统一补 .pdf。
      const inputPath = await resolveOfficeInputPathWithExtensions(ctx, input.inputPath, [
        '.docx',
        '.doc',
      ])
      const output = await prepareOfficeOutputPath(ctx, input.outputPath, '.pdf', input.overwrite)
      const normalizedWord = await normalizeWordInputToDocx({
        ctx,
        inputPath,
        libreOffice,
        timeoutMs: 180_000,
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
        const command = {
          file: libreOffice.path || libreOffice.name,
          args: ['--headless', '--convert-to', 'pdf', '--outdir', tempDir, normalizedInputPath],
        }
        const commandResult = await runLibreOfficeSystemCommand(
          ctx,
          command,
          dirname(normalizedInputPath),
          180_000
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
        await cleanupNormalizedWordInput(normalizedWord.input)
      }
    })
  },
})

// ─── Tool: convertPdfToWord ────────────────────────────────────────────────────

const convertPdfToWord = defineOfficeTool<ConvertPdfToWordInput>({
  name: 'office:convert_pdf_to_word',
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
  isAvailable: toolRequiresProject,
  isConcurrencySafe: () => false,
  execute: async (input: ConvertPdfToWordInput, ctx: OfficeToolContext) => {
    ctx.abortSignal.throwIfAborted()
    // 生成 docx 属于写操作，先让 project 做权限/路径确认。
    const authorization = await ctx.office.project.prepareMutation({
      cwd: input.cwd,
      operation: 'PDF 转 Word',
      targetPath: input.outputPath,
    })
    if (!authorization.approved) return buildProjectMutationSkippedResult(authorization)

    return runWithDirectory(ctx, input.cwd, async () => {
      const inputPath = await resolveOfficeInputPath(ctx, input.inputPath, '.pdf')
      const output = await prepareOfficeOutputPath(ctx, input.outputPath, '.docx', input.overwrite)
      // 先把 PDF 中可提取文本按页读出，再映射成 Word 段落块。
      const { pages } = await extractPdfTextPages(inputPath, { maxPages: input.maxPages })
      const blocks = pages.flatMap((page) => [
        { kind: 'heading' as const, text: `Page ${page.page}`, level: 2 as const },
        {
          kind: 'paragraph' as const,
          text: page.text || '(No extractable text on this page.)',
          spaceAfter: 180,
        },
      ])

      // 复用 wordTool 的 block -> docx children 构建逻辑，保持 Word 输出样式一致。
      const document = new Document({
        title: input.title ?? `Converted from ${input.inputPath}`,
        creator: input.author ?? 'VelarOS',
        sections: [
          {
            children: buildWordChildren({ title: input.title, blocks }),
          },
        ],
      })
      const buffer = await Packer.toBuffer(document)
      return writeOfficeBuffer(output, buffer, 'docx')
    })
  },
})

// ─── Tool: extractPdfText ─────────────────────────────────────────────────────

const extractPdfText = defineOfficeTool<ExtractPdfTextInput>({
  name: 'office:extract_pdf_text',
  role: 'inspect',
  summary: '按页提取文本型 PDF 中的可选择文本。',
  suitable: ['读取 PDF 的指定页、核对正文，或为后续总结提取有界文本。'],
  forbidden: ['不要用于扫描件或图片型 PDF 的 OCR，也不要用于编辑或转换 PDF。'],
  protocol: [
    '页码使用从 1 开始的编号；指定页使用 pages，读取前若干页使用 maxPages。',
    '省略 pages 和 maxPages 时只读取前 20 页；hasMore=true 表示仍有未读取页面。',
  ],
  usage: ['传 inputPath；需要单页或离散页面时传 pages，例如 pages=[2,5]。'],
  examples: [{ inputPath: 'paper.pdf', pages: [2] }],
  notes: ['返回总页数和逐页文本；重复页码只提取一次并保持首次出现顺序。'],
  schema: extractPdfTextSchema,
  permissions: ['fs:read'],
  capabilities: OfficeDocumentReadCapability,
  isAvailable: toolRequiresProject,
  isConcurrencySafe: () => true,
  execute: async (input: ExtractPdfTextInput, ctx: OfficeToolContext) => {
    ctx.abortSignal.throwIfAborted()
    return runWithDirectory(ctx, input.cwd, async () => {
      const inputPath = await resolveOfficeInputPath(ctx, input.inputPath, '.pdf')
      const extracted = await extractPdfTextPages(inputPath, {
        pages: input.pages,
        maxPages: input.pages ? undefined : (input.maxPages ?? 20),
      })
      return {
        inputPath,
        pageCount: extracted.pageCount,
        pages: extracted.pages,
        hasMore: extracted.pages.length < extracted.pageCount,
      }
    })
  },
})

// ─── Tool: createLatexPdf ──────────────────────────────────────────────────────

const createLatexPdf = defineOfficeTool<CreateLatexPdfInput>({
  name: 'office:create_latex_pdf',
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
  isAvailable: toolRequiresProject,
  isConcurrencySafe: () => false,
  execute: async (input: CreateLatexPdfInput, ctx: OfficeToolContext) => {
    ctx.abortSignal.throwIfAborted()
    // LaTeX 工具至少会写入 .tex，编译成功时还会写入 PDF，因此先请求写权限。
    const authorization = await ctx.office.project.prepareMutation({
      cwd: input.cwd,
      operation: 'LaTeX 生成 PDF',
      targetPath: input.outputPath,
    })
    if (!authorization.approved) return buildProjectMutationSkippedResult(authorization)

    return runWithDirectory(ctx, input.cwd, async () => {
      // 根据用户指定或 auto 策略查找本机可用编译器。
      const compiler = await resolveLatexCompiler({ ctx, compiler: input.compiler })
      if (!compiler) {
        const requestedCommand =
          input.compiler && input.compiler !== 'auto' ? input.compiler : 'tectonic'
        // 没有编译器时返回结构化缺失工具结果，包含可执行的替代方案描述。
        return buildMissingSystemToolResult({
          ctx,
          command: requestedCommand,
          reason: '需要 LaTeX 编译器将模型编写的 .tex 源码转换为 PDF。',
          message: '当前 shell 未找到可用的 LaTeX 编译器，暂时无法生成 PDF。',
          alternatives: [
            createBrowserOnlineAlternative({
              zhDescription:
                '不安装本机 LaTeX 编译器，改用 Browser Use 打开在线 LaTeX 编译服务；粘贴源码或上传文件前会先确认目标网站和隐私风险。',
              enDescription:
                'Skip local LaTeX tooling and use Browser Use with an online LaTeX compiler; confirm the target site and privacy risk before pasting source or uploading files.',
              zhDraft:
                '我暂时不安装 LaTeX 编译器。请改用 Browser Use 的线上流程继续刚才的 LaTeX 转 PDF 任务；如果需要把 LaTeX 源码粘贴或上传到第三方网站，请先告诉我目标网站和隐私风险，等我确认后再操作。',
              enDraft:
                'I do not want to install a LaTeX compiler right now. Please use the Browser Use online workflow for the previous LaTeX-to-PDF task. If you need to paste or upload LaTeX source to a third-party site, tell me the target site and privacy risk first and wait for confirmation.',
            }),
          ],
        })
      }

      const output = await prepareOfficeOutputPath(ctx, input.outputPath, '.pdf', input.overwrite)
      const source = await prepareOfficeOutputPath(
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
        const commands = buildLatexCompileCommands({
          compiler,
          sourceFileName: basename(source.path),
          tempDir,
          runs: input.runs,
        })
        const commandResults = await runLatexCompileCommands({
          ctx,
          commands,
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
    })
  },
})

// ─── Tool: editPdfDocument ─────────────────────────────────────────────────────

const editPdfDocument = defineOfficeTool<EditPdfDocumentInput>({
  name: 'office:edit_pdf_document',
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
  isAvailable: toolRequiresProject,
  isConcurrencySafe: () => false,
  execute: async (input: EditPdfDocumentInput, ctx: OfficeToolContext) => {
    ctx.abortSignal.throwIfAborted()
    // 编辑 PDF 会创建新的输出文件，先进行工作区写入授权。
    const authorization = await ctx.office.project.prepareMutation({
      cwd: input.cwd,
      operation: '编辑 PDF',
      targetPath: input.outputPath,
    })
    if (!authorization.approved) return buildProjectMutationSkippedResult(authorization)

    return runWithDirectory(ctx, input.cwd, async () => {
      const inputPath = await resolveOfficeInputPath(ctx, input.inputPath, '.pdf')
      const output = await prepareOfficeOutputPath(ctx, input.outputPath, '.pdf', input.overwrite)
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
      const outputPages = outputDocument.getPages()

      outputPages.forEach((page, index) => {
        const sourcePageNumber = sourcePageNumbers[index] ?? index + 1
        const rotation = rotateBySourcePage.get(sourcePageNumber)
        if (rotation) page.setRotation(degrees(rotation))
        for (const stamp of input.textStamps ?? []) {
          // 文字戳既可以作用到所有页，也可以按源 PDF 页码匹配到某一页。
          if (
            stamp.allPages ||
            stamp.page === sourcePageNumber ||
            (!stamp.page && !stamp.allPages)
          ) {
            applyPdfTextStamp({ page, stamp, font })
          }
        }
      })

      // 保存新文档并走统一的 Office 文件写入返回结构。
      const buffer = await outputDocument.save()
      return writeOfficeBuffer(output, Buffer.from(buffer), 'pdf')
    })
  },
})
const pdfTools = {
  'office:extract_pdf_text': extractPdfText,
  'office:convert_pdf_to_word': convertPdfToWord,
  'office:convert_word_to_pdf': convertWordToPdf,
  'office:create_latex_pdf': createLatexPdf,
  'office:edit_pdf_document': editPdfDocument,
}

export { pdfTools }
