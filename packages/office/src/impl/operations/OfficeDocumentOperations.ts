/**
 * 三个创建工具的执行者：`OfficeDocumentOperations` 与整个进程唯一的 `officeDocumentOperations`。
 * 接口 `OfficeDocumentOperationsApi` 在本文件的类上方。Word、PowerPoint、Excel 各一条链路：
 * 先把输入归一成结构化内容，再过写入授权，最后在工作区内落盘。
 */

import { stat } from 'node:fs/promises'

import { Document, Packer } from 'docx'
import ExcelJS from 'exceljs'

import { isEmpty, isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import PptxGenJS from '../../../vendor/pptxgenjs/pptxgen.es.js'
import { OfficeToolNames } from '../../contract/constants.js'
import type { OfficeToolContext } from '../../contract/requires.js'
import type {
  CreatePresentationInput,
  CreateSpreadsheetInput,
  CreateWordDocumentInput,
} from '../../types/inputs.js'
import type { OfficeOutput } from '../../types/workspace.js'
import { writeOfficeBuffer } from '../../utils/paths.js'
import { normalizePresentationSlides } from '../../utils/presentation/content.js'
import { addSlideElements } from '../../utils/presentation/elements.js'
import { buildPresentationTheme } from '../../utils/presentation/templates.js'
import { normalizeSpreadsheetSheets } from '../../utils/spreadsheet/content.js'
import {
  addSpreadsheetWorksheet,
  applyAutoWidths,
  applyNumberFormats,
  writeSpreadsheetRow,
} from '../../utils/spreadsheet/sheet.js'
import { buildExcelCellStyle } from '../../utils/spreadsheet/style.js'
import { normalizeWordBlocks } from '../../utils/word/content.js'
import { buildWordChildren, buildWordDocument } from '../../utils/word/docx.js'
import { appendWordDocumentBuffer } from '../../utils/word/ooxml-append.js'

import type { OfficeWorkspaceApi } from './OfficeWorkspace.js'
import { officeWorkspace } from './OfficeWorkspace.js'

/**
 * 三个创建工具的执行者。每个方法都遵守同一条顺序：归一化内容 → 内容为空就拒绝 →
 * 向宿主申请写入授权 → 在（可选的）cwd 下准备输出路径并落盘。被拒时一个字节都不写。
 */
export interface OfficeDocumentOperationsApi {
  /** 生成 .docx；appendMode 命中已有文件时把新内容缝进原文档，否则新建整篇。 */
  createWordDocument(input: CreateWordDocumentInput, ctx: OfficeToolContext): Promise<unknown>
  /** 生成 .pptx；slides 为结构化元素，content 走自动拆页。 */
  createPresentation(input: CreatePresentationInput, ctx: OfficeToolContext): Promise<unknown>
  /** 生成 .xlsx；sheets 为结构化工作表，content 走 CSV/TSV/Markdown/JSON 自动解析。 */
  createSpreadsheet(input: CreateSpreadsheetInput, ctx: OfficeToolContext): Promise<unknown>
}

export class OfficeDocumentOperations implements OfficeDocumentOperationsApi {
  /** 三个工具在内容为空时给模型的提示，按工具名索引。 */
  private static readonly EmptyContentMessages = {
    [OfficeToolNames.createWordDocument]:
      `${OfficeToolNames.createWordDocument}: blocks/content 为空或缺失。请传入结构化 blocks 数组，或传入 Markdown/纯文本字符串。`,
    [OfficeToolNames.createPresentation]:
      `${OfficeToolNames.createPresentation}: slides/content 为空或缺失。请传入结构化 slides 数组，或传入 Markdown/纯文本字符串。`,
    [OfficeToolNames.createSpreadsheet]:
      `${OfficeToolNames.createSpreadsheet}: sheets/content 为空或缺失。请传入结构化 sheets 数组，或传入 CSV/TSV/Markdown 表格字符串。`,
  }

  constructor(private readonly workspace: OfficeWorkspaceApi) {}

  public async createWordDocument(
    input: CreateWordDocumentInput,
    ctx: OfficeToolContext
  ): Promise<unknown> {
    const blocks = normalizeWordBlocks(input)
    if (isEmpty(blocks))
      throw new AppError(
        'VALIDATION',
        OfficeDocumentOperations.EmptyContentMessages[OfficeToolNames.createWordDocument]
      )
    ctx.abortSignal.throwIfAborted()
    // Office 产物写入前统一请求工作区 mutation 授权。
    const denied = await this.workspace.authorizeMutation(ctx, {
      cwd: input.cwd,
      operation: '生成 Word 文档',
      targetPath: input.outputPath,
    })
    if (denied) return denied

    return this.workspace.runInDirectory(ctx, input.cwd, async () => {
      const output = await this.workspace.prepareWordOutput(ctx, input)
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
  }

  public async createPresentation(
    input: CreatePresentationInput,
    ctx: OfficeToolContext
  ): Promise<unknown> {
    const slides = normalizePresentationSlides(input)
    if (isEmpty(slides))
      throw new AppError(
        'VALIDATION',
        OfficeDocumentOperations.EmptyContentMessages[OfficeToolNames.createPresentation]
      )
    ctx.abortSignal.throwIfAborted()
    // 写入 PPTX 前先请求工作区授权。
    const denied = await this.workspace.authorizeMutation(ctx, {
      cwd: input.cwd,
      operation: '生成 PowerPoint 演示文稿',
      targetPath: input.outputPath,
    })
    if (denied) return denied

    return this.workspace.runInDirectory(ctx, input.cwd, async () => {
      const output = await this.workspace.prepareOutput(ctx, input.outputPath, '.pptx', input.overwrite)
      const pptx = new PptxGenJS()
      // 基础文档属性和可选 layout/theme 都在创建后设置。
      pptx.layout = input.layout ?? 'LAYOUT_WIDE'
      pptx.author = input.author ?? 'VelarOS'
      pptx.company = 'VelarOS'
      pptx.title = input.title ?? output.path
      pptx.subject = input.title ?? 'Generated presentation'
      if (isPresent(input.rtlMode)) pptx.rtlMode = input.rtlMode
      pptx.theme = input.theme ?? buildPresentationTheme(input.template ?? 'modern')

      for (const slideInput of slides) {
        const slide = pptx.addSlide()
        // 每页可独立设置背景、元素和 speaker notes。
        if (slideInput.background) slide.background = slideInput.background
        addSlideElements(slide, slideInput.elements)
        if (slideInput.notes) slide.addNotes(slideInput.notes)
      }

      await pptx.writeFile({ fileName: output.path })
      const fileStats = await stat(output.path)
      return {
        path: output.path,
        bytes: fileStats.size,
        created: output.created,
        changed: true,
        kind: 'pptx',
      } satisfies OfficeOutput
    })
  }

  public async createSpreadsheet(
    input: CreateSpreadsheetInput,
    ctx: OfficeToolContext
  ): Promise<unknown> {
    // 先把所有输入规整为工作表数组，后续生成逻辑只关心 sheets。
    const sheets = normalizeSpreadsheetSheets(input)
    if (isEmpty(sheets))
      throw new AppError(
        'VALIDATION',
        OfficeDocumentOperations.EmptyContentMessages[OfficeToolNames.createSpreadsheet]
      )
    ctx.abortSignal.throwIfAborted()
    // 写文件前统一走工作区授权，确保用户知道会修改哪个路径。
    const denied = await this.workspace.authorizeMutation(ctx, {
      cwd: input.cwd,
      operation: '生成 Excel 工作簿',
      targetPath: input.outputPath,
    })
    if (denied) return denied

    return this.workspace.runInDirectory(ctx, input.cwd, async () => {
      const output = await this.workspace.prepareOutput(ctx, input.outputPath, '.xlsx', input.overwrite)
      const workbook = new ExcelJS.Workbook()
      // 工作簿级元数据写在文件属性里，不影响表格内容。
      workbook.creator = input.author ?? 'VelarOS'
      workbook.lastModifiedBy = input.author ?? 'VelarOS'
      workbook.created = new Date()
      workbook.modified = new Date()
      workbook.title = input.title ?? ''

      for (const [sheetIndex, sheetInput] of sheets.entries()) {
        const sheet = addSpreadsheetWorksheet(workbook, sheetInput, sheetIndex)

        if (!!sheetInput.columns && !isEmpty(sheetInput.columns)) {
          // 列定义主要负责表头、key、宽度和默认列样式。
          sheet.columns = sheetInput.columns.map((col) =>
            isString(col)
              ? { header: col }
              : { header: col.header, key: col.key, width: col.width, style: col.style as object }
          )
        }

        for (const rowData of sheetInput.rows) writeSpreadsheetRow(sheet, rowData)

        if (sheetInput.headerStyle && sheetInput.columns?.length) {
          const headerStyle = buildExcelCellStyle(sheetInput.headerStyle)
          for (let column = 1; column <= sheetInput.columns.length; column++)
            Object.assign(sheet.getRow(1).getCell(column), headerStyle)
        }
        applyNumberFormats(sheet, sheetInput.numberFormats)

        // 内容全部写入后再自动列宽，避免漏掉后续行的最长文本。
        applyAutoWidths(sheet)
      }

      // ExcelJS 输出 ArrayBuffer，最终转成 Buffer 交给共享写入逻辑。
      const buffer = await workbook.xlsx.writeBuffer()
      return writeOfficeBuffer(output, Buffer.from(buffer), 'xlsx')
    })
  }
}

/** 整个进程共用的创建操作。 */
export const officeDocumentOperations: OfficeDocumentOperationsApi = new OfficeDocumentOperations(
  officeWorkspace
)
