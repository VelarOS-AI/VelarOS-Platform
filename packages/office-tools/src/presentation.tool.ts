/**
 * presentationTool.ts
 *
 * PowerPoint (.pptx) 演示文稿生成工具。
 * 依赖：officeShared（共享类型 + 路径辅助）
 */
import { stat } from 'node:fs/promises'

import PptxGenJS from 'pptxgenjs'

import { isEmpty, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  buildWorkspaceMutationSkippedResult,
  defineOfficeTool,
  OfficeDocumentWriteCapability,
  type OfficeOutput,
  type OfficeToolContext,
  prepareOfficeOutputPath,
  runWithDirectory,
  toolRequiresWorkspace,
} from './officeShared'
import type { CreatePresentationInput } from './presentationTool'
import { addSlideElements, buildPresentationTheme, createPresentationGuidedSchema, createPresentationPresetSchema, createPresentationSchema, normalizeCreatePresentationGuided, normalizeCreatePresentationPreset, normalizePresentationSlides } from './presentationTool'

// ─── Tool definition ────────────────────────────────────────────────────────────

const createPresentation = defineOfficeTool<CreatePresentationInput>({
  name: 'create_presentation',
  role: 'render',
  summary: '生成 .pptx PowerPoint 演示文稿。',
  suitable: ['需要生成自动排版幻灯片，或用结构化元素精细控制 PPTX。'],
  forbidden: ['不要用它生成电子表格或 Word 文档。'],
  usage: ['传 outputPath，并提供 slides 或 content；模板用 template 选择。'],
  examples: [
    // 简单：用 Markdown/纯文本自动拆页（# 标题、--- 分页）
    { outputPath: 'deck.pptx', content: '# Title\n---\n## Agenda' },
    // 结构化：slides + elements 精细控制坐标（x/y/w/h 单位英寸），可加 speaker notes
    {
      outputPath: 'q3-review.pptx',
      template: 'consulting',
      slides: [
        {
          elements: [
            { kind: 'text', value: 'Q3 Review', x: 0.5, y: 0.4, w: 9, h: 1 },
            {
              kind: 'table',
              rows: [
                ['Metric', 'Value'],
                ['Revenue', '1.2M'],
              ],
              x: 0.5,
              y: 2,
              w: 9,
              h: 3,
            },
          ],
          notes: '强调环比增长',
        },
      ],
    },
  ],
  notes: ['direct/expert 可用 elements 控制 text、table、shape、image、chart。'],
  schema: createPresentationSchema,
  surfaces: {
    preset: {
      role: 'render',
      summary: '用文本内容快速生成 PowerPoint。',
      suitable: ['只需要 outputPath、content 和少量元数据。'],
      forbidden: ['不要用于自定义坐标、图片或图表。'],
      usage: ['传 outputPath 和 content；可传 title、template、overwrite。'],
      examples: [{ outputPath: "brief.pptx", content: "# Brief\n---\nDetails" }],
      notes: ['content 会用 # 标题和 --- 自动拆页。'],
      schema: createPresentationPresetSchema,
      normalize: normalizeCreatePresentationPreset,
    },
    guided: {
      role: 'render',
      summary: '用文本内容和常见选项生成 PowerPoint。',
      suitable: ['需要选择模板、布局、作者或 RTL 模式。'],
      forbidden: ['不要用于精细元素坐标和复杂主题对象。'],
      usage: ['传 outputPath 和 content；按需传 layout、template、rtlMode。'],
      examples: [{ outputPath: "deck.pptx", content: "# Plan", template: "consulting" }],
      notes: ['复杂元素保留给 direct/expert。'],
      schema: createPresentationGuidedSchema,
      normalize: normalizeCreatePresentationGuided,
    },
  },
  permissions: ['fs:read', 'fs:write'],
  capabilities: OfficeDocumentWriteCapability,
  isAvailable: toolRequiresWorkspace,
  isConcurrencySafe: () => false,
  execute: async (input: CreatePresentationInput, ctx: OfficeToolContext) => {
    const slides = normalizePresentationSlides(input)
    if (isEmpty(slides))
      throw new AppError(
        'VALIDATION',
        'create_presentation: slides/content 为空或缺失。请传入结构化 slides 数组，或传入 Markdown/纯文本字符串。'
      )
    ctx.abortSignal.throwIfAborted()
    // 写入 PPTX 前先请求工作区授权。
    const authorization = await ctx.workspace.prepareMutationWorkspace({
      cwd: input.cwd,
      operation: '生成 PowerPoint 演示文稿',
      targetPath: input.outputPath,
    })
    if (!authorization.approved) return buildWorkspaceMutationSkippedResult(authorization)

    return runWithDirectory(ctx, input.cwd, async () => {
      const output = await prepareOfficeOutputPath(ctx, input.outputPath, '.pptx', input.overwrite)
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
  },
})
const presentationTools = {
  create_presentation: createPresentation,
}

export { presentationTools }
