/**
 * 路径准入：三条路径（projectRoot、inputPath、outputPath）解开符号链接之后都必须仍在 projectRoot 内。
 *
 * 判定用公共件：真实路径由 `@velaros-ai/core` 的 `resolveRealPath` 算（还不存在的输出路径会解析到最近一个
 * 存在的祖先，再把尚不存在的尾巴拼回去），包含判断由 `@velaros-ai/platform` 的 `isPathTextInside` 做
 * （带分隔符边界，名字以 `..` 开头的目录照常算在里面）。
 *
 * 顺序是安全性的一部分：**先判定、后建目录**。反过来写的话，`outputPath` 经项目内的符号链接指向外面时，
 * 目录已经在 projectRoot 之外建出来了，回执才说 PATH_DENIED。
 */
import { lstat, mkdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

import { readErrnoCode } from '@velaros-ai/core'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'
import { currentPlatform } from '@velaros-ai/platform'

export class RendererPathDeniedError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'RendererPathDeniedError'
  }
}

/** 真实路径是盘上的写法，按字面比大小写：同一个物理文件的别名不许绕过判定。 */
function isInside(root: string, target: string): boolean {
  return currentPlatform.isPathTextInside(target, root, { caseSensitive: true })
}

function requireInside(root: string, target: string, label: string): void {
  if (!isInside(root, target)) {
    throw new RendererPathDeniedError(`${label} 解析后落在 projectRoot 之外。`)
  }
}

export async function resolveRendererPaths(input: {
  readonly projectRoot: string
  readonly inputPath: string
  readonly outputPath: string
}): Promise<{ projectRoot: string; inputPath: string; outputPath: string }> {
  const projectRoot = await resolveRealPath(resolve(input.projectRoot))
  const requestedInput = resolve(projectRoot, input.inputPath)
  const requestedOutput = resolve(projectRoot, input.outputPath)

  const inputPath = await resolveRealPath(requestedInput)
  requireInside(projectRoot, inputPath, 'inputPath')

  // 输出路径连同还不存在的尾巴一起解析后判定，磁盘上一个目录都还没建。
  const realOutput = await resolveRealPath(requestedOutput)
  requireInside(projectRoot, realOutput, 'outputPath')
  if (await isSymbolicLink(requestedOutput)) {
    throw new RendererPathDeniedError('outputPath 不能是符号链接。')
  }

  const realOutputDirectory = dirname(realOutput)
  await mkdir(realOutputDirectory, { recursive: true })
  // 建目录期间路径仍可能被换成链接（窗口极小），落盘前照真实路径再确认一次。
  requireInside(projectRoot, await resolveRealPath(realOutputDirectory), 'outputPath')

  return {
    projectRoot,
    inputPath,
    outputPath: resolve(realOutputDirectory, basename(requestedOutput)),
  }
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch (error) {
    if (readErrnoCode(error) === 'ENOENT') return false
    throw error
  }
}
