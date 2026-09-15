/**
 * 三个文件操作：`SystemFileOperations` 与整个进程唯一的 `systemFileOperations`。接口见 `interface/internal.ts` 的 `SystemFileOperationsApi`。
 * `system:read`、`system:view`、`system:edit` 各调一个方法；三个都是一批文件（一个文件就一项），读和看里某个文件失败只标记它那一项、全部失败才整个报错，写是整批同成败；列目录和搜文本由 `system:run` 用系统命令做。PDF 与其他文档不在这里看。
 */

import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'

import { isArray, isEmpty, isNotNull, isNull, isPresent, Log, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { SystemEditFileInput, SystemEditFileResult, SystemEditInput, SystemEditProblem, SystemEditReplacedResult, SystemEditResult, SystemEditWindow, SystemReadFileInput, SystemReadFileResult, SystemReadInput, SystemReadResult, SystemTextEncoding, SystemTextFileContent, SystemTextRange, SystemViewFileInput, SystemViewFileResult, SystemViewInput, SystemViewResult } from '../contract/files.js'
import type { SystemFileHistoryApi, SystemFileOperationsApi } from '../interface/internal.js'
import type { SystemPlatformCompatibilityApi } from '../interface/provides.js'
import type { SystemToolContext } from '../interface/requires.js'
import { assertFileBatchSize, failureEntry, staleProblem, unresolvedEditFailure } from '../utils/file-batch.js'
import { confirmCredentialAccess, confirmSensitiveSystemMutation } from '../utils/file-safety.js'
import { writeSystemFileAtomically } from '../utils/fs.js'
import { adaptReplacementLineEndings, findOccurrences } from '../utils/text.js'
import {
  clampTextRange,
  currentFileVersion,
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

/** 一处已经定下来的目标：edit 是 edits 里第几处，range 是改动前原文里的位置。 */
interface EditTarget {
  edit: number
  range: SystemTextRange
  newText: string
}

/** 一个文件定下来的写入计划：回滚、整个写入、或改几处；baseVersion 是计划时文件的版本（不存在为 null），写之前再核一次。第一段只做计划，第二段照计划写。 */
type EditPlan =
  | { kind: 'restore'; index: number; path: string; exists: boolean; snapshot: { version: string; buffer: Buffer }; baseVersion: Nullable<string> }
  | { kind: 'write'; index: number; path: string; created: boolean; previous: Nullable<{ buffer: Buffer; encoding: SystemTextEncoding }>; newText: string; baseVersion: Nullable<string> }
  | { kind: 'edits'; index: number; path: string; textFile: { buffer: Buffer; content: string; encoding: SystemTextEncoding }; ordered: EditTarget[]; scopes: SystemTextRange[]; baseVersion: Nullable<string> }

/** 多处匹配时每个锚点前后各带多少字符原文。 */
const AnchorContextChars = 80
/** 多处匹配时最多列出多少个锚点：失败回执里每个数组只保留 10 项。 */
const MaxAnchors = 10

class SystemFileOperations implements SystemFileOperationsApi {
  private readonly platform: SystemPlatformCompatibilityApi
  private readonly history: SystemFileHistoryApi

  constructor(platformTools: SystemPlatformCompatibilityApi, history: SystemFileHistoryApi) {
    this.platform = platformTools
    this.history = history
  }

  public async read(input: SystemReadInput, ctx: SystemToolContext): Promise<SystemReadResult> {
    assertFileBatchSize(input.files.length, SystemFileLimits.readFiles, 'read')
    const files: SystemReadResult['files'] = []
    const failures: AppError[] = []
    // 一次调用总共最多 readChars 个字符：按顺序分给每个文件，分完后面的文件只带位置不带内容，hasMore 告诉调用方接着读。
    let remaining = SystemFileLimits.readChars
    let exhaustedAt: Nullable<number> = null
    for (const [index, file] of input.files.entries()) {
      try {
        if (remaining <= 0 && isNull(exhaustedAt)) exhaustedAt = index
        const result = await this.readOne(file, remaining, ctx)
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
    const result: SystemReadResult = { files }
    if (isNotNull(exhaustedAt)) result.note = `一次调用最多 ${SystemFileLimits.readChars} 字符，预算在第 ${exhaustedAt + 1} 个文件之前用完，从它起只带位置没有内容；把各自的 range.end 当 offset 再读一次。`
    return result
  }

  public async view(input: SystemViewInput, ctx: SystemToolContext): Promise<SystemViewResult> {
    assertFileBatchSize(input.files.length, SystemFileLimits.viewFiles, 'view')
    const files: SystemViewResult['files'] = []
    const modelContent: SystemViewResult['modelContent'] = []
    const failures: AppError[] = []
    for (const [index, file] of input.files.entries()) {
      try {
        const viewed = await this.viewOne(file, ctx)
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
    if (!isArray(input.files)) throw new AppError('VALIDATION', 'files is required: one entry per file to write')
    assertFileBatchSize(input.files.length, SystemFileLimits.editFiles, 'edit')
    // 第一段：每个文件先过审批（敏感路径、凭证文件），再把每一处定下来，什么都不写；有任何问题就整批失败，问题全部列出来让调用方一次改完。
    const plans: EditPlan[] = []
    const problems: SystemEditProblem[] = []
    const seen = new Set<string>()
    for (const [index, file] of input.files.entries()) {
      const resolvedPath = this.resolvePath(file.path, ctx)
      if (seen.has(resolvedPath)) {
        problems.push({ file: index, path: resolvedPath, reason: 'invalid', message: 'the same file appears more than once in this batch; put all of its edits in one entry' })
        continue
      }
      seen.add(resolvedPath)
      try {
        await confirmSensitiveSystemMutation(ctx, resolvedPath, isPresent(file.edits) ? 'edit' : 'write')
        await confirmCredentialAccess(ctx, resolvedPath, 'write')
      } catch (error) {
        const failure = AppError.from(error)
        log.debug('sensitive path write was not approved', { path: resolvedPath, code: failure.code })
        problems.push({ file: index, path: resolvedPath, reason: 'denied', message: failure.message })
        continue
      }
      const planned = await this.planOne(index, resolvedPath, file)
      if (isArray(planned)) problems.push(...planned)
      else plans.push(planned)
    }
    if (!isEmpty(problems)) throw unresolvedEditFailure(problems)
    // 审批期间文件可能又被别人改了：写之前再核一次字节，变了就整批不写。
    for (const plan of plans) {
      const current = await currentFileVersion(plan.path)
      if (current !== plan.baseVersion) {
        problems.push({ file: plan.index, path: plan.path, reason: 'stale', message: 'the file changed while the edit was being confirmed; read it again', currentVersion: toOptional(current) })
      }
    }
    if (!isEmpty(problems)) throw unresolvedEditFailure(problems)
    // 第二段：按顺序写。写到一半出错就原样抛出，不标 not-applied，前面已写的文件在 context 里点名。
    const files: SystemEditFileResult[] = []
    for (const plan of plans) {
      try {
        files.push(await this.applyOne(plan))
      } catch (error) {
        throw new AppError(AppError.from(error).code, `files[${plan.index}] ${plan.path} could not be written after ${files.length} file(s) were: ${AppError.from(error).message}`, error, { applied: files.map((file) => file.path) })
      }
    }
    return { files }
  }

  /** 把一个文件的改法定下来但不写：返回写入计划，或者这个文件的问题清单。 */
  private async planOne(index: number, resolvedPath: string, file: SystemEditFileInput): Promise<EditPlan | SystemEditProblem[]> {
    const problem = (message: string, extra: Partial<SystemEditProblem> = {}): SystemEditProblem[] => [{ file: index, path: resolvedPath, reason: 'invalid', message, ...extra }]
    const restoring = isPresent(file.restore)
    const wholeFile = isPresent(file.newText)
    const editing = isPresent(file.edits)
    const modes = [restoring, wholeFile, editing].filter(Boolean).length
    if (modes === 0) return problem('give newText to write the whole file, edits to change places in it, or restore to roll back')
    if (modes > 1) return problem('newText, edits and restore each go alone; give one of them')
    const existing = await stat(resolvedPath).catch(() => null)
    if (existing?.isDirectory()) return problem(`path is a directory, not a file: ${resolvedPath}`)

    if (isPresent(file.restore)) {
      const snapshot = this.history.recall(resolvedPath, file.restore)
      if (!snapshot) return problem(`version ${file.restore} is not in history; only the last few versions before edits are kept, in memory`, { reason: 'not-found' })
      const baseVersion = existing?.isFile() ? fileVersionOf(await readRawSystemFileBuffer(resolvedPath)) : null
      const stale = staleProblem(file.version, baseVersion)
      if (stale) return problem(stale.message, stale)
      return { kind: 'restore', index, path: resolvedPath, exists: !!existing?.isFile(), snapshot, baseVersion }
    }

    if (isPresent(file.newText)) {
      if (file.newText.includes('\0')) return problem('newText contains binary data and cannot be written as text')
      const previous = existing?.isFile() ? await readSystemTextFile(resolvedPath).catch(() => null) : null
      const baseVersion = existing?.isFile() ? fileVersionOf(previous?.buffer ?? await readRawSystemFileBuffer(resolvedPath)) : null
      const stale = staleProblem(file.version, baseVersion)
      if (stale) return problem(stale.message, stale)
      return { kind: 'write', index, path: resolvedPath, created: !existing, previous, newText: file.newText, baseVersion }
    }

    const edits = file.edits ?? []
    if (isEmpty(edits)) return problem('edits is empty; give at least one place to change')
    if (edits.length > SystemFileLimits.editsPerFile) return problem(`at most ${SystemFileLimits.editsPerFile} edits per file; got ${edits.length}, split them`)
    if (!existing) return problem(`file not found: ${resolvedPath}`, { reason: 'not-found' })
    let textFile: SystemTextFileContent
    try {
      textFile = await readSystemTextFile(resolvedPath)
    } catch (error) {
      const failure = AppError.from(error)
      log.debug('a file in an edit batch could not be read', { path: resolvedPath, code: failure.code })
      return problem(failure.message, { reason: failure.code === 'NOT_FOUND' ? 'not-found' : failure.code === 'PERMISSION' ? 'denied' : 'invalid' })
    }
    if (textFile.buffer.byteLength > SystemFileLimits.editableBytes) return problem(`file is too large for edit: ${textFile.buffer.byteLength} bytes > ${SystemFileLimits.editableBytes} bytes`)
    const baseVersion = fileVersionOf(textFile.buffer)
    const stale = staleProblem(file.version, baseVersion)
    if (stale) return problem(stale.message, stale)
    // 解码再编码必须得到原来的字节，否则改动区间之外的字节也会被改写；这种文件让 system:run 去改。
    if (!encodeSystemTextContent(textFile.content, textFile.encoding).equals(textFile.buffer)) return problem(`file has bytes that are not valid ${textFile.encoding} text and cannot be rewritten losslessly; change it with system:run`)
    const content = textFile.content

    // 每一处都在改动前的原文上定目标；多处匹配给锚点，找不到、重叠也都记下来，一次报完。
    const problems: SystemEditProblem[] = []
    const targets: EditTarget[] = []
    const scopes: SystemTextRange[] = []
    for (const [edit, change] of edits.entries()) {
      const at = (message: string, extra: Partial<SystemEditProblem> = {}): void => { problems.push({ file: index, path: resolvedPath, reason: 'invalid', message, edit, ...extra }) }
      if (change.newText.includes('\0')) { at('newText contains binary data and cannot be written as text'); continue }
      if (change.range.end < change.range.offset || change.range.offset > content.length || change.range.end > content.length) {
        at(`range ${change.range.offset}-${change.range.end} lies outside the file, which has ${content.length} characters; read it again`, { reason: 'stale', currentVersion: baseVersion })
        continue
      }
      const scope = clampTextRange(content, change.range)
      scopes.push(scope)
      if (!isPresent(change.oldText)) { targets.push({ edit, range: scope, newText: change.newText }); continue }
      if (isEmpty(change.oldText)) { at('oldText is empty; leave it out to replace the whole range'); continue }
      const replacement = adaptReplacementLineEndings(content, change.oldText, change.newText)
      const matches = findOccurrences(content, replacement.oldText, scope)
      if (isEmpty(matches)) { at(`oldText was not found within range ${scope.offset}-${scope.end}; read that range again`, { reason: 'not-found' }); continue }
      if (matches.length > 1) {
        at(`oldText matches ${matches.length} places within range ${scope.offset}-${scope.end}; pick one anchor and put its range here`, {
          reason: 'ambiguous',
          matchCount: matches.length,
          anchors: matches.slice(0, MaxAnchors).map((offset) => {
            const range = { offset, end: offset + replacement.oldText.length }
            const around = clampTextRange(content, { offset: range.offset - AnchorContextChars, end: range.end + AnchorContextChars })
            return { range, context: content.slice(around.offset, around.end) }
          }),
        })
        continue
      }
      targets.push({ edit, range: { offset: matches[0]!, end: matches[0]! + replacement.oldText.length }, newText: replacement.newText })
    }
    const ordered = [...targets].sort((a, b) => a.range.offset - b.range.offset || a.range.end - b.range.end)
    for (let i = 1; i < ordered.length; i += 1) {
      const before = ordered[i - 1]!
      const after = ordered[i]!
      const overlapping = after.range.offset < before.range.end || (after.range.offset === before.range.offset && before.range.end === before.range.offset && after.range.end === after.range.offset)
      if (overlapping) problems.push({ file: index, path: resolvedPath, reason: 'overlap', message: `edits[${before.edit}] and edits[${after.edit}] overlap; merge them into one edit`, edit: after.edit, with: before.edit })
    }
    if (!isEmpty(problems)) return problems
    return { kind: 'edits', index, path: resolvedPath, textFile, ordered, scopes, baseVersion }
  }

  /** 按计划写一个文件：改动前把原内容留成一个版本。 */
  private async applyOne(plan: EditPlan): Promise<SystemEditFileResult> {
    if (plan.kind === 'restore') {
      const previousVersion = plan.exists ? this.history.remember(plan.path, await readRawSystemFileBuffer(plan.path)) : null
      await mkdir(dirname(plan.path), { recursive: true })
      await writeSystemFileAtomically(plan.path, plan.snapshot.buffer)
      const restored = decodeSystemTextBuffer(plan.snapshot.buffer, plan.path)
      return { path: plan.path, action: 'restored', version: plan.snapshot.version, previousVersion, bytes: plan.snapshot.buffer.byteLength, totalChars: restored.content.length }
    }
    if (plan.kind === 'write') {
      const previousVersion = plan.previous ? this.history.remember(plan.path, plan.previous.buffer) : null
      const buffer = encodeSystemTextContent(plan.newText, plan.previous?.encoding ?? 'utf8')
      await mkdir(dirname(plan.path), { recursive: true })
      await writeSystemFileAtomically(plan.path, buffer)
      return { path: plan.path, action: 'written', created: plan.created, version: fileVersionOf(buffer), previousVersion, bytes: buffer.byteLength, totalChars: plan.newText.length }
    }
    // 从后往前套用，前面的位置不受后面改动影响。
    const content = plan.textFile.content
    let updated = content
    for (const target of [...plan.ordered].reverse()) {
      updated = updated.slice(0, target.range.offset) + target.newText + updated.slice(target.range.end)
    }
    const buffer = encodeSystemTextContent(updated, plan.textFile.encoding)
    const previousVersion = this.history.remember(plan.path, plan.textFile.buffer)
    await writeSystemFileAtomically(plan.path, buffer)
    // 改完每处都交回新文本前后各一小段；盖住所有改动那段（各处 range 的并集）不长时整段也给，位置按改动前后的长度差挪。
    const windows: SystemEditWindow[] = []
    let shift = 0
    for (const target of plan.ordered) {
      const start = target.range.offset + shift
      const end = start + target.newText.length
      const around = clampTextRange(updated, { offset: start - SystemFileLimits.editContextChars, end: end + SystemFileLimits.editContextChars })
      windows.push({ edit: target.edit, range: around, content: updated.slice(around.offset, around.end) })
      shift += target.newText.length - (target.range.end - target.range.offset)
    }
    windows.sort((a, b) => a.edit - b.edit)
    const union = clampTextRange(updated, { offset: Math.min(...plan.scopes.map((scope) => scope.offset)), end: Math.max(...plan.scopes.map((scope) => scope.end)) + shift })
    const result: SystemEditReplacedResult = {
      path: plan.path,
      action: 'replaced',
      edits: plan.ordered.length,
      version: fileVersionOf(buffer),
      previousVersion,
      bytes: buffer.byteLength,
      totalChars: updated.length,
      windows,
    }
    if (union.end - union.offset <= SystemFileLimits.editWholeChars) {
      result.content = updated.slice(union.offset, union.end)
      result.range = union
    }
    return result
  }

  /** 读一个文件：按字符取一段，最多 remaining 个（还受文件自己的 maxChars 和总上限约束）；给 version 就读改动前留下的那个版本。 */
  private async readOne(file: SystemReadFileInput, remaining: number, ctx: SystemToolContext): Promise<SystemReadFileResult> {
    const resolvedPath = this.resolvePath(file.path, ctx)
    const maxChars = Math.max(0, Math.min(SystemFileLimits.readChars, file.maxChars ?? SystemFileLimits.readChars, remaining))
    // 预算已经用完的文件只带位置回去，不为它打扰用户。
    if (maxChars > 0) await confirmCredentialAccess(ctx, resolvedPath, 'read')
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
      throw new AppError('VALIDATION', media.kind === 'image' ? `${resolvedPath} is an image; use system:view to look at it` : `${resolvedPath} is a PDF, not text; documents are read elsewhere`)
    }
    return readTextWindow(resolvedPath, buffer, file.offset ?? 0, maxChars)
  }

  /** 看一张图片：整张作为内容块交给模型，返回元数据、内容块和一行说明；不是模型认得的图片就报错。 */
  private async viewOne(file: SystemViewFileInput, ctx: SystemToolContext): Promise<{ entry: SystemViewFileResult; part: SystemViewResult['modelContent'][number]; label: string }> {
    const resolvedPath = this.resolvePath(file.path, ctx)
    await confirmCredentialAccess(ctx, resolvedPath, 'read')
    const buffer = await readBoundedFile(resolvedPath, SystemFileLimits.fileBytes)
    const media = detectMediaType(buffer)
    if (media?.kind !== 'image') {
      throw new AppError('VALIDATION', media
        ? `${resolvedPath} is a PDF; this tool only shows images, documents are read elsewhere`
        : `${resolvedPath} is not an image the model can see (PNG, JPEG, GIF, WebP); text files go through system:read, other formats need converting first`)
    }
    if (buffer.byteLength > SystemFileLimits.imageBytes) {
      throw new AppError('VALIDATION', `Image is too large to hand to the model: ${buffer.byteLength} bytes > ${SystemFileLimits.imageBytes} bytes; shrink it with system:run first`)
    }
    return {
      entry: { path: resolvedPath, mediaType: media.mediaType, bytes: buffer.byteLength },
      part: { type: 'image-data', data: buffer.toString('base64'), mediaType: media.mediaType },
      label: resolvedPath,
    }
  }

  /** 把用户输入的路径变成绝对路径：规整特殊空格与开头的 `@`，`~` 展开到家目录，相对路径相对宿主给 system:run 的默认目录，宿主没给就相对家目录。 */
  private resolvePath(path: string, ctx: SystemToolContext): string {
    const normalizedPath = this.platform.normalizeUserPathInput(path, homedir())
    if (isAbsolute(normalizedPath)) return resolve(normalizedPath)
    return resolve(ctx.system.resolveCommandCwd?.() ?? homedir(), normalizedPath)
  }
}

/** 整个进程只有一份的文件操作，按当前进程的平台规整路径。 */
export const systemFileOperations: SystemFileOperationsApi = new SystemFileOperations(currentSystemPlatform, new SystemFileHistory())
