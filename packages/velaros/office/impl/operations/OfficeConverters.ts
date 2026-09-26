/**
 * 外部转换器操作：`OfficeConverters` 与整个进程唯一的 `officeConverters`。接口 `OfficeConvertersApi` 在本文件的类上方。
 * 发现并执行本机的 LibreOffice 与 LaTeX 编译器、把旧版 .doc 归一成临时 .docx、回收临时目录；
 * 命令一律只经原生 argv 交给宿主，本单元不拼 shell 串。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'

import { OfficeErrorCodes } from '../../contract/constants.js'
import type { OfficeOperationContext } from '../../contract/requires.js'
import type {
  LatexCompiler,
  NormalizedWordInput,
  OfficeEnvironmentCommandAvailability,
  OfficeNativeCommand,
  OfficeSystemCommandResult,
} from '../../types/office.js'
import { describeOfficeNativeCommand, libreOfficeCommandCandidates } from '../../utils/commands.js'
import { conversionFailedError, missingOutputError, officeError } from '../../utils/errors.js'
import { findGeneratedOfficeFile } from '../../utils/paths.js'
import { resolveLatexCompilerCandidates } from '../../utils/pdf/latex.js'
import { OfficeTuning } from '../../utils/tuning.js'
import { buildMacLibreOfficeFontConfig } from '../../utils/word/fonts.js'

/**
 * 外部转换器操作：谁在本机可用、怎么跑、跑完怎么收拾。执行一律走原生 argv；
 * 缺命令时由调用方抛 `OfficeErrorCodes.converterMissing`（`utils/errors.ts`），不静默失败。
 */
export interface OfficeConvertersApi {
  /** 按给定优先级顺序找第一个在本机可用的命令；都没有返回 null。 */
  findCommand(
    ctx: OfficeOperationContext,
    commands: string[]
  ): Promise<Nullable<OfficeEnvironmentCommandAvailability>>
  /** 找本机可用的 LibreOffice（soffice / libreoffice / macOS App 内的可执行文件）。 */
  findLibreOffice(
    ctx: OfficeOperationContext
  ): Promise<Nullable<OfficeEnvironmentCommandAvailability>>
  /** 按用户选择或 auto 策略找本机可用的 LaTeX 编译器。 */
  findLatexCompiler(
    ctx: OfficeOperationContext,
    compiler?: LatexCompiler
  ): Promise<Nullable<OfficeEnvironmentCommandAvailability>>
  /** 跑一条外部命令；输出窗口比宿主缺省宽，办公转换的日志才不至于被截光。 */
  runCommand(
    ctx: OfficeOperationContext,
    command: OfficeNativeCommand,
    cwd: string,
    timeoutMs?: number
  ): Promise<OfficeSystemCommandResult>
  /** 跑 LibreOffice；macOS 上顺带配一份可写的 Fontconfig 缓存，免得中日韩文本被换成别的字体。 */
  runLibreOffice(
    ctx: OfficeOperationContext,
    command: OfficeNativeCommand,
    cwd: string,
    timeoutMs?: number
  ): Promise<OfficeSystemCommandResult>
  /** 顺序跑 LaTeX 编译命令，遇到失败即停，把每轮结果都带回去。 */
  runLatexCompile(input: {
    ctx: OfficeOperationContext
    commands: OfficeNativeCommand[]
    cwd: string
  }): Promise<OfficeSystemCommandResult[]>
  /** 把旧版 .doc 归一化成临时 .docx；.docx 原样返回，其他扩展名拒绝；转换失败时先清掉临时目录再抛 `conversionFailed`。 */
  normalizeWordInput(input: {
    ctx: OfficeOperationContext
    inputPath: string
    libreOffice: OfficeEnvironmentCommandAvailability
    timeoutMs?: number
  }): Promise<NormalizedWordInput>
  /** 回收归一化旧版 .doc 时建的临时目录。 */
  cleanupNormalizedWordInput(input: NormalizedWordInput): Promise<void>
}

export class OfficeConverters implements OfficeConvertersApi {
  public async findCommand(
    ctx: OfficeOperationContext,
    commands: string[]
  ): Promise<Nullable<OfficeEnvironmentCommandAvailability>> {
    const inspection = await ctx.office.inspectEnvironment(commands)
    const byName = new Map(inspection.commands.map((command) => [command.name, command]))

    // 保持传入 commands 的优先级顺序，例如优先 soffice 再 libreoffice。
    for (const commandName of commands) {
      const command = byName.get(commandName)
      if (command?.available) return command
    }

    return null
  }

  public async findLibreOffice(
    ctx: OfficeOperationContext
  ): Promise<Nullable<OfficeEnvironmentCommandAvailability>> {
    return this.findCommand(ctx, libreOfficeCommandCandidates())
  }

  public async findLatexCompiler(
    ctx: OfficeOperationContext,
    compiler?: LatexCompiler
  ): Promise<Nullable<OfficeEnvironmentCommandAvailability>> {
    return this.findCommand(ctx, resolveLatexCompilerCandidates(compiler))
  }

