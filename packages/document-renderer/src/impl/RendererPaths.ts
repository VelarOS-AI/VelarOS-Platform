/**
 * 路径准入：三条路径（projectRoot、inputPath、outputPath）解开符号链接之后都必须仍在 projectRoot 内。
 *
 * 真实路径由 `@velaros-ai/core` 的 `resolveRealPath` 算（还不存在的输出路径会解析到最近一个存在的祖先，
 * 再把尚不存在的尾巴拼回去），包含判断由 `utils/paths.ts` 经 `@velaros-ai/platform` 做。
 *
 * 顺序是安全性的一部分：**先判定、后建目录**。反过来写的话，`outputPath` 经项目内的符号链接指向外面时，
 * 目录已经在 projectRoot 之外建出来了，回执才说 PATH_DENIED。
 */
import { mkdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

import { AppError } from '@velaros-ai/core'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'

import { DocumentRendererErrorCodes } from '../contract/constants.js'
import type { RendererPathRequest, RendererPathSet } from '../types/rendering.js'
import { assertPathInsideProjectRoot, isSymbolicLink } from '../utils/paths.js'

/**
 * 请求里三条路径的准入判定。实例是 `rendererPaths`，两种渲染都先过它，判定不通过一个字节都不落盘。
 */
export interface RendererPathsApi {
  /**
   * 把请求里的三条路径解成盘上的真实路径，顺带把输出目录建好。
   * 任何一条解析后落在 projectRoot 之外、或者 outputPath 本身是符号链接时，抛 PATH_DENIED，此时磁盘上一个目录都没建。
   */
  resolve: (request: RendererPathRequest) => Promise<RendererPathSet>
}

class RendererPaths implements RendererPathsApi {
  public async resolve(request: RendererPathRequest): Promise<RendererPathSet> {
    const projectRoot = await resolveRealPath(resolve(request.projectRoot))
    const requestedInput = resolve(projectRoot, request.inputPath)
    const requestedOutput = resolve(projectRoot, request.outputPath)

    const inputPath = await resolveRealPath(requestedInput)
    assertPathInsideProjectRoot(projectRoot, inputPath, 'inputPath')

    // 输出路径连同还不存在的尾巴一起解析后判定，磁盘上一个目录都还没建。
    const realOutput = await resolveRealPath(requestedOutput)
    assertPathInsideProjectRoot(projectRoot, realOutput, 'outputPath')
    if (await isSymbolicLink(requestedOutput)) {
      throw new AppError(DocumentRendererErrorCodes.pathDenied, 'outputPath 不能是符号链接。')
    }

    const realOutputDirectory = dirname(realOutput)
    await mkdir(realOutputDirectory, { recursive: true })
    // 建目录期间路径仍可能被换成链接（窗口极小），落盘前照真实路径再确认一次。
    assertPathInsideProjectRoot(projectRoot, await resolveRealPath(realOutputDirectory), 'outputPath')

    return {
      projectRoot,
      inputPath,
      outputPath: resolve(realOutputDirectory, basename(requestedOutput)),
    }
  }
}

/** 进程里的那一份路径准入。 */
export const rendererPaths: RendererPathsApi = new RendererPaths()
