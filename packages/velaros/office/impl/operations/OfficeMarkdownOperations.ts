/**
 * 文档转 Markdown 的执行者：`OfficeMarkdownOperations` 与整个进程唯一的 `officeMarkdownOperations`。
 * 接口 `OfficeMarkdownOperationsApi` 在本文件的类上方。调随应用安装的 MarkItDown runtime，
 * 走 stdout 或写临时文件两条路，再按 maxChars 截断交回给模型。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

import { OfficeMarkItDownInputExtensions } from '../../contract/constants.js'
import type { OfficeOperationContext } from '../../contract/requires.js'
import type {
  MarkItDownLaunchSpec,
  OfficeMarkdown,
  OfficeMarkdownInput,
} from '../../types/office.js'
import { buildMarkItDownCommand, describeOfficeNativeCommand } from '../../utils/commands.js'
import { conversionFailedError, markItDownUnavailableError } from '../../utils/errors.js'
import { truncateMarkdown } from '../../utils/markdown.js'
import { writeOfficeFile } from '../../utils/paths.js'
import { OfficeTuning } from '../../utils/tuning.js'
import type { MarkItDownLocatorApi } from '../runtime/MarkItDownLocator.js'
import { createMarkItDownLocator } from '../runtime/MarkItDownLocator.js'

import type { OfficeWorkspaceApi } from './OfficeWorkspace.js'
import { officeWorkspace } from './OfficeWorkspace.js'

/**
 * 文档转 Markdown 的执行者。不给 outputPath 时让 MarkItDown 打到 stdout（宿主的命令输出窗口保留结尾，
 * 被窗口截过时如实说明交回的是文档尾部）；给了 outputPath 就先写临时文件、完整落到工作区里，交回的只是开头。
 */
export interface OfficeMarkdownOperationsApi {
  /** 把工作区内的文档转成 Markdown；MarkItDown 没装或被停用时抛 `markItDownUnavailable`。 */
  toMarkdown(input: OfficeMarkdownInput, ctx: OfficeOperationContext): Promise<OfficeMarkdown>
}

export class OfficeMarkdownOperations implements OfficeMarkdownOperationsApi {
  /** 命令输出窗口把开头丢掉时给模型的抬头；不写它，模型会把文档结尾当成开头读。 */
  private static readonly OutputWindowTruncatedNotice =
    '<!-- 以下是文档的结尾部分：完整输出超过宿主的命令输出窗口，开头已被丢弃。需要完整内容请传 outputPath 写入文件后再读。 -->'

  constructor(
    private readonly workspace: OfficeWorkspaceApi,
    private readonly locator: MarkItDownLocatorApi
  ) {}

  public async toMarkdown(
    input: OfficeMarkdownInput,
    ctx: OfficeOperationContext
  ): Promise<OfficeMarkdown> {
    ctx.abortSignal.throwIfAborted()
    const maxChars = input.maxChars ?? OfficeTuning.markdown.returnChars
    const inputPath = await this.workspace.resolveInput(
      ctx,
      input.inputPath,
      OfficeMarkItDownInputExtensions
    )
    const launch = this.locateMarkItDown(ctx)
    if (!launch) throw markItDownUnavailableError()
    if (input.outputPath)
      return this.runToFile({
        ctx,
        launch,
        inputPath,
        outputPath: input.outputPath,
        overwrite: input.overwrite,
        maxChars,
      })
    return this.runToStdout({ ctx, launch, inputPath, maxChars })
  }

  /** 宿主的插件状态优先；宿主没实现这个端口方法时回落到只按平台约定推导资源根的缺省定位器。 */
  private locateMarkItDown(ctx: OfficeOperationContext): Nullable<MarkItDownLaunchSpec> {
    return ctx.office.locateMarkItDown ? ctx.office.locateMarkItDown() : this.locator.resolve()
  }

  /** 让 MarkItDown 把结果打到 stdout，再按 maxChars 截断交回。 */
  private async runToStdout(input: {
    ctx: OfficeOperationContext
    launch: MarkItDownLaunchSpec
    inputPath: string
    maxChars: number
  }): Promise<OfficeMarkdown> {
    const nativeCommand = buildMarkItDownCommand({
      launch: input.launch,
      inputPath: input.inputPath,
    })
    const commandResult = await input.ctx.office.runCommand(nativeCommand, {
      description: describeOfficeNativeCommand(nativeCommand),
      cwd: this.workspace.rootPath(input.ctx),
      timeoutMs: OfficeTuning.command.markItDownTimeoutMs,
      maxOutputChars: input.maxChars + OfficeTuning.markdown.stdoutHeadroomChars,
    })
    if (!commandResult.success) throw conversionFailedError('MarkItDown 转换 ', commandResult)

    const limited = truncateMarkdown(commandResult.stdout ?? '', input.maxChars)
    // 宿主的命令输出窗口**保留结尾**：长文档这里拿到的是文档末尾，而截断发生在 stdout 这一层，
    // 只看 maxChars 的那一步会一路报 truncated=false，模型于是把结尾当开头读（2026-09-16 实测）。
    if (!commandResult.truncated)
      return { path: input.inputPath, markdown: limited.markdown, truncated: limited.truncated }
    return {
      path: input.inputPath,
      markdown: `${OfficeMarkdownOperations.OutputWindowTruncatedNotice}\n\n${limited.markdown}`,
      truncated: true,
    }
  }

  /** 让 MarkItDown 写临时文件，再把完整内容落到工作区里，交回的只带截断后的前若干字符。 */
  private async runToFile(input: {
    ctx: OfficeOperationContext
    launch: MarkItDownLaunchSpec
    inputPath: string
    outputPath: string
    overwrite?: boolean
    maxChars: number
  }): Promise<OfficeMarkdown> {
    const tempDir = await mkdtemp(join(tmpdir(), 'velaros-office-markitdown-'))
    const tempOutputPath = join(
      tempDir,
      `${basename(input.inputPath, extname(input.inputPath)) || 'document'}.md`
    )

    try {
      const nativeCommand = buildMarkItDownCommand({
        launch: input.launch,
        inputPath: input.inputPath,
        outputPath: tempOutputPath,
      })
      const commandResult = await input.ctx.office.runCommand(nativeCommand, {
        description: describeOfficeNativeCommand(nativeCommand),
        cwd: this.workspace.rootPath(input.ctx),
        timeoutMs: OfficeTuning.command.markItDownTimeoutMs,
        maxOutputChars: OfficeTuning.command.outputChars,
      })
      if (!commandResult.success) throw conversionFailedError('MarkItDown 转换 ', commandResult)

      const output = await this.workspace.prepareOutput(
        input.ctx,
        input.outputPath,
        '.md',
        input.overwrite
      )
      const markdown = await readFile(tempOutputPath, 'utf8')
      const written = await writeOfficeFile(output, markdown)
      const limited = truncateMarkdown(markdown, input.maxChars)
      return {
        path: input.inputPath,
        markdown: limited.markdown,
        truncated: limited.truncated,
        written,
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(
        () => undefined /* arch-guard:silent-catch-ok 尽力清理临时目录，删除失败非致命 */
      )
    }
  }
}

/** 整个进程共用的 Markdown 转换操作。 */
export const officeMarkdownOperations: OfficeMarkdownOperationsApi = new OfficeMarkdownOperations(
  officeWorkspace,
  createMarkItDownLocator()
)
