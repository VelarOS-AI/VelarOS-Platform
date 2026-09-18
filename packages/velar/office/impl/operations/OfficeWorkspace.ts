/**
 * 工作区操作：`OfficeWorkspace` 与整个进程唯一的 `officeWorkspace`。接口 `OfficeWorkspaceApi` 在本文件的类上方。
 * 所有操作的读写路径都经它；路径包含门只有这一处，别处不要自己 resolve 完就用。
 */

import type { OfficeOperationContext } from '../../contract/requires.js'
import type { OfficeWordInput } from '../../types/office.js'
import {
  prepareOfficeOutputPath,
  prepareWordDocumentOutputPath,
  resolveInputPathWithExtensions,
} from '../../utils/paths.js'

/**
 * 工作区操作：回答「当前工作区根在哪」「这条路径能不能读写」，并把输出路径准备好（补扩展名、挡覆盖、建父目录）。
 * 写盘不问人（ADR 0009）：出了根一律拒绝，这就是全部边界。
 */
export interface OfficeWorkspaceApi {
  /** 当前工作区根的绝对路径；空间没有可用根时抛错。 */
  rootPath(ctx: OfficeOperationContext): string
  /** 准备输出路径：补齐/校验扩展名、按 overwrite 挡覆盖、建好父目录。 */
  prepareOutput(
    ctx: OfficeOperationContext,
    outputPath: string,
    extension: string,
    overwrite?: boolean
  ): Promise<{ path: string; created: boolean }>
  /** 准备 Word 输出路径；appendMode 命中已有文件时按追加处理，不要求 overwrite。 */
  prepareWordOutput(
    ctx: OfficeOperationContext,
    input: Pick<OfficeWordInput, 'outputPath' | 'overwrite' | 'appendMode'>
  ): Promise<{ path: string; created: boolean; append: boolean }>
  /** 解析输入路径：限制扩展名、确认文件存在，并保证真实路径仍在工作区内。 */
  resolveInput(
    ctx: OfficeOperationContext,
    inputPath: string,
    extensions: readonly string[]
  ): Promise<string>
}

export class OfficeWorkspace implements OfficeWorkspaceApi {
  public rootPath(ctx: OfficeOperationContext): string {
    return ctx.office.getRootPath()
  }

  public async prepareOutput(
    ctx: OfficeOperationContext,
    outputPath: string,
    extension: string,
    overwrite?: boolean
  ): Promise<{ path: string; created: boolean }> {
    return prepareOfficeOutputPath(this.rootPath(ctx), outputPath, extension, overwrite)
  }

  public async prepareWordOutput(
    ctx: OfficeOperationContext,
    input: Pick<OfficeWordInput, 'outputPath' | 'overwrite' | 'appendMode'>
  ): Promise<{ path: string; created: boolean; append: boolean }> {
    return prepareWordDocumentOutputPath(this.rootPath(ctx), input)
  }

  public async resolveInput(
    ctx: OfficeOperationContext,
    inputPath: string,
    extensions: readonly string[]
  ): Promise<string> {
    return resolveInputPathWithExtensions(this.rootPath(ctx), inputPath, extensions)
  }
}

/** 整个进程共用的工作区操作。 */
export const officeWorkspace: OfficeWorkspaceApi = new OfficeWorkspace()
