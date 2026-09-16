/**
 * 工作区操作：`OfficeWorkspace` 与整个进程唯一的 `officeWorkspace`。接口 `OfficeWorkspaceApi` 在本文件的类上方。
 * 所有工具的读写路径、写入授权与临时切目录都经它；路径包含门只有这一处，别处不要自己 resolve 完就用。
 */

import { resolve } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import type { OfficeToolContext } from '../../contract/requires.js'
import type { CreateWordDocumentInput } from '../../types/inputs.js'
import {
  isOfficePathInsideProject,
  prepareOfficeOutputPath,
  prepareWordDocumentOutputPath,
  resolveInputPathWithExtensions,
} from '../../utils/paths.js'
import { buildProjectMutationSkippedResult } from '../../utils/results.js'

/**
 * 工作区操作：回答「有没有可用的根」「这条路径能不能读写」「宿主批不批这次写入」，
 * 并在批准后把输出路径准备好（补扩展名、挡覆盖、建父目录）。
 */
export interface OfficeWorkspaceApi {
  /** 当前有没有可解析的执行根；没有根时所有 office 工具都不可用。 */
  hasRoot(ctx: OfficeToolContext): boolean
  /** 当前工作区根的绝对路径。 */
  rootPath(ctx: OfficeToolContext): string
  /** 在可选的 cwd 下执行一段操作；cwd 必须按真实路径仍落在当前工作区内，否则拒绝。 */
  runInDirectory<T>(
    ctx: OfficeToolContext,
    cwd: LooseOptional<string>,
    action: () => Promise<T>
  ): Promise<T>
  /** 写盘前向宿主申请授权：批准返回 null，被拒返回可以直接交给模型的跳过结果。 */
  authorizeMutation(
    ctx: OfficeToolContext,
    input: { cwd?: string; operation: string; targetPath: string }
  ): Promise<Nullable<Record<string, unknown>>>
  /** 准备输出路径：补齐/校验扩展名、按 overwrite 挡覆盖、建好父目录。 */
  prepareOutput(
    ctx: OfficeToolContext,
    outputPath: string,
    extension: string,
    overwrite?: boolean
  ): Promise<{ path: string; created: boolean }>
  /** 准备 Word 输出路径；appendMode 命中已有文件时按追加处理，不要求 overwrite。 */
  prepareWordOutput(
    ctx: OfficeToolContext,
    input: Pick<CreateWordDocumentInput, 'outputPath' | 'overwrite' | 'appendMode'>
  ): Promise<{ path: string; created: boolean; append: boolean }>
  /** 解析输入路径：限制扩展名、确认文件存在，并保证真实路径仍在工作区内。 */
  resolveInput(
    ctx: OfficeToolContext,
    inputPath: string,
    extensions: readonly string[]
  ): Promise<string>
}

export class OfficeWorkspace implements OfficeWorkspaceApi {
  public hasRoot(ctx: OfficeToolContext): boolean {
    try {
      return !!ctx.office.getRootPath()
    } catch {
      // arch-guard:silent-catch-ok 无任何可用根（未激活工作区）时执行根解析会抛错，等价于"工具不可用"，不是故障。
      return false
    }
  }

  public rootPath(ctx: OfficeToolContext): string {
    return ctx.office.getRootPath()
  }

  /**
   * 判据（§5.3b ④安全门）：`cwd` 不是「顺便换个目录」，宿主实现会把它当成**新的执行根**
   * （Desktop 的 `runInDirectory` 走 root override），下面所有路径包含判断随之以它为准。
   * 所以进宿主之前先按真实路径确认它仍在当前工作区内：只读工具从不请求授权，不挡这一下，
   * 一个根外的 `cwd` 就能让 `extract_pdf_text` / `preview_document` /
   * `convert_document_to_markdown` 读到工作区外的文件（2026-09-16 实测）。
   * 写工具的授权在这之前跑，宿主批准的「切换到外部目录」会先把根换过去，合法流程不受影响。
   */
  public async runInDirectory<T>(
    ctx: OfficeToolContext,
    cwd: LooseOptional<string>,
    action: () => Promise<T>
  ): Promise<T> {
    if (!cwd) return action()
    if (!(await isOfficePathInsideProject(this.rootPath(ctx), resolve(cwd))))
      throw new AppError(
        'PERMISSION',
        `工作目录超出工作区范围：${cwd}。去掉 cwd 让工具在当前工作区内执行，或先切换到该目录所属的工作区。`
      )
    // 宿主负责临时切换目录并恢复。
    return ctx.office.runInDirectory(cwd, action)
  }

  public async authorizeMutation(
    ctx: OfficeToolContext,
    input: { cwd?: string; operation: string; targetPath: string }
  ): Promise<Nullable<Record<string, unknown>>> {
    const authorization = await ctx.office.prepareMutation(input)
    return authorization.approved ? null : buildProjectMutationSkippedResult(authorization)
  }

  public async prepareOutput(
    ctx: OfficeToolContext,
    outputPath: string,
    extension: string,
    overwrite?: boolean
  ): Promise<{ path: string; created: boolean }> {
    return prepareOfficeOutputPath(this.rootPath(ctx), outputPath, extension, overwrite)
  }

  public async prepareWordOutput(
    ctx: OfficeToolContext,
    input: Pick<CreateWordDocumentInput, 'outputPath' | 'overwrite' | 'appendMode'>
  ): Promise<{ path: string; created: boolean; append: boolean }> {
    return prepareWordDocumentOutputPath(this.rootPath(ctx), input)
  }

  public async resolveInput(
    ctx: OfficeToolContext,
    inputPath: string,
    extensions: readonly string[]
  ): Promise<string> {
    return resolveInputPathWithExtensions(this.rootPath(ctx), inputPath, extensions)
  }
}

/** 整个进程共用的工作区操作。 */
export const officeWorkspace: OfficeWorkspaceApi = new OfficeWorkspace()
