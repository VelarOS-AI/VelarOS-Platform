/**
 * 代码面 `files` 命名空间的三个操作：`FileOperations` 与整个进程唯一的 `fileOperations`。接口 `FileOperationsApi` 在本文件的类上方。
 * 所有空间都一样的事在这里只做一份：有界地读、认编码、核版本、留版本、压图、一批的成败；
 * 空间不一样的事全交给注入的 `FileSpacePort`：路径怎么解析、哪些要问人、怎么落盘。
 */

import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isBlank, isEmpty, isPresent, isString, Log, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { PlatformCompatibilityApi } from '@velaros-ai/platform'
import { currentPlatform } from '@velaros-ai/platform'
import { textCodec } from '@velaros-ai/text-files'
import type { TextEncoding } from '@velaros-ai/text-files/contracts'

import { FileLimits } from '../contract/constants.js'
import type { FileOperationContext } from '../contract/requires.js'
import type { FileEditPlan, FileEditProblem } from '../types/edit.js'
import type {
  FileEditInput,
  FileEditItem,
  FileEditItemResult,
  FileEditResult,
  FileLocation,
  FileReadInput,
  FileReadItem,
  FileViewInput,
  FileViewItem,
  FileViewResult,
} from '../types/files.js'
import type { FileImageResizeRequest } from '../types/space.js'
import type { FileReadResult, FileTextResult, FileViewed } from '../types/text.js'
import { batchItems, commitFailure, confirmAll, failureEntry, staleProblem, unresolvedEditFailure, withLinkTarget, writeOfPlan } from '../utils/batch.js'
import { readErrnoCode } from '../utils/fs.js'
import { base64Length, clampImageRegion, readImageSize, shrinkImageToLimits } from '../utils/image.js'
import { fileIdentity } from '../utils/paths.js'
import {
  currentFileVersion,
  detectMediaType,
  fileVersionOf,
  readBoundedFile,
  readRawFile,
  readTextEncodingFromHead,
  readTextFile,
  readWholeText,
  stampOf,
  stampProvesUnchanged,
} from '../utils/text-file.js'

import type { FileHistoryApi } from './FileHistory.js'
import { FileHistory } from './FileHistory.js'

const log = Log.tag('FileOperations')

/**
 * 代码面跨空间的命名空间之一：模型在程序里写 `read(...)`、`edit(...)`，每个空间注入自己的 `FileSpacePort`。
 * 实现是 `FileOperations`，整个进程只有一份（`fileOperations`）。
 *
 * @AgentView
 * 读文本、看图片、写文件。下面这几件事三个方法都成立，各自说明里不再重复：
 * 相对路径、`~` 怎么解析，哪些路径越出了范围，由当前空间决定（环境报告里写着根目录）；越界的直接拒绝。
 * 读写保留原文件的编码（UTF-8、带 BOM、UTF-16、GB18030），认不出编码或有非法字节的按二进制处理。
 * 写是原子的，失败不会留下半截文件；路径是符号链接时读写它指向的那个文件，链接本身不变。
 * 哪些文件要先问用户（凭证、系统敏感路径……）也由当前空间决定：读被拒只是那一项失败，写被拒是整批不写。
 * 列目录、搜文本用命令做（`velar:shell` 的 run：ls、find、rg）。
 */
export interface FileOperationsApi {
  /**
   * @AgentView
   * 读文本文件，每个文件整份读回来。
   * 图片要改用 view；PDF 与其他文档、其他二进制文件、目录、设备文件、超过 20 MB 的文件，都算这个文件失败。
   */
  read(input: FileReadInput, ctx: FileOperationContext): Promise<FileReadResult>
  /**
   * @AgentView
   * 看图片：整张图交给模型，效果和用户上传一样。
   * 只认 PNG、JPEG、GIF、WebP；交给你的图长边不超过 2000 px、base64 后不超过 5 MB，超了先压。
   * PDF 与其他文档、文本文件、其他二进制文件、目录、设备文件、超过 20 MB 的文件，都算这个文件失败。
   */
  view(input: FileViewInput, ctx: FileOperationContext): Promise<FileViewResult>
  /**
   * @AgentView
   * 写文件。**优先整批写**：files 里放几个就改几个，整批一次成败。
   * 等用户确认那段时间里文件被别人改过，整批不写。
   * 路径是管道、设备、套接字，或文件有多个硬链接时不碰。新文本编不成原编码（孤立代理项、GB18030 表示不了的字符）就整批不写。
   */
  edit(input: FileEditInput, ctx: FileOperationContext): Promise<FileEditResult>
}

