/**
 * 写之前的规划：把一次 edit 的每一步在内存里按顺序改好，定下每个文件要写的字节，但不写、不问人。
 * 同一个文件的几步接着改：第一次碰到它时开一份底稿（已有的读进来），之后每一步改底稿，最后编成写入计划。
 * 写不下去的地方返回问题（整批失败时逐条列给模型）。
 */

import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  isBlank,
  isEmpty,
  isNull,
  isString,
  Log,
  readErrnoCode,
  toNullable,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { textCodec } from '@velaros-ai/core/text-files'

import { FileLimits } from '../contract/constants.js'
import type { FileEditDraft, FileEditPlan, FileEditProblem } from '../types/edit.js'
import type { FileEditStep, FileLocation } from '../types/files.js'
import type { FileTextContent } from '../types/text.js'

import { lineCount, splitLines, toFileNewlines, wholeText } from './lines.js'
import { replaceOnce } from './replace.js'
import { fileVersionOf, readTextFile, stampOf } from './text-file.js'

const log = Log.tag('FilePlan')

/** 核对一步的形状并取出来：入参来自模型的程序，形状不保证。合法交回这一步，不合法交回一句说明。 */
export function parseStep(step: Record<string, unknown>): FileEditStep | string {
  const { action, path } = step
  if (action !== 'write' && action !== 'replace')
    return `action 要 write（整份写）或 replace（把一段原文换掉），这里给的是 ${JSON.stringify(action)}`
  if (!isString(path) || isBlank(path)) return '每一步都要有 path（字符串）'
  if (action === 'write')
    return isString(step.text)
      ? { action, path, text: step.text }
      : 'write 要 text（字符串）：这个文件的全部新内容'
  if (!isString(step.oldText) || isEmpty(step.oldText))
    return 'replace 要 oldText（非空字符串）：照读到的原文写要换掉的那一段；要整份换掉就用 write'
  return isString(step.newText)
    ? { action, path, oldText: step.oldText, newText: step.newText }
    : 'replace 要 newText（字符串）：换上去的新文，删掉就给空串'
}

/**
 * 第一次碰到一个文件时开底稿：文件系统操作都对 target，回执与报错里的路径用 location.path。
 * 已有的文件整份读进来（不超过 20 MB）：replace 要正文，write 要它的编码与换行风格，核版本与撤回要它的字节；
 * 目录、管道设备套接字、有多个硬链接的、太大的、不是文本的都不碰，成了这一步的问题。
 */
export async function openDraft(
  step: number,
  location: FileLocation
): Promise<FileEditDraft | FileEditProblem> {
  const { path, target } = location
  const problem = (
    message: string,
    reason: FileEditProblem['reason'] = 'invalid'
  ): FileEditProblem => ({ step, path, reason, message })
  const existing = await stat(target).catch(() => null)
  if (existing?.isDirectory()) return problem(`路径是目录，不是文件：${path}`)
  // 管道、设备、套接字：读它可能永远等不到数据（读命名管道会一直挂着），整个替换又会把它换成普通文件，一律不碰。
  if (existing && !existing.isFile())
    return problem(`路径不是普通文件（管道、设备或套接字），不能当文本改：${path}`)
  // 原子替换是写一个新文件再改名：多个硬链接的文件换完就和其余链接分家了，一律不碰。
  if (existing && existing.nlink > 1)
    return problem(
      `文件有 ${existing.nlink} 个硬链接，原子替换会让它和其余链接分家，不能在这里改：${path}；用命令改`
    )
  if (existing && existing.size > FileLimits.fileBytes)
    return problem(
      `现有文件太大，不能在这里改：${existing.size} 字节，上限 ${FileLimits.fileBytes} 字节；用命令就地改（sed -i、awk）`
    )
  // 父路径已经存在却不是目录，写入注定失败，在计划期就报出来（缺失的父目录落盘时会补建）。
  const parentCode = await stat(dirname(target))
    .then((parent) => (parent.isDirectory() ? null : 'ENOTDIR'))
    .catch((error: unknown) => readErrnoCode(error))
  if (parentCode === 'ENOTDIR') return problem(`上级路径不是目录：${dirname(path)}`)

  // 已有的文件必须是文本才许改：二进制文件被整份覆盖就没了，按原文换一段也无从谈起。
  let original: Nullable<FileTextContent> = null
  if (existing) {
    try {
      original = await readTextFile(target, path)
    } catch (error) {
      const failure = AppError.from(error)
      log.debug('an existing file cannot be edited as text', { code: failure.code })
      return problem(
        `现有文件不能当文本改（${failure.message}）；二进制文件用命令替换`,
        failure.code === 'PERMISSION' ? 'denied' : 'invalid'
      )
    }
  }
  return {
    step,
    location,
    original,
    stamp: stampOf(existing),
    content: toNullable(original?.content),
    eol: original ? splitLines(original.content).eol : '\n',
  }
}

