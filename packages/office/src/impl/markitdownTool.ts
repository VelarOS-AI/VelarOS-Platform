/**
 * office:convert_document_to_markdown 的入参 schema 与执行主体：调随应用安装的 MarkItDown runtime，
 * 走 stdout 或写临时文件两条路，再按 maxChars 截断返回给模型。
 */

import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'

import { OfficeInputLimits, OfficeMarkdownLimits, OfficeMarkItDownInputExtensions } from '../contract/constants.js'
import type { ConvertDocumentToMarkdownInput } from '../types/inputs.js'
import type { MarkItDownLaunchSpec } from '../types/office.js'
import { buildMarkItDownCommand, describeOfficeNativeCommand } from '../utils/commands.js'
import { truncateMarkdown } from '../utils/markdown.js'
import { buildProjectMutationSkippedResult } from '../utils/results.js'
import { OfficeTuning } from '../utils/tuning.js'

import { markItDownBinaryResolver } from './markitdownResolver'
import {
  type OfficeToolContext,
  outputPathSchema,
  prepareOfficeOutputPath,
  resolveOfficeInputPathWithExtensions,
  runWithDirectory,
} from './officeShared'

export const convertDocumentToMarkdownSchema = z.object({
  cwd: z.string().optional(),
  inputPath: z
    .string()
    .min(1)
    .max(OfficeInputLimits.pathChars)
    .describe(
      parameterDescription({
        description: '输入文件路径。',
        usage: ['支持 PDF、Word、PowerPoint、Excel、HTML、CSV、JSON、XML、ZIP、EPub 和文本文件。'],
        notes: ['只支持本地工作区内文件，不接受 URL。'],
      })
    ),
  outputPath: outputPathSchema.optional().describe(
    parameterDescription({
      description: '可选 Markdown 输出路径。',
      notes: ['无扩展名时自动补齐 .md；写入前会走工作区 mutation 授权。'],
    })
  ),
  overwrite: z.boolean().optional(),
  maxChars: z
    .number()
    .int()
    .min(OfficeMarkdownLimits.minReturnChars)
    .max(OfficeMarkdownLimits.maxReturnChars)
    .optional()
    .describe(
      parameterDescription({
        description: '返回结果中最多包含的 Markdown 字符数。',
        notes: ['写入 outputPath 时仍会保存完整 Markdown；该限制只影响工具返回文本。'],
      })
    ),
})

/** 命令输出窗口把开头丢掉时给模型的抬头；不写它，模型会把文档结尾当成开头读。 */
const OutputWindowTruncatedNotice =
  '<!-- 以下是文档的结尾部分：完整输出超过宿主的命令输出窗口，开头已被丢弃。需要完整内容请传 outputPath 写入文件后再读。 -->'

/** MarkItDown runtime 没装或被停用时的跳过结果。 */
function buildBundledRuntimeUnavailableResult(): {
  changed: false
  skipped: true
  missingRuntime: 'markitdown'
  message: string
  systemToolSuggestion: null
} {
  return {
    changed: false,
    skipped: true,
    missingRuntime: 'markitdown',
    message:
      '未找到 MarkItDown runtime。请在插件市场安装 MarkItDown，或确认它没有在设置里被停用。',
    systemToolSuggestion: null,
  }
}

async function runMarkItDownToStdout(input: {
  ctx: OfficeToolContext
  launch: MarkItDownLaunchSpec
  inputPath: string
  cwd: string
  maxChars: number
}): Promise<{
  changed: false
  inputPath: string
  kind: 'markdown'
  markdown: string
  truncated: boolean
  commandResult: unknown
  message?: string
}> {
  const nativeCommand = buildMarkItDownCommand({ launch: input.launch, inputPath: input.inputPath })
  const commandResult = await input.ctx.office.system.runCommand(
    describeOfficeNativeCommand(nativeCommand),
    {
      cwd: input.cwd,
      timeoutMs: OfficeTuning.command.markItDownTimeoutMs,
      maxOutputChars: input.maxChars + OfficeTuning.markdown.stdoutHeadroomChars,
      nativeCommand,
    },
    false
  )

  if (!commandResult.success) return {
    changed: false,
    inputPath: input.inputPath,
    kind: 'markdown',
    markdown: '',
    truncated: false,
    commandResult,
  }

  const limited = truncateMarkdown(commandResult.stdout ?? '', input.maxChars)
  const result = {
    changed: false as const,
    inputPath: input.inputPath,
    kind: 'markdown' as const,
    markdown: limited.markdown,
    truncated: limited.truncated,
    commandResult,
  }
  // 宿主的命令输出窗口**保留结尾**：长文档这里拿到的是文档末尾，而截断发生在 stdout 这一层，
  // 只看 maxChars 的那一步会一路报 truncated=false，模型于是把结尾当开头读（2026-09-16 实测）。
  if (!commandResult.truncated) return result
  return {
    ...result,
    markdown: `${OutputWindowTruncatedNotice}\n\n${limited.markdown}`,
    truncated: true,
    message:
      'MarkItDown 输出超过宿主的命令输出窗口，返回的是文档结尾部分；需要完整内容请传 outputPath 写入文件后再读。',
  }
}