  public async runCommand(
    ctx: OfficeOperationContext,
    command: OfficeNativeCommand,
    cwd: string,
    timeoutMs: number = OfficeTuning.command.timeoutMs
  ): Promise<OfficeSystemCommandResult> {
    return ctx.office.runCommand(command, {
      description: describeOfficeNativeCommand(command),
      cwd,
      timeoutMs,
      maxOutputChars: OfficeTuning.command.outputChars,
    })
  }

  public async runLibreOffice(
    ctx: OfficeOperationContext,
    command: OfficeNativeCommand,
    cwd: string,
    timeoutMs: number = OfficeTuning.command.libreOfficeTimeoutMs
  ): Promise<OfficeSystemCommandResult> {
    if (process.platform !== 'darwin') return this.runCommand(ctx, command, cwd, timeoutMs)
    const runtimeDir = await mkdtemp(join(tmpdir(), 'velaros-office-fontconfig-'))
    const cacheDir = join(runtimeDir, 'cache')
    const configPath = join(runtimeDir, 'fonts.conf')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(
      configPath,
      buildMacLibreOfficeFontConfig({ homeDir: homedir(), cacheDir }),
      'utf8'
    )
    const configured: OfficeNativeCommand = {
      ...command,
      env: { ...command.env, FONTCONFIG_FILE: configPath },
    }
    try {
      return await this.runCommand(ctx, configured, cwd, timeoutMs)
    } finally {
      await rm(runtimeDir, { recursive: true, force: true }).catch(
        () => undefined /* arch-guard:silent-catch-ok 临时字体缓存尽力清理 */
      )
    }
  }

  public async runLatexCompile(input: {
    ctx: OfficeOperationContext
    commands: OfficeNativeCommand[]
    cwd: string
  }): Promise<OfficeSystemCommandResult[]> {
    const results: OfficeSystemCommandResult[] = []
    for (const command of input.commands) {
      const result = await this.runCommand(
        input.ctx,
        command,
        input.cwd,
        OfficeTuning.command.latexRunTimeoutMs
      )
      results.push(result)
      if (!result.success) break
    }
    return results
  }

  public async normalizeWordInput(input: {
    ctx: OfficeOperationContext
    inputPath: string
    libreOffice: OfficeEnvironmentCommandAvailability
    timeoutMs?: number
  }): Promise<NormalizedWordInput> {
    const sourceExtension = extname(input.inputPath).toLowerCase()
    if (sourceExtension === '.docx')
      return {
        path: input.inputPath,
        originalPath: input.inputPath,
        sourceExtension,
        convertedFromLegacyDoc: false,
        tempDir: null,
      }

    if (sourceExtension !== '.doc') {
      throw officeError(
        OfficeErrorCodes.invalidExtension,
        `Word 输入文件的扩展名要是 .docx 或 .doc：${input.inputPath}`
      )
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'velaros-office-docx-normalize-'))
    const command: OfficeNativeCommand = {
      file: input.libreOffice.path || input.libreOffice.name,
      args: ['--headless', '--convert-to', 'docx', '--outdir', tempDir, input.inputPath],
    }
    const commandResult = await this.runLibreOffice(
      input.ctx,
      command,
      dirname(input.inputPath),
      input.timeoutMs ?? OfficeTuning.command.libreOfficeTimeoutMs
    )
    if (!commandResult.success) {
      await rm(tempDir, { recursive: true, force: true }).catch(
        () => undefined /* arch-guard:silent-catch-ok 尽力清理临时目录，删除失败非致命 */
      )
      throw conversionFailedError('把旧版 .doc 转成 .docx ', commandResult)
    }

    const generatedDocx = await findGeneratedOfficeFile(
      tempDir,
      `${basename(input.inputPath, extname(input.inputPath))}.docx`,
      '.docx'
    )
    if (!generatedDocx) {
      // 抛出去就没人认领这个临时目录了，先清掉，免得每失败一次就在系统临时目录留一个 velaros-office-docx-normalize-*。
      await rm(tempDir, { recursive: true, force: true }).catch(
        () => undefined /* arch-guard:silent-catch-ok 尽力清理临时目录，删除失败非致命 */
      )
      throw missingOutputError('把旧版 .doc 转成 .docx ', 'DOCX')
    }

    return {
      path: generatedDocx,
      originalPath: input.inputPath,
      sourceExtension,
      convertedFromLegacyDoc: true,
      tempDir,
      converter: input.libreOffice.name,
      conversionCommandResult: commandResult,
    }
  }

  public async cleanupNormalizedWordInput(input: NormalizedWordInput): Promise<void> {
    if (!input.tempDir) return
    await rm(input.tempDir, { recursive: true, force: true }).catch(
      () => undefined /* arch-guard:silent-catch-ok 尽力清理临时目录，删除失败非致命 */
    )
  }
}

/** 整个进程共用的外部转换器操作。 */
export const officeConverters: OfficeConvertersApi = new OfficeConverters()