export class FileOperations implements FileOperationsApi {
  constructor(
    private readonly platform: PlatformCompatibilityApi,
    private readonly history: FileHistoryApi,
  ) {}

  public async read(input: FileReadInput, ctx: FileOperationContext): Promise<FileReadResult> {
    ctx.abortSignal.throwIfAborted()
    const items = batchItems<FileReadItem>(input, FileLimits.readFiles, 'read')
    const files: FileReadResult['files'] = []
    let failed = 0
    let firstFailure: Nullable<AppError> = null
    // 一次调用总共最多 readChars 个字符：预算用完之后的文件根本不读盘，那一项换成失败条目。
    // 这个预算保护的是这一侧的内存与 IPC——正文落在程序的变量里，模型看不到它。
    let remaining = FileLimits.readChars
    for (const item of items) {
      try {
        if (remaining <= 0) throw new AppError('VALIDATION', `本次调用的 ${FileLimits.readChars} 字符预算已被前面的文件用完，这个文件没有读；另起一次调用再读`)
        const result = await this.readOne(item, remaining, ctx)
        remaining -= result.content.length
        files.push(result)
      } catch (error) {
        const failure = AppError.from(error)
        log.debug('one file in a read batch failed', { code: failure.code })
        failed += 1
        firstFailure ??= failure
        files.push(failureEntry(String(item.path), failure))
      }
    }
    if (failed === items.length && firstFailure) throw firstFailure
    return { files }
  }

  public async view(input: FileViewInput, ctx: FileOperationContext): Promise<FileViewResult> {
    ctx.abortSignal.throwIfAborted()
    const items = batchItems<FileViewItem>(input, FileLimits.viewFiles, 'view')
    const attach = ctx.attachImage
    if (!attach) throw new AppError('PLATFORM', '这个宿主没有把图交给模型的通道，view 用不了')
    const files: FileViewResult['files'] = []
    let failed = 0
    let firstFailure: Nullable<AppError> = null
    for (const [index, item] of items.entries()) {
      try {
        const viewed = await this.viewOne(item, ctx)
        const where = viewed.region ? `，区域 ${viewed.region.x},${viewed.region.y} ${viewed.region.width}×${viewed.region.height}` : ''
        attach({
          mediaType: viewed.image.mediaType,
          data: viewed.image.data.toString('base64'),
          label: `图片 ${index + 1}/${items.length}：${viewed.entry.path}（原图 ${viewed.entry.width}×${viewed.entry.height}${where}，给你的是 ${viewed.entry.sent.width}×${viewed.entry.sent.height}）`,
        })
        files.push(viewed.entry)
      } catch (error) {
        const failure = AppError.from(error)
        log.debug('one file in a view batch failed', { code: failure.code })
        failed += 1
        firstFailure ??= failure
        files.push(failureEntry(String(item.path), failure))
      }
    }
    if (failed === items.length && firstFailure) throw firstFailure
    return { files }
  }

