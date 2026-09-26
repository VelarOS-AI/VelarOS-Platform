/** 路径与落盘原语：工作区包含判断、扩展名归一、文件探测、产物写出与临时产物定位。 */

import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'

import { isPlainObject } from '@velaros-ai/core'
import { currentPlatform } from '@velaros-ai/core/platform'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'

import { OfficeErrorCodes } from '../contract/constants.js'
import type { OfficeWordInput, OfficeWritten } from '../types/office.js'

import { officeError } from './errors.js'

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
 * 判据（§5.3b ④安全门）——这是整个 office 能力**唯一**的路径包含门：所有操作的读写路径
 * 都必须先经 `normalizeExtensionPath` / 输入路径解析落到这里。
 * 挡的是 `../` 穿越与绝对路径逃逸——注意入参允许绝对路径（用户经常直接粘），所以不能靠
 * "是否相对路径"判断，必须 **resolve 之后再算相对关系**。
 * 绕过它写盘 = 模型可以往用户主目录任意位置落文件，因此新增写入路径的操作一律走上面两个入口，
 * 不要自己 `resolve` 完就用。
 */
export async function assertOfficePathInsideProject(
  rootPath: string,
  resolvedPath: string,
  originalPath: string
): Promise<void> {
  if (!(await isOfficePathInsideProject(rootPath, resolvedPath))) {
    throw officeError(
      OfficeErrorCodes.pathOutsideProject,
      `路径出了工作区根（按解开符号链接后的真实路径算）：${originalPath}`
    )
  }
}

/** 解析输出路径并强制扩展名，最终保证路径仍在工作区内。 */
export async function normalizeExtensionPath(
  rootPath: string,
  outputPath: string,
  extension: string
): Promise<string> {
  const trimmedPath = outputPath.trim()
  if (!trimmedPath) throw officeError('VALIDATION', '输出路径不能为空。')

  // 相对路径以工作区 root 为基准，绝对路径也必须最终落在 root 内。
  const basePath = isAbsolute(trimmedPath) ? resolve(trimmedPath) : resolve(rootPath, trimmedPath)
  const currentExtension = extname(basePath).toLowerCase()

  // 用户显式给了错误扩展名时直接拒绝，避免生成文件类型和路径不一致。
  if (currentExtension && currentExtension !== extension) {
    throw officeError(
      OfficeErrorCodes.invalidExtension,
      `输出文件的扩展名要是 ${extension}（不写扩展名会自动补上）：${outputPath}`
    )
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
    throw officeError('VALIDATION', `目标路径不是文件：${outputPath}`)
  }
  // 覆盖必须显式声明。
  if (existing && !overwrite) {
    throw officeError(
      OfficeErrorCodes.outputExists,
      `文件已经在了，要覆盖就传 overwrite: true：${outputPath}`
    )
  }
  // 父目录不存在时自动创建。
  await mkdir(dirname(resolvedPath), { recursive: true })
  return { path: resolvedPath, created: !existing }
}

/** 准备 Word 输出路径；appendMode 可在已有 docx 后追加内容，此时不要求 overwrite。 */
export async function prepareWordDocumentOutputPath(
  rootPath: string,
  input: Pick<OfficeWordInput, 'outputPath' | 'overwrite' | 'appendMode'>
): Promise<{ path: string; created: boolean; append: boolean }> {
  const resolvedPath = await normalizeExtensionPath(rootPath, input.outputPath, '.docx')
  const existing = await getFileStats(resolvedPath)
  if (existing && !existing.isFile())
    throw officeError('VALIDATION', `目标路径不是文件：${input.outputPath}`)
  await mkdir(dirname(resolvedPath), { recursive: true })
  // appendMode 只在目标文件已存在时生效。
  if (input.appendMode && existing) return { path: resolvedPath, created: false, append: true }
  if (existing && !input.overwrite)
    throw officeError(
      OfficeErrorCodes.outputExists,
      `文件已经在了，要覆盖就传 overwrite: true，要接在后面就传 appendMode: true：${input.outputPath}`
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
  if (!trimmedPath) throw officeError('VALIDATION', '输入路径不能为空。')

  // 输入文件同样必须在工作区内。
  const resolvedPath = isAbsolute(trimmedPath)
    ? resolve(trimmedPath)
    : resolve(rootPath, trimmedPath)
  const currentExtension = extname(resolvedPath).toLowerCase()
  // 多扩展名用于 PDF/Word 等转换场景。
  if (!extensions.includes(currentExtension)) {
    throw officeError(
      OfficeErrorCodes.invalidExtension,
      `输入文件的扩展名要是 ${extensions.join('、')} 之一：${inputPath}`
    )
  }

  await assertOfficePathInsideProject(rootPath, resolvedPath, inputPath)
  const existing = await getFileStats(resolvedPath)

  // 转换/编辑前必须确认输入文件存在。
  if (!existing?.isFile()) {
    throw officeError(OfficeErrorCodes.inputMissing, `输入文件不存在或不是文件：${inputPath}`)
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

/** 写入一个文件（二进制或文字）并交回写出的回执。 */
export async function writeOfficeFile(
  prepared: { path: string; created: boolean },
  data: Buffer | Uint8Array | string
): Promise<OfficeWritten> {
  await writeFile(prepared.path, data)
  return writtenReceipt(prepared)
}

/** 复制临时产物到最终输出路径并交回写出的回执。 */
export async function copyOfficeOutput(
  prepared: { path: string; created: boolean },
  sourcePath: string
): Promise<OfficeWritten> {
  await copyFile(sourcePath, prepared.path)
  return writtenReceipt(prepared)
}

/** 刚写下的文件的回执：路径、字节数、是不是新建的。 */
export async function writtenReceipt(prepared: {
  path: string
  created: boolean
}): Promise<OfficeWritten> {
  const fileStats = await stat(prepared.path)
  return { path: prepared.path, bytes: fileStats.size, created: prepared.created }
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
  const entries = await readdir(tempDir).catch(
    () => [] /* arch-guard:silent-catch-ok 临时目录不可读等价于没有产物，由调用方按 null 处理 */
  )
  const generatedEntry = entries.find(
    (entry) => extname(entry).toLowerCase() === normalizedExtension
  )
  return generatedEntry ? join(tempDir, generatedEntry) : null
}