/**
 * 把一步落到底稿上：write 整份换掉（已有的文件按它原来的换行风格存，新文件照写），replace 把唯一的一段原文换掉。
 * 成了返回 null；写不下去返回一句说明，调用方记成这一步的问题。
 */
export function applyStep(draft: FileEditDraft, step: FileEditStep): Nullable<string> {
  if (step.action === 'write') {
    // 模型一律写 \n；已有的文件存成它原来的换行风格，新文件照写，之后换进去的新文跟着它自己的风格。
    // 照 read 交出去的样子原样写回来的什么都不动：混着 CRLF 与 LF 的、行里夹着零碎 \r 的，字节都不变。
    if (draft.original) {
      if (isNull(draft.content) || step.text !== wholeText(draft.content))
        draft.content = toFileNewlines(step.text, draft.eol)
    } else {
      draft.content = step.text
      draft.eol = splitLines(step.text).eol
    }
    return null
  }
  if (isNull(draft.content))
    return `文件不存在：${draft.location.path}；新建文件用 write（同一次 edit 里先 write 再 replace 也行）`
  const replaced = replaceOnce(draft.content, draft.eol, step.oldText, step.newText)
  if ('problem' in replaced) return replaced.problem
  draft.content = replaced.content
  return null
}

/**
 * 底稿编成写入计划：按原编码编好要写的字节，GB18030 里没改的片段沿用原字节（同一个字可能有两种写法）；
 * 带 NUL 的、编不回原编码的、写出去超过 20 MB 的都不写——那样的文件之后读不了也改不了。不超过 2 MB 的原文留着给撤回。
 */
export function finishDraft(draft: FileEditDraft): FileEditPlan | FileEditProblem {
  const { original, location } = draft
  const problem = (message: string): FileEditProblem => ({
    step: draft.step,
    path: location.path,
    reason: 'invalid',
    message,
  })
  // 底稿开了就一定落过一步：没写过的新文件在 applyStep 里就成了问题。
  const content = draft.content ?? ''
  if (content.includes('\0') && !original?.content.includes('\0'))
    return problem('新内容里有 NUL 字节，是二进制数据，不能当文本写入')
  // 按原编码写不出来（孤立代理项、GB18030 表示不了的字符）就是这个文件的问题，整批不写，不静默换成替换字符或别的编码。
  let bytes: Buffer
  try {
    bytes = original
      ? textCodec.encodePreserving(original.buffer, original.content, content, original.encoding)
      : textCodec.encode(content, 'utf8')
  } catch (error) {
    return problem(
      `新内容不能按 ${original?.encoding ?? 'utf8'} 无损写进这个文件：${AppError.from(error).message}`
    )
  }
  if (bytes.byteLength > FileLimits.fileBytes)
    return problem(
      `写出去有 ${bytes.byteLength} 字节，超过 ${FileLimits.fileBytes} 字节的上限：这样的文件之后读不了、也改不了；更大的文件用命令生成`
    )
  const plan: FileEditPlan = {
    step: draft.step,
    path: location.path,
    target: location.target,
    linked: location.linked,
    created: !original,
    bytes,
    totalLines: lineCount(content),
    baseVersion: original ? fileVersionOf(original.buffer) : null,
    stamp: draft.stamp,
  }
  // 撤回要原文：新建的记 null；已有的不超过上限才留，更大的不留（缺席），这次改动就撤不回。
  if (!original) plan.previous = null
  else if (original.buffer.byteLength <= FileLimits.undoBytes) plan.previous = original.buffer
  return plan
}