  public async edit(input: FileEditInput, ctx: FileOperationContext): Promise<FileEditResult> {
    ctx.abortSignal.throwIfAborted()
    const items = batchItems<FileEditItem>(input, FileLimits.editFiles, 'edit')
    // 第一段：每个文件定位、按真实路径判重、过空间的审查、把改法定下来，什么都不写；
    // 有任何问题就整批失败，问题全部列出来让程序一次改完。第一次被拒就停：这一批注定不写，不再为后面的文件打扰用户。
    const plans: Array<{ plan: FileEditPlan; location: FileLocation }> = []
    const problems: FileEditProblem[] = []
    const seen = new Set<string>()
    for (const [index, item] of items.entries()) {
      const problem = (reason: FileEditProblem['reason'], message: string, path = String(item.path)): FileEditProblem => ({ file: index, path, reason, message })
      const location = await this.locate(item.path, ctx).catch((error: unknown) => AppError.from(error))
      if (location instanceof AppError) {
        problems.push(problem(location.code === 'PERMISSION' ? 'denied' : 'invalid', location.message))
        continue
      }
      const identity = fileIdentity(location.target, this.platform.getPlatform())
      if (seen.has(identity)) {
        problems.push(problem('invalid', '同一个文件在这一批里出现了不止一次（写法不同、经符号链接指向同一个文件的也算）；把它的改动合进一项', location.path))
        continue
      }
      seen.add(identity)
      try {
        await confirmAll(await ctx.files.reviewWrite(location.target), ctx)
      } catch (error) {
        const failure = AppError.from(error)
        log.debug('a write was not allowed', { code: failure.code })
        problems.push(problem('denied', failure.message, location.path))
        break
      }
      const planned = await this.planOne(index, location, item)
      if ('reason' in planned) problems.push(planned)
      else plans.push({ plan: planned, location })
    }
    if (!isEmpty(problems)) throw unresolvedEditFailure(problems)

    // 审批期间文件可能又被别人改了：写之前再 stat 一次，印记没变的大文件不重读，其余重读核版本；变了就整批不写。
    for (const { plan } of plans) {
      const now = stampOf(await stat(plan.target).catch(() => null))
      if (stampProvesUnchanged(plan.stamp, now)) continue
      const current = await currentFileVersion(plan.target)
      if (current !== plan.baseVersion) {
        problems.push({ file: plan.index, path: plan.path, reason: 'stale', message: '等用户确认期间文件被改过了；重新读一遍再改', currentVersion: toOptional(current) })
      }
    }
    if (!isEmpty(problems)) throw unresolvedEditFailure(problems)

    // 第二段：改动前的内容先留成版本，再整批交给空间落盘。
    const results = plans.map(({ plan, location }) => withLinkTarget(this.receiptOf(plan), location.target, location.linked))
    const writes = plans.map(({ plan }) => writeOfPlan(plan))
    try {
      await ctx.files.commit(writes)
    } catch (error) {
      throw commitFailure(error, plans.map(({ plan }) => plan))
    }
    return { files: results }
  }

