/**
 * office:preview_document 的入参 schema，以及要跟宿主打交道的两件事：
 * 归一化输入（旧版 .doc 先转 .docx）、把预览写到磁盘。解析、HTML 与 PNG 都在 utils/preview/*。
 */

import { rm, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'

import { z } from 'zod'

import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/agent/tool-contract'
import { AppError } from '@velaros-ai/core/error'

import { OfficeInputLimits, OfficePreviewLimits } from '../contract/constants.js'
import type { NormalizedWordInput } from '../types/office.js'
import type { OfficePreviewArtifact, OfficePreviewKind, ParsedOfficePreview } from '../types/preview.js'
import { getFileStats } from '../utils/paths.js'
import { renderOfficePreviewPng } from '../utils/preview/png.js'
import { createBrowserOnlineAlternative, createCommandFailureResult } from '../utils/results.js'
import { OfficeTuning } from '../utils/tuning.js'

import {
  buildMissingSystemToolResult,
  normalizeWordInputToDocx,
  type OfficeToolContext,
  outputPathSchema,
  prepareOfficeOutputPath,
  resolveLibreOfficeCommand,
} from './officeShared'

export const previewOfficeDocumentSchema = z.object({
  cwd: z.string().optional(),
  inputPath: z
    .string()
    .min(1)
    .max(OfficeInputLimits.pathChars)
    .describe(
      parameterDescription({
        description: '输入 Office 文件路径。',
        usage: ['支持 .docx、.doc、.pptx、.xlsx，也支持相对当前工作区的路径。'],
      })
    ),
  outputPath: outputPathSchema
    .optional()
    .describe(
      parameterDescription({
        description: '可选预览输出路径，支持 .html 或 .png。',
        notes: ['无扩展名时自动补齐 .html；需要静态预览图时显式使用 .png。'],
      })
    ),
  overwrite: z.boolean().optional(),
  maxItems: z.number().int().min(1).max(OfficePreviewLimits.maxItems).optional(),
  autoRefresh: z
    .boolean()
    .optional()
    .describe(
      parameterDescription({
        description: '生成 HTML 预览时是否加入自动刷新脚本。',
        usage: ['便于在浏览器中查看最新预览。'],
      })
    ),
})

/** 认出预览输入的类型；旧版 .doc 先借 LibreOffice 转成临时 .docx 再解析。 */
export async function normalizePreviewInput(
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

  const libreOffice = await resolveLibreOfficeCommand(ctx)
  if (!libreOffice) return {
      success: false,
      result: buildMissingSystemToolResult({
        ctx,
        command: 'soffice',
        reason: '需要使用 LibreOffice headless 将旧版 .doc 转换为 .docx 后再解析预览。',
        message: '当前 shell 未找到 soffice/libreoffice，暂时无法预览旧版 .doc 文档。',
        alternatives: [
          createBrowserOnlineAlternative({
            zhDescription:
              '不安装本机 LibreOffice，改用 Browser Use 打开在线 DOC 转 DOCX/预览服务；上传本地文件前会先确认目标网站和隐私风险。',
            enDescription:
              'Skip local LibreOffice and use Browser Use with an online DOC-to-DOCX or preview service; confirm the target site and privacy risk before uploading files.',
            zhDraft:
              '我暂时不安装 LibreOffice。请改用 Browser Use 的线上流程继续刚才的 DOC 预览任务；如果需要上传本地 Word 文件到第三方网站，请先告诉我目标网站和隐私风险，等我确认后再操作。',
            enDraft:
              'I do not want to install LibreOffice right now. Please use the Browser Use online workflow for the previous DOC preview task. If you need to upload my local Word file to a third-party site, tell me the target site and privacy risk first and wait for confirmation.',
          }),
        ],
      }),
    }

  const normalized = await normalizeWordInputToDocx({
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

  return {
    success: true,
    path: normalized.input.path,
    kind: 'docx',
    wordInput: normalized.input,
  }
}

/** 把预览写到磁盘：.html 直接写 HTML，.png 先渲染成图片再写。 */
export async function writeOfficePreview(
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
  const prepared = await prepareOfficeOutputPath(ctx, outputPath, extension, overwrite)
  const image = extension === '.png' ? await renderOfficePreviewPng(parsed) : null
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
