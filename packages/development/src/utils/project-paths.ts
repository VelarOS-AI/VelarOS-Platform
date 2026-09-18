import nodePath from 'node:path'

import { AppError } from '@velaros-ai/core'
import { currentPlatform } from '@velaros-ai/core/platform'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'

/**
 * 路径文本是否落在根目录里（含根本身）。
 *
 * 判定交给 platform 的路径文本包含判断：它带分隔符边界（`/project-evil/x` 这种兄弟目录不算在内）、
 * 折叠 `.` 与 `..`，**名字以 `..` 开头的目录照常算在里面**（`relative().startsWith('..')` 的老写法
 * 会把项目里的 `..cache/x.ts` 误判成越界）。两端按字面比大小写：进来的路径要么已经 `resolve` 过、
 * 要么是 realpath 的结果。
 */
export function isPathTextInsideRoot(rootPath: string, absolutePath: string): boolean {
  return currentPlatform.isPathTextInside(absolutePath, rootPath, { caseSensitive: true })
}

/**
 * 解析项目内的文件或目录；项目根本身合法，相对路径以 `.` 表示。
 *
 * 越界判定按**真实路径**做：只比字面路径的话，项目内一个指向外面的符号链接就能让语言查询读到工作区外的源码。
 * 返回的 `absolutePath` / `relativePath` 仍按字面写法给（下游的只读端口按项目相对路径取文件）。
 */
export async function resolveProjectPath(
  rootPath: string,
  inputPath: string
): Promise<{ absolutePath: string; relativePath: string }> {
  const absolutePath = nodePath.resolve(rootPath, inputPath)
  if (!(await isRealPathInsideRoot(rootPath, absolutePath))) {
    throw new AppError('VALIDATION', `路径在项目之外：${inputPath}`)
  }
  return {
    absolutePath,
    relativePath: normalizeSeparators(nodePath.relative(rootPath, absolutePath)) || '.',
  }
}

/** 解析项目内文件的**真实路径**，越界就拒；外部语言服务按真实路径打开文档，所以要的是 realpath。 */
export async function resolveProjectRealPath(rootPath: string, inputPath: string): Promise<string> {
  const realRoot = await resolveRealPath(nodePath.resolve(rootPath))
  const candidate = await resolveRealPath(nodePath.resolve(realRoot, inputPath))
  if (!isPathTextInsideRoot(realRoot, candidate)) {
    throw new AppError('VALIDATION', `诊断路径越出了项目边界：${inputPath}`)
  }
  return candidate
}

/** 目标的真实路径是否仍落在项目根的真实路径里。 */
async function isRealPathInsideRoot(rootPath: string, absolutePath: string): Promise<boolean> {
  const realRoot = await resolveRealPath(nodePath.resolve(rootPath))
  const realTarget = await resolveRealPath(absolutePath)
  return isPathTextInsideRoot(realRoot, realTarget)
}

/** 把路径分隔符统一成 `/`，并去掉开头的 `./`；对外给出的相对路径一律是这个写法。 */
export function normalizeSeparators(input: string): string {
  return input.replace(/\\/gu, '/').replace(/^\.\//u, '')
}
