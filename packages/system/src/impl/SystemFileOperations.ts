/**
 * 三个文件操作：`SystemFileOperations` 与整个进程唯一的 `systemFileOperations`。接口见 `interface/internal.ts` 的 `SystemFileOperationsApi`。
 * `system:read`、`system:view`、`system:edit` 各调一个方法；三个都是一批文件（一个文件就一项），一批里某个文件失败只标记它那一项，全部失败才整个报错；列目录和搜文本由 `system:run` 用系统命令做。
 */

import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'

import { isEmpty, isPresent, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { SystemEditFileInput, SystemEditFileResult, SystemEditInput, SystemEditResult, SystemReadFileInput, SystemReadFileResult, SystemReadInput, SystemReadResult, SystemTextRange, SystemViewFileInput, SystemViewFileResult, SystemViewInput, SystemViewResult } from '../contract/files.js'
import type { SystemFileHistoryApi, SystemFileOperationsApi } from '../interface/internal.js'
import type { SystemPlatformCompatibilityApi } from '../interface/provides.js'
import type { SystemToolContext } from '../interface/requires.js'
import { assertFileBatchSize, failureEntry } from '../utils/file-batch.js'
import { confirmSensitiveSystemMutation } from '../utils/file-safety.js'
import { writeSystemFileAtomically } from '../utils/fs.js'
import { extractPdfPages, pdfPagesFilename } from '../utils/pdf.js'
import { adaptReplacementLineEndings, findOccurrences } from '../utils/text.js'
import {
  clampTextRange,
  decodeSystemTextBuffer,
  detectMediaType,
  encodeSystemTextContent,
  fileVersionOf,
  readBoundedFile,
  readRawSystemFileBuffer,
  readSystemTextFile,
  readTextWindow,
  SystemFileLimits,
} from '../utils/text-file.js'

import { SystemFileHistory } from './SystemFileHistory.js'
import { currentSystemPlatform } from './SystemPlatformCompatibility.js'

const log = Log.tag('SystemFileOperations')

/** 多处匹配时每个锚点前后各带多少字符原文。 */
const AnchorContextChars = 80
/** 多处匹配时最多列出多少个锚点。 */
const MaxAnchors = 20

class SystemFileOperations implements SystemFileOperationsApi {
  private readonly platform: SystemPlatformCompatibilityApi
  private readonly history: SystemFileHistoryApi

  constructor(platformTools: SystemPlatformCompatibilityApi, history: SystemFileHistoryApi) {
    this.platform = platformTools
    this.history = history
  }

  public async read(input: SystemReadInput): Promise<SystemReadResult> {
    assertFileBatchSize(input.files.length, SystemFileLimits.readFiles, 'read')
    const files: SystemReadResult['files'] = []
    const failures: AppError[] = []
    // 一次调用总共最多 readChars 个字符：按顺序分给每个文件，分完后面的文件只带位置不带内容，hasMore 告诉调用方接着读。
    let remaining = SystemFileLimits.readChars
    for (const file of input.files) {
      try {
        const result = await this.readOne(file, remaining)
        remaining -= result.content.length
        files.push(result)
      } catch (error) {
        const failure = AppError.from(error)
        log.debug('one file in a read batch failed', { path: file.path, code: failure.code, message: failure.message })
        failures.push(failure)
        files.push(failureEntry(file.path, failure))
      }
    }
    if (failures.length === input.files.length) throw failures[0]
    return { files }
  }

  public async view(input: SystemViewInput): Promise<SystemViewResult> {
    assertFileBatchSize(input.files.length, SystemFileLimits.viewFiles, 'view')
    const files: SystemViewResult['files'] = []
    const modelContent: SystemViewResult['modelContent'] = []
    const failures: AppError[] = []
    for (const [index, file] of input.files.entries()) {
      try {
        const viewed = await this.viewOne(file)
        files.push(viewed.entry)
        modelContent.push({ type: 'text', text: `文件 ${index + 1}/${input.files.length}：${viewed.label}` }, viewed.part)
      } catch (error) {
        const failure = AppError.from(error)
        log.debug('one file in a view batch failed', { path: file.path, code: failure.code, message: failure.message })
        failures.push(failure)
        files.push(failureEntry(file.path, failure))
      }
    }
    if (failures.length === input.files.length) throw failures[0]
    return { files, modelContent }
  }

  public async edit(input: SystemEditInput, ctx: SystemToolContext): Promise<SystemEditResult> {
    assertFileBatchSize(input.files.length, SystemFileLimits.editFiles, 'edit')
    const files: SystemEditResult['files'] = []
    const failures: AppError[] = []
    for (const file of input.files) {
      try {
        files.push(await this.editOne(file, ctx))
      } catch (error) {
        const failure = AppError.from(error)
        log.debug('one file in an edit batch failed', { path: file.path, code: failure.code, message: failure.message })
        failures.push(failure)
        files.push(failureEntry(file.path, failure))
      }
    }
    if (failures.length === input.files.length) throw failures[0]
    return { files }
  }

  /** 写一个文件：三种改法只用一种；敏感路径先向用户确认，改动前把原内容留成一个版本。 */
  private async editOne(file: SystemEditFileInput, ctx: SystemToolContext): Promise<SystemEditFileResult> {
    const resolvedPath = this.resolvePath(file.path)
    const restoring = isPresent(file.restore)
    const wholeFile = isPresent(file.newText)
    const editing = isPresent(file.edits)
    const modes = [restoring, wholeFile, editing].filter(Boolean).length
    if (modes === 0) throw new AppError('VALIDATION', 'Give newText to write the whole file, edits to change places in it, or restore to roll back.')
    if (modes > 1) throw new AppError('VALIDATION', 'newText, edits and restore each go alone; give one of them.')
    await confirmSensitiveSystemMutation(ctx, resolvedPath, editing ? 'edit' : 'write')
    const existing = await stat(resolvedPath).catch(() => null)
    if (existing?.isDirectory()) {
      throw new AppError('VALIDATION', `Path is a directory, not a file: ${resolvedPath}`)
    }

    if (isPresent(file.restore)) {
      const snapshot = this.history.recall(resolvedPath, file.restore)
      if (!snapshot) {
        throw new AppError('NOT_FOUND', `Version ${file.restore} of ${resolvedPath} is not in history; only the last few versions before edits are kept, in memory`)
      }
      const previousVersion = existing?.isFile() ? this.history.remember(resolvedPath, await readRawSystemFileBuffer(resolvedPath)) : null
      await mkdir(dirname(resolvedPath), { recursive: true })
      await writeSystemFileAtomically(resolvedPath, snapshot.buffer)
      const restored = decodeSystemTextBuffer(snapshot.buffer, resolvedPath)
      return { path: resolvedPath, action: 'restored', version: snapshot.version, previousVersion, bytes: snapshot.buffer.byteLength, totalChars: restored.content.length }
    }

    if (isPresent(file.newText)) {
      if (file.newText.includes('\0')) {
        throw new AppError('VALIDATION', 'newText contains binary data and cannot be written as text.')
      }
      const previous = existing?.isFile() ? await readSystemTextFile(resolvedPath).catch(() => null) : null
      const previousVersion = previous ? this.history.remember(resolvedPath, previous.buffer) : null
      const buffer = encodeSystemTextContent(file.newText, previous?.encoding ?? 'utf8')
      await mkdir(dirname(resolvedPath), { recursive: true })
      await writeSystemFileAtomically(resolvedPath, buffer)
      return { path: resolvedPath, action: 'written', created: !existing, version: fileVersionOf(buffer), previousVersion, bytes: buffer.byteLength, totalChars: file.newText.length }
    }

    const edits = file.edits ?? []
    if (isEmpty(edits)) throw new AppError('VALIDATION', 'edits is empty; give at least one place to change.')
    if (edits.length > SystemFileLimits.editsPerFile) throw new AppError('VALIDATION', `At most ${SystemFileLimits.editsPerFile} edits per file; got ${edits.length}, split them`)
    if (!existing) throw new AppError('NOT_FOUND', `File not found: ${resolvedPath}`)
    const textFile = await readSystemTextFile(resolvedPath)
    if (textFile.buffer.byteLength > SystemFileLimits.editableBytes) {
      throw new AppError('VALIDATION', `File is too large for edit: ${textFile.buffer.byteLength} bytes > ${SystemFileLimits.editableBytes} bytes`)
    }
    const content = textFile.content

    // 先在改动前的原文上把每一处的目标定下来，任何一处定不下来文件就不动；多处匹配返回锚点让调用方选。
    const targets: Array<{ index: number; range: SystemTextRange; newText: string }> = []
    const scopes: SystemTextRange[] = []
    for (const [index, edit] of edits.entries()) {
      if (edit.newText.includes('\0')) throw new AppError('VALIDATION', `edits[${index}].newText contains binary data and cannot be written as text.`)
      const scope = clampTextRange(content, edit.range)
      scopes.push(scope)
      if (!isPresent(edit.oldText)) {
        targets.push({ index, range: scope, newText: edit.newText })
        continue
      }
      if (isEmpty(edit.oldText)) throw new AppError('VALIDATION', `edits[${index}].oldText is empty; leave it out to replace the whole range.`)
      const replacement = adaptReplacementLineEndings(content, edit.oldText, edit.newText)
      const matches = findOccurrences(content, replacement.oldText, scope)
      if (isEmpty(matches)) {
        throw new AppError('NOT_FOUND', `edits[${index}]: oldText was not found within range ${scope.offset}-${scope.end} of ${resolvedPath}; read that range again`)
      }
      if (matches.length > 1) return {
          path: resolvedPath,
          action: 'ambiguous',
          edit: index,
          anchors: matches.slice(0, MaxAnchors).map((offset) => {
            const range = { offset, end: offset + replacement.oldText.length }
            const around = clampTextRange(content, { offset: range.offset - AnchorContextChars, end: range.end + AnchorContextChars })
            return { range, context: content.slice(around.offset, around.end) }
          }),
          matchCount: matches.length,
          totalChars: content.length,
        }
      targets.push({ index, range: { offset: matches[0]!, end: matches[0]! + replacement.oldText.length }, newText: replacement.newText })
    }
    const ordered = [...targets].sort((a, b) => a.range.offset - b.range.offset || a.range.end - b.range.end)
    for (let i = 1; i < ordered.length; i += 1) {
      const before = ordered[i - 1]!
      const after = ordered[i]!
      if (after.range.offset < before.range.end || (after.range.offset === before.range.offset && before.range.end === before.range.offset && after.range.end === after.range.offset)) {
        throw new AppError('VALIDATION', `edits[${before.index}] and edits[${after.index}] overlap in ${resolvedPath}; merge them into one edit`)
      }
    }

    // 从后往前套用，前面的位置不受后面改动影响。
    let updated = content
    for (const target of [...ordered].reverse()) {
      updated = updated.slice(0, target.range.offset) + target.newText + updated.slice(target.range.end)
    }
    const buffer = encodeSystemTextContent(updated, textFile.encoding)
    const previousVersion = this.history.remember(resolvedPath, textFile.buffer)
    await writeSystemFileAtomically(resolvedPath, buffer)

    // 改完把盖住所有改动那段（各处 range 的并集）的新样子一起交回去，位置按改动前后的长度差挪；太长就截到读的上限。
    const delta = ordered.reduce((sum, target) => sum + target.newText.length - (target.range.end - target.range.offset), 0)
    const union = { offset: Math.min(...scopes.map((scope) => scope.offset)), end: Math.max(...scopes.map((scope) => scope.end)) + delta }
    const window = clampTextRange(updated, { offset: union.offset, end: Math.min(union.end, union.offset + SystemFileLimits.readChars) })
    return {
      path: resolvedPath,
      action: 'replaced',
      edits: ordered.length,
      version: fileVersionOf(buffer),
      previousVersion,
      bytes: buffer.byteLength,
      totalChars: updated.length,
      content: updated.slice(window.offset, window.end),
      range: window,
      hasMore: window.end < updated.length,
    }
  }

  /** 读一个文件：按字符取一段，最多 remaining 个（还受文件自己的 maxChars 和总上限约束）；给 version 就读改动前留下的那个版本。 */
  private async readOne(file: SystemReadFileInput, remaining: number): Promise<SystemReadFileResult> {
    const resolvedPath = this.resolvePath(file.path)
    const maxChars = Math.max(0, Math.min(SystemFileLimits.readChars, file.maxChars ?? SystemFileLimits.readChars, remaining))
    if (isPresent(file.version)) {
      const snapshot = this.history.recall(resolvedPath, file.version)
      if (!snapshot) {
        throw new AppError('NOT_FOUND', `Version ${file.version} of ${resolvedPath} is not in history; only the last few versions before edits are kept, in memory`)
      }
      return readTextWindow(resolvedPath, snapshot.buffer, file.offset ?? 0, maxChars)
    }
    const buffer = await readBoundedFile(resolvedPath, SystemFileLimits.fileBytes)
    const media = detectMediaType(buffer)
    if (media) {
      throw new AppError('VALIDATION', `${resolvedPath} is ${media.kind === 'image' ? 'an image' : 'a PDF'}; use system:view to look at it`)
    }
    return readTextWindow(resolvedPath, buffer, file.offset ?? 0, maxChars)
  }

  /** 看一个文件：图片整张、PDF 抽出 pages 这几页成一份文档，返回元数据、交给模型的内容块和一行说明。 */
  private async viewOne(file: SystemViewFileInput): Promise<{ entry: SystemViewFileResult; part: SystemViewResult['modelContent'][number]; label: string }> {
    const resolvedPath = this.resolvePath(file.path)
    const buffer = await readBoundedFile(resolvedPath, SystemFileLimits.fileBytes)
    const media = detectMediaType(buffer)
    if (!media) {
      throw new AppError('VALIDATION', `${resolvedPath} is not an image or PDF; text files go through system:read`)
    }
    if (media.kind === 'image') {
      if (buffer.byteLength > SystemFileLimits.imageBytes) {
        throw new AppError('VALIDATION', `Image is too large to hand to the model: ${buffer.byteLength} bytes > ${SystemFileLimits.imageBytes} bytes; shrink it with system:run first`)
      }
      return {
        entry: { path: resolvedPath, kind: 'image', mediaType: media.mediaType, bytes: buffer.byteLength },
        part: { type: 'image-data', data: buffer.toString('base64'), mediaType: media.mediaType },
        label: resolvedPath,
      }
    }
    const extracted = await extractPdfPages(buffer, file.pages ?? [1], SystemFileLimits.pdfPages)
    const filename = pdfPagesFilename(basename(resolvedPath, extname(resolvedPath)), extracted.pages)
    return {
      entry: { path: resolvedPath, kind: 'document', mediaType: media.mediaType, pages: extracted.pages, pageCount: extracted.pageCount, bytes: extracted.bytes.byteLength },
      part: { type: 'file-data', data: extracted.bytes.toString('base64'), mediaType: media.mediaType, filename },
      label: `${resolvedPath}（第 ${extracted.pages.join('、')} 页，共 ${extracted.pageCount} 页）`,
    }
  }

  /** 把用户输入的路径变成绝对路径：规整特殊空格与开头的 `@`，`~` 展开到家目录，相对路径相对家目录。 */
  private resolvePath(path: string): string {
    const normalizedPath = this.platform.normalizeUserPathInput(path, homedir())
    return isAbsolute(normalizedPath) ? resolve(normalizedPath) : resolve(homedir(), normalizedPath)
  }
}

/** 整个进程只有一份的文件操作，按当前进程的平台规整路径。 */
export const systemFileOperations: SystemFileOperationsApi = new SystemFileOperations(currentSystemPlatform, new SystemFileHistory())
