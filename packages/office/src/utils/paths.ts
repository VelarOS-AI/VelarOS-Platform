/** 路径与落盘原语：工作区包含判断、扩展名归一、文件探测、产物写出与临时产物定位。 */

import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'

import { isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'
import { currentPlatform } from '@velaros-ai/platform'

import type { CreateWordDocumentInput } from '../types/inputs.js'
import type { OfficeOutput } from '../types/workspace.js'

/**
 * 真实路径意义上的「在不在根里」。
 *
 * **按真实路径判，不按字面路径判**（`resolveRealPath`）：工作区里一个指向根外的符号链接，
 * 字面路径怎么看都在根内，写下去却落在根外；目标是已存在的链接文件时 `writeFile` 还会顺着
 * 它覆盖根外的原文件（2026-09-16 实测：根里建 `link → ../outside`，
 * `create_spreadsheet({ outputPath: 'link/escaped.xlsx' })` 成功写到了根外）。两边都要解：
 * 根本身也可能是符号链接（macOS 的 `/tmp` → `/private/tmp`），只解一边会把合法路径判成越界。
 */
export async function isOfficePathInsideProject(
  rootPath: string,
  candidatePath: string
): Promise<boolean> {
  const [realRootPath, realCandidatePath] = await Promise.all([
    resolveRealPath(rootPath),
    resolveRealPath(candidatePath),
  ])
  return currentPlatform.isPathTextInside(realCandidatePath, realRootPath)
}

/**
 * 确认 Office 输入/输出路径位于工作区内。
 *
 * 判据（§5.3b ④安全门）——这是整个 office 能力**唯一**的路径包含门：所有工具的读写路径
 * 都必须先经 `normalizeExtensionPath` / 输入路径解析落到这里。
 * 挡的是 `../` 穿越与绝对路径逃逸——注意入参允许绝对路径（用户经常直接粘），所以不能靠
 * "是否相对路径"判断，必须 **resolve 之后再算相对关系**。
 * 绕过它写盘 = 模型可以往用户主目录任意位置落文件，因此新增写入路径的工具一律走上面两个入口，
 * 不要自己 `resolve` 完就用。
 */
export async function assertOfficePathInsideProject(
  rootPath: string,
  resolvedPath: string,
  originalPath: string
): Promise<void> {
  if (!(await isOfficePathInsideProject(rootPath, resolvedPath))) {
    throw new AppError('PERMISSION', `路径超出工作区范围：${originalPath}`)
  }
}

/** 解析输出路径并强制扩展名，最终保证路径仍在工作区内。 */
export async function normalizeExtensionPath(
  rootPath: string,
  outputPath: string,
  extension: string
): Promise<string> {
  const trimmedPath = outputPath.trim()
  if (!trimmedPath) throw new AppError('VALIDATION', '输出路径不能为空。')

  // 相对路径以工作区 root 为基准，绝对路径也必须最终落在 root 内。
  const basePath = isAbsolute(trimmedPath) ? resolve(trimmedPath) : resolve(rootPath, trimmedPath)
  const currentExtension = extname(basePath).toLowerCase()

  // 用户显式给了错误扩展名时直接拒绝，避免生成文件类型和路径不一致。
  if (currentExtension && currentExtension !== extension) {
    throw new AppError('VALIDATION', `输出文件扩展名必须是 ${extension}。`)
  }

  const resolvedPath = currentExtension ? basePath : `${basePath}${extension}`
  // 最后统一做工作区包含关系和内部目录保护。
  await assertOfficePathInsideProject(rootPath, resolvedPath, outputPath)

  return resolvedPath
}

/** 准备 Office 输出路径：校验扩展名、覆盖策略并创建父目录。 */
export async function prepareOfficeOutputPath(
  rootPath: string,
  outputPath: string,
  extension: string,
  overwrite?: boolean
): Promise<{ path: string; created: boolean }> {
  const resolvedPath = await normalizeExtensionPath(rootPath, outputPath, extension)
  const existing = await getFileStats(resolvedPath)
  // 目标存在但不是普通文件时拒绝，避免覆盖目录或特殊文件。
  if (existing && !existing.isFile()) {
    throw new AppError('VALIDATION', `目标路径不是文件：${outputPath}`)
  }
  // 覆盖必须显式声明。
  if (existing && !overwrite) {
    throw new AppError(
      'VALIDATION',
      `文件已存在，覆盖写入需要显式设置 overwrite=true：${outputPath}`
    )
  }
  // 父目录不存在时自动创建。
  await mkdir(dirname(resolvedPath), { recursive: true })
  return { path: resolvedPath, created: !existing }
}

/** 准备 Word 输出路径；appendMode 可在已有 docx 后追加内容，此时不要求 overwrite。 */
export async function prepareWordDocumentOutputPath(
  rootPath: string,
  input: Pick<CreateWordDocumentInput, 'outputPath' | 'overwrite' | 'appendMode'>
): Promise<{ path: string; created: boolean; append: boolean }> {
  const resolvedPath = await normalizeExtensionPath(rootPath, input.outputPath, '.docx')
  const existing = await getFileStats(resolvedPath)
  if (existing && !existing.isFile())
    throw new AppError('VALIDATION', `目标路径不是文件：${input.outputPath}`)
  await mkdir(dirname(resolvedPath), { recursive: true })
  // appendMode 只在目标文件已存在时生效。
  if (input.appendMode && existing) return { path: resolvedPath, created: false, append: true }
  if (existing && !input.overwrite)
    throw new AppError(
      'VALIDATION',
      `文件已存在，覆盖写入需要显式设置 overwrite=true：${input.outputPath}`
    )
  return { path: resolvedPath, created: !existing, append: false }
}

/** 解析输入路径并限制允许的扩展名；最终路径仍必须落在工作区内。 */
export async function resolveInputPathWithExtensions(
  rootPath: string,
  inputPath: string,
  extensions: readonly string[]
): Promise<string> {
  const trimmedPath = inputPath.trim()
  if (!trimmedPath) throw new AppError('VALIDATION', '输入路径不能为空。')

  // 输入文件同样必须在工作区内。
  const resolvedPath = isAbsolute(trimmedPath) ? resolve(trimmedPath) : resolve(rootPath, trimmedPath)
  const currentExtension = extname(resolvedPath).toLowerCase()
  // 多扩展名用于 PDF/Word 等转换场景。
  if (!extensions.includes(currentExtension)) {
    throw new AppError('VALIDATION', `输入文件扩展名必须是 ${extensions.join(' 或 ')}。`)
  }

  await assertOfficePathInsideProject(rootPath, resolvedPath, inputPath)
  const existing = await getFileStats(resolvedPath)

  // 转换/编辑前必须确认输入文件存在。
  if (!existing?.isFile()) {
    throw new AppError('VALIDATION', `输入文件不存在或不是文件：${inputPath}`)
  }

  return resolvedPath
}

/** stat 包装；文件不存在时不抛错，其他错误继续抛出。 */
export async function getFileStats(
  path: string
): Promise<Nullable<Awaited<ReturnType<typeof stat>>>> {
  try {
    return await stat(path)
  } catch (error) {
    if (isPlainObject(error) && error.code === 'ENOENT') return null
    throw error
  }
}

/** 写入 Office 二进制 Buffer 并返回统一输出结构。 */
export async function writeOfficeBuffer(
  prepared: { path: string; created: boolean },
  data: Buffer | Uint8Array,
  kind: OfficeOutput['kind']
): Promise<OfficeOutput> {
  await writeFile(prepared.path, data)
  const fileStats = await stat(prepared.path)
  return {
    path: prepared.path,
    bytes: fileStats.size,
    created: prepared.created,
    changed: true,
    kind,
  }
}

/** 复制临时产物到最终 Office 输出路径。 */
export async function copyOfficeOutput(
  prepared: { path: string; created: boolean },
  sourcePath: string,
  kind: OfficeOutput['kind']
): Promise<OfficeOutput> {
  await copyFile(sourcePath, prepared.path)
  const fileStats = await stat(prepared.path)
  return {
    path: prepared.path,
    bytes: fileStats.size,
    created: prepared.created,
    changed: true,
    kind,
  }
}

/** 在临时目录里查找预期 PDF；找不到时回退任意 PDF 文件。 */
export async function findGeneratedPdf(
  tempDir: string,
  expectedName: string
): Promise<Nullable<string>> {
  return findGeneratedOfficeFile(tempDir, expectedName, '.pdf')
}

/** 在临时目录里查找某类 Office 转换产物；找不到预期文件名时回退任意同扩展名文件。 */
export async function findGeneratedOfficeFile(
  tempDir: string,
  expectedName: string,
  extension: string
): Promise<Nullable<string>> {
  const normalizedExtension = extension.startsWith('.') ? extension.toLowerCase() : `.${extension}`
  const expectedPath = join(tempDir, expectedName)
  const expectedStats = await getFileStats(expectedPath)
  if (expectedStats?.isFile()) return expectedPath

  // 有些外部工具会改变输出文件名，兜底找目录里的第一个同类产物。
  const entries = await readdir(tempDir).catch(() => [] /* arch-guard:silent-catch-ok 临时目录不可读等价于没有产物，由调用方按 null 处理 */)
  const generatedEntry = entries.find(
    (entry) => extname(entry).toLowerCase() === normalizedExtension
  )
  return generatedEntry ? join(tempDir, generatedEntry) : null
}
