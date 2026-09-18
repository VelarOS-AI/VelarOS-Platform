/**
 * 写一个文件之前的规划：把改法定下来但不写、不问人。返回写入计划，或者这个文件的问题（整批失败时逐条列给模型）。
 */

import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isPresent, isString, Log, readErrnoCode } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { textCodec } from '@velaros-ai/text-files'

import { FileLimits } from '../contract/constants.js'
import type { FileEditPlan, FileEditProblem } from '../types/edit.js'
import type { FileEditItem, FileLocation } from '../types/files.js'
import type { FileTextContent } from '../types/text.js'

import { staleProblem } from './batch.js'
import { applyLineEdits, joinLines, lineCount, splitLines, toFileNewlines } from './lines.js'
import { fileVersionOf, readTextFile, stampOf } from './text-file.js'

const log = Log.tag('FilePlan')

/**
 * 把一个文件的改法定下来但不写：文件系统操作都对 target，回执与报错里的路径用 location.path。
 * 已有的文件整份读进来（不超过 20 MB）：按行号改要正文，整份写要它的编码与换行风格，核版本要它的字节；不超过 2 MB 的原文留着给撤回。
 * 写出去的字节按原编码编，GB18030 里没改的片段沿用原字节（同一个字可能有两种写法）；写出去超过 20 MB 的不写——那样的文件之后读不了也改不了。
 */
export async function planFileEdit(index: number, location: FileLocation, item: FileEditItem): Promise<FileEditPlan | FileEditProblem> {
  const { path, target, linked } = location
  const problem = (message: string, extra: Partial<FileEditProblem> = {}): FileEditProblem => ({ file: index, path, reason: 'invalid', message, ...extra })
  const byLines = isPresent(item.edits)
  const wholeFile = isPresent(item.newText)
  if (byLines === wholeFile) return problem(byLines ? 'edits 与 newText 只能用一种' : '给 edits 按行号改几处，或者给 newText 整份写，两者选一')
  if (wholeFile && !isString(item.newText)) return problem('newText 要是字符串')
  if (byLines && !isString(item.version)) return problem('按行号改（edits）要带上 read 给的 version：行号只在那一版上成立')
  const existing = await stat(target).catch(() => null)
  if (existing?.isDirectory()) return problem(`路径是目录，不是文件：${path}`)
  // 管道、设备、套接字：读它可能永远等不到数据（读命名管道会一直挂着），整个替换又会把它换成普通文件，一律不碰。
  if (existing && !existing.isFile()) return problem(`路径不是普通文件（管道、设备或套接字），不能当文本改：${path}`)
  // 原子替换是写一个新文件再改名：多个硬链接的文件换完就和其余链接分家了，一律不碰。
  if (existing && existing.nlink > 1) return problem(`文件有 ${existing.nlink} 个硬链接，原子替换会让它和其余链接分家，不能在这里改：${path}；用命令改`)
  if (existing && existing.size > FileLimits.fileBytes) return problem(`现有文件太大，不能在这里改：${existing.size} 字节，上限 ${FileLimits.fileBytes} 字节；用命令就地改（sed -i、awk）`)
  if (byLines && !existing) return problem(`文件不存在：${path}；新建文件用 newText`)
  const stamp = stampOf(existing)
  // 父路径已经存在却不是目录，写入注定失败，在计划期就报出来（缺失的父目录落盘时会补建）。
  const parentCode = await stat(dirname(target)).then((parent) => (parent.isDirectory() ? null : 'ENOTDIR')).catch((error: unknown) => readErrnoCode(error))
  if (parentCode === 'ENOTDIR') return problem(`上级路径不是目录：${dirname(path)}`)

  // 已有的文件必须是文本才许改：二进制文件被整份覆盖就没了，按行号改也无从谈起。
  let original: Nullable<FileTextContent> = null
  if (existing) {
    try {
      original = await readTextFile(target, path)
    } catch (error) {
      const failure = AppError.from(error)
      log.debug('an existing file cannot be edited as text', { code: failure.code })
      return problem(`现有文件不能当文本改（${failure.message}）；二进制文件用命令替换`, { reason: failure.code === 'PERMISSION' ? 'denied' : 'invalid' })
    }
  }
  const baseVersion = original ? fileVersionOf(original.buffer) : null
  const stale = staleProblem(item.version, baseVersion)
  if (stale) return problem(stale.message, stale)

  let content: string
  if (byLines) {
    const edited = applyLineEdits(splitLines(original!.content), item.edits)
    if (isString(edited)) return problem(edited)
    content = joinLines(edited)
  } else {
    // 新文件照写；已有的文件按它原来的换行风格存（模型一律写 \n）。
    content = original ? toFileNewlines(item.newText!, splitLines(original.content).eol) : item.newText!
  }
  if (content.includes('\0') && !original?.content.includes('\0')) return problem('新内容里有 NUL 字节，是二进制数据，不能当文本写入')
  // 按原编码写不出来（孤立代理项、GB18030 表示不了的字符）就是这个文件的问题，整批不写，不静默换成替换字符或别的编码。
  let bytes: Buffer
  try {
    bytes = original ? textCodec.encodePreserving(original.buffer, original.content, content, original.encoding) : textCodec.encode(content, 'utf8')
  } catch (error) {
    return problem(`新内容不能按 ${original?.encoding ?? 'utf8'} 无损写进这个文件：${AppError.from(error).message}`)
  }
  if (bytes.byteLength > FileLimits.fileBytes) return problem(`写出去有 ${bytes.byteLength} 字节，超过 ${FileLimits.fileBytes} 字节的上限：这样的文件之后读不了、也改不了；更大的文件用命令生成`)
  const plan: FileEditPlan = { index, path, target, linked, created: !existing, bytes, totalLines: lineCount(content), baseVersion, stamp }
  // 撤回要原文：新建的记 null；已有的不超过上限才留，更大的不留（缺席），这次改动就撤不回。
  if (!original) plan.previous = null
  else if (original.buffer.byteLength <= FileLimits.undoBytes) plan.previous = original.buffer
  return plan
}
