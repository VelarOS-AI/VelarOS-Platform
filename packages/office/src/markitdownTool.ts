import { readFile, stat, writeFile } from 'node:fs/promises'

import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'

import { markItDownBinaryResolver, type MarkItDownLaunchSpec } from './markitdownResolver'
import { officePlatformCompatibility } from './OfficePlatformCompatibility'
import {
  buildProjectMutationSkippedResult,
  mkdtemp,
  type OfficeToolContext,
  outputPathSchema,
  prepareOfficeOutputPath,
  resolveOfficeInputPathWithExtensions,
  rm,
  runWithDirectory,
  tmpdir,
} from './officeShared'
import { basename, extname, join } from './officeShared'

const DEFAULT_MAX_CHARS = 60_000
const MAX_RETURN_CHARS = 200_000

const MARKITDOWN_INPUT_EXTENSIONS = [
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.html',
  '.htm',
  '.csv',
  '.json',
  '.xml',
  '.zip',
  '.epub',
  '.txt',
  '.md',
  '.markdown',
] as const

export type ConvertDocumentToMarkdownInput = {
  cwd?: string
  inputPath: string
  outputPath?: string
  overwrite?: boolean
  maxChars?: number
}

export const convertDocumentToMarkdownSchema = z.object({
  cwd: z.string().optional(),
  inputPath: z
    .string()
    .min(1)
    .max(1200)
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
    .min(1_000)
    .max(MAX_RETURN_CHARS)
    .optional()
    .describe(
      parameterDescription({
        description: '返回结果中最多包含的 Markdown 字符数。',
        notes: ['写入 outputPath 时仍会保存完整 Markdown；该限制只影响工具返回文本。'],
      })
    ),
})

function truncateMarkdown(
  markdown: string,
  maxChars: number
): { markdown: string; truncated: boolean } {
  if (markdown.length <= maxChars) return { markdown, truncated: false }

  return {
    markdown: `${markdown.slice(0, maxChars)}\n\n<!-- MarkItDown output truncated by VelarOS -->`,
    truncated: true,
  }
}

function buildMarkItDownCommand(input: {
  launch: MarkItDownLaunchSpec
  inputPath: string
  outputPath?: string
}): string {
  const args = [
    officePlatformCompatibility.quoteShellArg(input.launch.command),
    officePlatformCompatibility.quoteShellArg(input.inputPath),
  ]
  if (input.outputPath) {
    args.push('-o', officePlatformCompatibility.quoteShellArg(input.outputPath))
  }
  return args.join(' ')
}

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
      '内置 MarkItDown runtime 未找到。请确认应用构建产物包含 out/resources/markitdown/markitdown-<platform>-<arch> 资源包。',
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
}> {
  const commandResult = await input.ctx.office.system.runCommand(
    buildMarkItDownCommand({
      launch: input.launch,
      inputPath: input.inputPath,
    }),
    {
      cwd: input.cwd,
      timeoutMs: 180_000,
      maxOutputChars: input.maxChars + 4_000,
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

  return {
    changed: false,
    inputPath: input.inputPath,
    kind: 'markdown',
    ...truncateMarkdown(commandResult.stdout ?? '', input.maxChars),
    commandResult,
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
    const commandResult = await input.ctx.office.system.runCommand(
      buildMarkItDownCommand({
        launch: input.launch,
        inputPath: input.inputPath,
        outputPath: tempOutputPath,
      }),
      {
        cwd: input.ctx.office.project.getRootPath(),
        timeoutMs: 180_000,
        maxOutputChars: 20_000,
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

async function executeConvertDocumentToMarkdown(
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

  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS

  return runWithDirectory(ctx, input.cwd, async () => {
    const inputPath = await resolveOfficeInputPathWithExtensions(ctx, input.inputPath, [
      ...MARKITDOWN_INPUT_EXTENSIONS,
    ])
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

export { executeConvertDocumentToMarkdown }
