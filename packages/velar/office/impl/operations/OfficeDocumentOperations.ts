/**
 * 三个创建操作的执行者：`OfficeDocumentOperations` 与整个进程唯一的 `officeDocumentOperations`。
 * 接口 `OfficeDocumentOperationsApi` 在本文件的类上方。Word、PowerPoint、Excel 各一条链路：
 * 先把输入归一成结构化内容，再在工作区内准备输出路径并落盘。
 */

import { Document, Packer } from 'docx'
import ExcelJS from 'exceljs'

import { isEmpty, isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { OfficeErrorCodes } from '../../contract/constants.js'
import type { OfficeOperationContext } from '../../contract/requires.js'
import type {
  OfficePresentationInput,
  OfficeSpreadsheetInput,
  OfficeWordInput,
  OfficeWritten,
  PresentationSlideInput,
} from '../../types/office.js'
import type { PptxBackground } from '../../types/pptx.js'
import { writeOfficeFile, writtenReceipt } from '../../utils/paths.js'
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

import PptxGenJS from '#pptxgenjs'

/**
 * 三个创建操作的执行者。每个方法都遵守同一条顺序：归一化内容 → 内容为空就拒绝 → 在工作区根内准备输出路径并落盘。
 */
export interface OfficeDocumentOperationsApi {
  /** 生成 .docx；appendMode 命中已有文件时把新内容缝进原文档，否则新建整篇。 */
  createWord(input: OfficeWordInput, ctx: OfficeOperationContext): Promise<OfficeWritten>
  /** 生成 .pptx；slides 为结构化页面，content 走自动拆页。 */
  createPresentation(input: OfficePresentationInput, ctx: OfficeOperationContext): Promise<OfficeWritten>
  /** 生成 .xlsx；sheets 为结构化工作表，content 走 CSV/TSV/Markdown/JSON 自动解析。 */
  createSpreadsheet(input: OfficeSpreadsheetInput, ctx: OfficeOperationContext): Promise<OfficeWritten>
}

export class OfficeDocumentOperations implements OfficeDocumentOperationsApi {
  /** 内容归一化之后什么都没有时给模型的说明，按操作索引。 */
  private static readonly EmptyContentMessages = {
    createWord: 'createWord 没有可写的内容：blocks 是空的，或 content 解析不出任何段落。',
    createPresentation: 'createPresentation 没有可写的内容：slides 是空的，或 content 拆不出任何一页。',
    createSpreadsheet: 'createSpreadsheet 没有可写的内容：sheets 是空的，或 content 解析不出任何一行。',
  }

  /** 幻灯片背景图认的扩展名。 */
  private static readonly BackgroundImageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.bmp', '.webp']

  constructor(private readonly workspace: OfficeWorkspaceApi) {}

  public async createWord(input: OfficeWordInput, ctx: OfficeOperationContext): Promise<OfficeWritten> {
    const blocks = normalizeWordBlocks(input)
    if (isEmpty(blocks)) throw new AppError(OfficeErrorCodes.emptyContent, OfficeDocumentOperations.EmptyContentMessages.createWord)
    ctx.abortSignal.throwIfAborted()

    const output = await this.workspace.prepareWordOutput(ctx, input)
    if (output.append) {
      // append 模式先生成临时 fragment docx，再把 XML body 合并进原文档。
      const fragmentDocument = new Document({
        title: input.title,
        creator: input.author ?? '',
        sections: [{ children: buildWordChildren({ blocks }) }],
      })
      return appendWordDocumentBuffer(output, await Packer.toBuffer(fragmentDocument))
    }
    // 新建模式直接构建完整 document。
    const document = buildWordDocument({ ...input, blocks })
    return writeOfficeFile(output, await Packer.toBuffer(document))
  }

  public async createPresentation(input: OfficePresentationInput, ctx: OfficeOperationContext): Promise<OfficeWritten> {
    const slides = normalizePresentationSlides(input)
    if (isEmpty(slides)) throw new AppError(OfficeErrorCodes.emptyContent, OfficeDocumentOperations.EmptyContentMessages.createPresentation)
    ctx.abortSignal.throwIfAborted()

    const output = await this.workspace.prepareOutput(ctx, input.outputPath, '.pptx', input.overwrite)
    const pptx = new PptxGenJS()
    // 基础文档属性和可选 layout/theme 都在创建后设置。
    pptx.layout = input.layout ?? 'LAYOUT_WIDE'
    // 作者、公司、标题都是用户文档的元数据，不给就留空：
    // 产品名不写进用户的产物，本机的绝对路径更不该跟着文件走。
    pptx.author = input.author ?? ''
    pptx.company = ''
    pptx.title = input.title ?? ''
    pptx.subject = input.title ?? ''
    if (isPresent(input.rtlMode)) pptx.rtlMode = input.rtlMode
    pptx.theme = input.theme ?? buildPresentationTheme(input.template ?? 'modern')

    for (const slideInput of slides) {
      const slide = pptx.addSlide()
      // 每页可独立设置背景、元素和 speaker notes；背景图按工作区根解析，出了根一样拒绝。
      if (slideInput.background) slide.background = await this.resolveBackground(ctx, slideInput.background)
      addSlideElements(slide, slideInput.elements)
      if (slideInput.notes) slide.addNotes(slideInput.notes)
    }

    await pptx.writeFile({ fileName: output.path })
    return writtenReceipt(output)
  }

  public async createSpreadsheet(input: OfficeSpreadsheetInput, ctx: OfficeOperationContext): Promise<OfficeWritten> {
    // 先把所有输入规整为工作表数组，后续生成逻辑只关心 sheets。
    const sheets = normalizeSpreadsheetSheets(input)
    if (isEmpty(sheets)) throw new AppError(OfficeErrorCodes.emptyContent, OfficeDocumentOperations.EmptyContentMessages.createSpreadsheet)
    ctx.abortSignal.throwIfAborted()

    const output = await this.workspace.prepareOutput(ctx, input.outputPath, '.xlsx', input.overwrite)
    const workbook = new ExcelJS.Workbook()
    // 工作簿级元数据写在文件属性里，不影响表格内容。
    workbook.creator = input.author ?? ''
    workbook.lastModifiedBy = input.author ?? ''
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
    return writeOfficeFile(output, Buffer.from(buffer))
  }

  /** 幻灯片背景：颜色与 base64 原样交给 PptxGenJS，图片路径先按工作区根解析成真实路径。 */
  private async resolveBackground(
    ctx: OfficeOperationContext,
    background: NonNullable<PresentationSlideInput['background']>
  ): Promise<PptxBackground> {
    if (!background.path) return background as PptxBackground
    const path = await this.workspace.resolveInput(ctx, background.path, OfficeDocumentOperations.BackgroundImageExtensions)
    return { ...background, path } as PptxBackground
  }
}

/** 整个进程共用的创建操作。 */
export const officeDocumentOperations: OfficeDocumentOperationsApi = new OfficeDocumentOperations(officeWorkspace)