  /** 把一个文件的改法定下来但不写：返回写入计划，或者这个文件的问题。文件系统操作都对 target，回执与报错里的路径用 location.path。 */
  private async planOne(index: number, location: FileLocation, item: FileEditItem): Promise<FileEditPlan | FileEditProblem> {
    const { path, target } = location
    const problem = (message: string, extra: Partial<FileEditProblem> = {}): FileEditProblem => ({ file: index, path, reason: 'invalid', message, ...extra })
    const restoring = isPresent(item.restore)
    const wholeFile = isPresent(item.newText)
    if (restoring === wholeFile) return problem(restoring ? 'newText 与 restore 只能用一种' : '给 newText 整个写入，或者给 restore 回滚，两者选一')
    if (wholeFile && !isString(item.newText)) return problem('newText 要是字符串')
    const existing = await stat(target).catch(() => null)
    if (existing?.isDirectory()) return problem(`路径是目录，不是文件：${path}`)
    // 管道、设备、套接字：读它可能永远等不到数据（读命名管道会一直挂着），整个替换又会把它换成普通文件，一律不碰。
    if (existing && !existing.isFile()) return problem(`路径不是普通文件（管道、设备或套接字），不能当文本改：${path}`)
    // 原子替换是写一个新文件再改名：多个硬链接的文件换完就和其余链接分家了，一律不碰。
    if (existing && existing.nlink > 1) return problem(`文件有 ${existing.nlink} 个硬链接，原子替换会让它和其余链接分家，不能在这里改：${path}；用命令改`)
    if (existing && existing.size > FileLimits.fileBytes) return problem(`现有文件太大，不能在这里整份覆盖：${existing.size} 字节，上限 ${FileLimits.fileBytes} 字节；用命令就地改（sed -i、awk）`)
    const stamp = stampOf(existing)
    // 父路径已经存在却不是目录，写入注定失败，在计划期就报出来（缺失的父目录落盘时会补建）。
    const parentCode = await stat(dirname(target)).then((parent) => (parent.isDirectory() ? null : 'ENOTDIR')).catch((error: unknown) => readErrnoCode(error))
    if (parentCode === 'ENOTDIR') return problem(`上级路径不是目录：${dirname(path)}`)

    if (isString(item.restore)) {
      const snapshot = this.history.recall(target, item.restore)
      if (!snapshot) return problem(`历史里没有版本 ${item.restore}：只有本次运行里改动前留下的最近几份，而且只在内存里`)
      // 回滚后的字符数在计划期就算好：认不出是文本的版本在这里就拒，不会写完了才报错。
      const restored = textCodec.decode(snapshot.buffer)
      if (!restored) return problem(`版本 ${item.restore} 不是能认出的文本（二进制、非法字节或认不出的编码），不能在这里回滚`)
      const current = existing?.isFile() ? await readRawFile(target, path) : null
      const baseVersion = current ? fileVersionOf(current) : null
      const stale = staleProblem(item.version, baseVersion)
      if (stale) return problem(stale.message, stale)
      return { kind: 'restore', index, path, target, current, bytes: snapshot.buffer, version: snapshot.version, totalChars: restored.content.length, baseVersion, stamp }
    }

    const newText = item.newText ?? ''
    if (newText.includes('\0')) return problem('newText 里有 NUL 字节，是二进制数据，不能当文本写入')
    let previous: Nullable<Buffer> = null
    let encoding: TextEncoding = 'utf8'
    if (existing?.isFile()) {
      // 已有的文件必须是文本才许整个覆盖：二进制文件被 newText 盖掉就没了，也留不下能回滚的版本。
      // 不超过 versionedBytes 的整个读进来留版本；更大的留不下版本，只读开头一段认编码、拒二进制。
      try {
        if (existing.size <= FileLimits.versionedBytes) {
          const text = await readTextFile(target, path)
          previous = text.buffer
          encoding = text.encoding
        } else {
          encoding = await readTextEncodingFromHead(target, path)
        }
      } catch (error) {
        const failure = AppError.from(error)
        log.debug('an existing file cannot be overwritten as text', { code: failure.code })
        return problem(`现有文件不能按文本重写（${failure.message}）；二进制文件用命令替换`, { reason: failure.code === 'PERMISSION' ? 'denied' : 'invalid' })
      }
    }
    // 按原编码写不出来（孤立代理项、GB18030 表示不了的字符）就是这个文件的问题，整批不写，不静默换成替换字符或别的编码。
    let bytes: Buffer
    try {
      bytes = textCodec.encode(newText, encoding)
    } catch (error) {
      return problem(`newText 不能按 ${encoding} 无损写进这个文件：${AppError.from(error).message}`)
    }
    const baseVersion = previous ? fileVersionOf(previous) : existing?.isFile() ? await currentFileVersion(target) : null
    const stale = staleProblem(item.version, baseVersion)
    if (stale) return problem(stale.message, stale)
    return { kind: 'write', index, path, target, created: !existing, previous, bytes, totalChars: newText.length, baseVersion, stamp }
  }

  /** 一份计划落盘前的那一步：把改动前的内容留成版本，给出这个文件的回执。 */
  private receiptOf(plan: FileEditPlan): FileEditItemResult {
    if (plan.kind === 'restore') {
      const previousVersion = plan.current ? this.history.remember(plan.target, plan.current) : null
      return { path: plan.path, action: 'restored', version: plan.version, previousVersion, bytes: plan.bytes.byteLength, totalChars: plan.totalChars }
    }
    const previousVersion = plan.previous ? this.history.remember(plan.target, plan.previous) : null
    return { path: plan.path, action: 'written', created: plan.created, version: fileVersionOf(plan.bytes), previousVersion, bytes: plan.bytes.byteLength, totalChars: plan.totalChars }
  }

