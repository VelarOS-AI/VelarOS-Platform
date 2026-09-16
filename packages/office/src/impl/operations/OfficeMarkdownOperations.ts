/**
 * 文档转 Markdown 的执行者：`OfficeMarkdownOperations` 与整个进程唯一的 `officeMarkdownOperations`。
 * 接口 `OfficeMarkdownOperationsApi` 在本文件的类上方。调随应用安装的 MarkItDown runtime，
 * 走 stdout 或写临时文件两条路，再按 maxChars 截断返回给模型。
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

import { OfficeErrorCodes, OfficeMarkItDownInputExtensions } from '../../contract/constants.js'
import type { OfficeToolContext } from '../../contract/requires.js'
import type { ConvertDocumentToMarkdownInput } from '../../types/inputs.js'
import type { MarkItDownLaunchSpec } from '../../types/office.js'
import { buildMarkItDownCommand, describeOfficeNativeCommand } from '../../utils/commands.js'
import { truncateMarkdown } from '../../utils/markdown.js'
import { OfficeTuning } from '../../utils/tuning.js'
import type { MarkItDownLocatorApi } from '../runtime/MarkItDownLocator.js'
import { markItDownBinaryResolver } from '../runtime/MarkItDownLocator.js'

import type { OfficeWorkspaceApi } from './OfficeWorkspace.js'
import { officeWorkspace } from './OfficeWorkspace.js'

/**
 * 文档转 Markdown 的执行者。不给 outputPath 时把 Markdown 直接返回给模型（宿主的命令输出窗口
 * 保留结尾，因此截断时会如实说明返回的是文档尾部）；给了 outputPath 就先写临时文件再落到工作区里。
 */
export interface OfficeMarkdownOperationsApi {
  /** 把工作区内的文档转成 Markdown；MarkItDown 没装或被停用时返回结构化跳过结果。 */
  convertToMarkdown(
    input: ConvertDocumentToMarkdownInput,
    ctx: OfficeToolContext
  ): Promise<unknown>
  /** MarkItDown 装没装、在哪；工具的 isAvailable 用它决定这个工具进不进发现目录。 */
  locateMarkItDown(ctx: OfficeToolContext): Nullable<MarkItDownLaunchSpec>
}

export class OfficeMarkdownOperations implements OfficeMarkdownOperationsApi {
  /** 命令输出窗口把开头丢掉时给模型的抬头；不写它，模型会把文档结尾当成开头读。 */
  private static readonly OutputWindowTruncatedNotice =
    '<!-- 以下是文档的结尾部分：完整输出超过宿主的命令输出窗口，开头已被丢弃。需要完整内容请传 outputPath 写入文件后再读。 -->'

  /** 输出窗口截断时的说明。 */
  private static readonly OutputWindowTruncatedMessage =
    'MarkItDown 输出超过宿主的命令输出窗口，返回的是文档结尾部分；需要完整内容请传 outputPath 写入文件后再读。'

  /** MarkItDown runtime 没装或被停用时的说明。 */
  private static readonly RuntimeUnavailableMessage =
    '未找到 MarkItDown runtime。请在插件市场安装 MarkItDown，或确认它没有在设置里被停用。'

  constructor(
    private readonly workspace: OfficeWorkspaceApi,
    private readonly locator: MarkItDownLocatorApi
  ) {}

  public async convertToMarkdown(
    input: ConvertDocumentToMarkdownInput,
    ctx: OfficeToolContext
  ): Promise<unknown> {
    ctx.abortSignal.throwIfAborted()

    if (input.outputPath) {
      const denied = await this.workspace.authorizeMutation(ctx, {
        cwd: input.cwd,
        operation: '生成 Markdown 文档',
        targetPath: input.outputPath,
      })
      if (denied) return denied
    }

    const maxChars = input.maxChars ?? OfficeTuning.markdown.returnChars

    return this.workspace.runInDirectory(ctx, input.cwd, async () => {
      const inputPath = await this.workspace.resolveInput(
        ctx,
        input.inputPath,
        OfficeMarkItDownInputExtensions
      )
      const launch = this.locateMarkItDown(ctx)
      if (!launch) return {
        changed: false,
        skipped: true,
        errorCode: OfficeErrorCodes.markItDownUnavailable,
        missingRuntime: 'markitdown',
        message: OfficeMarkdownOperations.RuntimeUnavailableMessage,
      }

      if (input.outputPath) return this.runToFile({
        ctx,
        launch,
        inputPath,
        outputPath: input.outputPath,
        overwrite: input.overwrite,
        maxChars,
      })

      return this.runToStdout({ ctx, launch, inputPath, maxChars })
    })
  }

  /** 宿主的插件状态优先；宿主没实现这个端口方法时回落到只按平台约定推导资源根的缺省定位器。 */
  public locateMarkItDown(ctx: OfficeToolContext): Nullable<MarkItDownLaunchSpec> {
    return ctx.office.locateMarkItDown?.() ?? this.locator.resolve()
  }

  /** 让 MarkItDown 把结果打到 stdout，再按 maxChars 截断返回。 */
  private async runToStdout(input: {
    ctx: OfficeToolContext
    launch: MarkItDownLaunchSpec
    inputPath: string
    maxChars: number
  }): Promise<Record<string, unknown>> {
    const nativeCommand = buildMarkItDownCommand({ launch: input.launch, inputPath: input.inputPath })
    const commandResult = await input.ctx.office.runCommand(nativeCommand, {
      description: describeOfficeNativeCommand(nativeCommand),
      cwd: this.workspace.rootPath(input.ctx),
      timeoutMs: OfficeTuning.command.markItDownTimeoutMs,
      maxOutputChars: input.maxChars + OfficeTuning.markdown.stdoutHeadroomChars,
    })

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
      changed: false,
      inputPath: input.inputPath,
      kind: 'markdown',
      markdown: limited.markdown,
      truncated: limited.truncated,
      commandResult,
    }
    // 宿主的命令输出窗口**保留结尾**：长文档这里拿到的是文档末尾，而截断发生在 stdout 这一层，
    // 只看 maxChars 的那一步会一路报 truncated=false，模型于是把结尾当开头读（2026-09-16 实测）。
    if (!commandResult.truncated) return result
    return {
      ...result,
      markdown: `${OfficeMarkdownOperations.OutputWindowTruncatedNotice}\n\n${limited.markdown}`,
      truncated: true,
      message: OfficeMarkdownOperations.OutputWindowTruncatedMessage,
    }
  }

  /** 让 MarkItDown 写临时文件，再把完整内容落到工作区里，返回值只带截断后的前若干字符。 */
  private async runToFile(input: {
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
      const commandResult = await input.ctx.office.runCommand(nativeCommand, {
        description: describeOfficeNativeCommand(nativeCommand),
        cwd: this.workspace.rootPath(input.ctx),
        timeoutMs: OfficeTuning.command.markItDownTimeoutMs,
        maxOutputChars: OfficeTuning.command.outputChars,
      })

      if (!commandResult.success) return {
        changed: false,
        inputPath: input.inputPath,
        kind: 'markdown',
        markdown: '',
        truncated: false,
        commandResult,
        message: `MarkItDown 转换失败：外部命令退出码 ${commandResult.exitCode ?? 'unknown'}。请查看 stdout/stderr。`,
      }

      const output = await this.workspace.prepareOutput(
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
}

/** 整个进程共用的 Markdown 转换操作。 */
export const officeMarkdownOperations: OfficeMarkdownOperationsApi = new OfficeMarkdownOperations(
  officeWorkspace,
  markItDownBinaryResolver
)