async function runMarkItDownToFile(input: {
  ctx: OfficeToolContext
  launch: MarkItDownLaunchSpec
  inputPath: string
  outputPath: string
  overwrite?: boolean
  maxChars: number
}): Promise<Record<string, unknown>> {
  const tempDir = await mkdtemp(join(tmpdir(), 'velaros-office-markitdown-'))
  const tempOutputPath = join(
    tempDir,
    `${basename(input.inputPath, extname(input.inputPath)) || 'document'}.md`
  )

  try {
    const nativeCommand = buildMarkItDownCommand({
      launch: input.launch, inputPath: input.inputPath, outputPath: tempOutputPath,
    })
    const commandResult = await input.ctx.office.system.runCommand(
      describeOfficeNativeCommand(nativeCommand),
      {
        cwd: input.ctx.office.project.getRootPath(),
        timeoutMs: OfficeTuning.command.markItDownTimeoutMs,
        maxOutputChars: OfficeTuning.command.outputChars,
        nativeCommand,
      },
      false
    )

    if (!commandResult.success) return {
      changed: false,
      inputPath: input.inputPath,
      kind: 'markdown',
      markdown: '',
      truncated: false,
      commandResult,
      message: `MarkItDown 转换失败：外部命令退出码 ${commandResult.exitCode ?? 'unknown'}。请查看 stdout/stderr。`,
    }

    const output = await prepareOfficeOutputPath(
      input.ctx,
      input.outputPath,
      '.md',
      input.overwrite
    )
    const markdown = await readFile(tempOutputPath, 'utf8')
    await writeFile(output.path, markdown, 'utf8')
    const fileStats = await stat(output.path)
    const truncated = truncateMarkdown(markdown, input.maxChars)

    return {
      changed: true,
      inputPath: input.inputPath,
      kind: 'markdown',
      markdown: truncated.markdown,
      truncated: truncated.truncated,
      output: {
        path: output.path,
        bytes: fileStats.size,
        created: output.created,
        changed: true,
        kind: 'markdown',
      },
      commandResult,
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined /* arch-guard:silent-catch-ok 尽力清理临时目录，删除失败非致命 */)
  }
}

/** office:convert_document_to_markdown 的执行主体。 */
export async function executeConvertDocumentToMarkdown(
  input: ConvertDocumentToMarkdownInput,
  ctx: OfficeToolContext
) {
  ctx.abortSignal.throwIfAborted()

  if (input.outputPath) {
    const authorization = await ctx.office.project.prepareMutation({
      cwd: input.cwd,
      operation: '生成 Markdown 文档',
      targetPath: input.outputPath,
    })
    if (!authorization.approved) return buildProjectMutationSkippedResult(authorization)
  }

  const maxChars = input.maxChars ?? OfficeTuning.markdown.returnChars

  return runWithDirectory(ctx, input.cwd, async () => {
    const inputPath = await resolveOfficeInputPathWithExtensions(
      ctx,
      input.inputPath,
      OfficeMarkItDownInputExtensions
    )
    const launch = markItDownBinaryResolver.resolve()
    if (!launch) return buildBundledRuntimeUnavailableResult()

    if (input.outputPath) return runMarkItDownToFile({
      ctx,
      launch,
      inputPath,
      outputPath: input.outputPath,
      overwrite: input.overwrite,
      maxChars,
    })

    return runMarkItDownToStdout({
      ctx,
      launch,
      inputPath,
      cwd: ctx.office.project.getRootPath(),
      maxChars,
    })
  })
}