  private async readOne(item: FileReadItem, budgetChars: number, ctx: FileOperationContext): Promise<FileTextResult> {
    const { path, target } = await this.locate(item.path, ctx)
    await confirmAll(await ctx.files.reviewRead(target), ctx)
    if (isPresent(item.version)) {
      const snapshot = isString(item.version) ? this.history.recall(target, item.version) : null
      if (!snapshot) throw new AppError('NOT_FOUND', `历史里没有 ${path} 的版本 ${String(item.version)}：只有本次运行里改动前留下的最近几份，而且只在内存里`)
      return readWholeText(path, snapshot.buffer, budgetChars)
    }
    const buffer = await readBoundedFile(target, path, FileLimits.fileBytes)
    const media = detectMediaType(buffer)
    if (media) throw new AppError('VALIDATION', media.kind === 'image' ? `${path} 是图片，用 view 看` : `${path} 是 PDF，不是文本；文档不在这里读`)
    return readWholeText(path, buffer, budgetChars)
  }

  /**
   * 看一张图：在上限以内、又没要求裁的，原样交出去；超了或要裁，才请宿主处理。
   * 大多数图不用动——压分辨率只是给超限的图兜底，裁一块只在模型自己要放大看时才发生。
   */
  private async viewOne(item: FileViewItem, ctx: FileOperationContext): Promise<FileViewed> {
    const { path, target } = await this.locate(item.path, ctx)
    await confirmAll(await ctx.files.reviewRead(target), ctx)
    const buffer = await readBoundedFile(target, path, FileLimits.fileBytes)
    const media = detectMediaType(buffer)
    if (media?.kind !== 'image') {
      throw new AppError('VALIDATION', media
        ? `${path} 是 PDF；view 只看图片，文档不在这里读`
        : `${path} 不是模型能看的图片（PNG、JPEG、GIF、WebP）；文本文件用 read，别的格式先转换`)
    }
    const size = readImageSize(buffer, media.mediaType)
    if (!size) throw new AppError('VALIDATION', `${path} 的图片头读不出来，文件可能坏了`)
    const region = isPresent(item.region) ? clampImageRegion(item.region, size) : null
    if (isPresent(item.region) && !region) throw new AppError('VALIDATION', `region 整块都在图外：${path} 是 ${size.width}×${size.height}`)

    const fits = !region
      && Math.max(size.width, size.height) <= FileLimits.imageEdge
      && base64Length(buffer.byteLength) <= FileLimits.imageBase64Bytes
    if (fits) {
      const entry = { path, mediaType: media.mediaType, width: size.width, height: size.height, sent: { ...size } }
      return { entry, image: { data: buffer, mediaType: media.mediaType }, region }
    }

    const resize = ctx.files.resizeImage
    if (!resize) {
      throw new AppError('PLATFORM', region
        ? '这个宿主裁不了图；先用命令把那一块裁出来再看'
        : `${path} 是 ${size.width}×${size.height}，超过长边 ${FileLimits.imageEdge} px 或 ${FileLimits.imageBase64Bytes} 字节的上限，这个宿主压不了；先用命令缩小（macOS：sips -Z ${FileLimits.imageEdge} 原图 --out 新图；装了 ImageMagick 的：magick 原图 -resize ${FileLimits.imageEdge}x${FileLimits.imageEdge} 新图）`)
    }
    const request: Omit<FileImageResizeRequest, 'longEdge'> = { data: buffer, mediaType: media.mediaType }
    if (region) request.region = region
    const shrunk = await shrinkImageToLimits(resize, request, { longEdge: FileLimits.imageEdge, base64Bytes: FileLimits.imageBase64Bytes })
    const entry = { path, mediaType: shrunk.mediaType, width: size.width, height: size.height, sent: { width: shrunk.width, height: shrunk.height } }
    return { entry, image: { data: shrunk.data, mediaType: shrunk.mediaType }, region }
  }

  /** 把模型给的路径交给空间定下来：先规整特殊空白与开头的 `@`，不是字符串的直接拒绝。 */
  private locate(path: unknown, ctx: FileOperationContext): Promise<FileLocation> {
    if (!isString(path) || isBlank(path)) return Promise.reject(new AppError('VALIDATION', '每一项都要有 path（字符串）'))
    return ctx.files.locate(this.platform.normalizeUserPathInput(path))
  }

}

/** 整个进程只有一份的文件操作；宿主把它挂在代码面的 `files` 命名空间上，每次调用时把自己空间的端口塞进 ctx。 */
export const fileOperations: FileOperationsApi = new FileOperations(currentPlatform, new FileHistory())
