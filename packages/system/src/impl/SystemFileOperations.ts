/**
 * 三个文件操作：`SystemFileOperations` 与整个进程唯一的 `systemFileOperations`。接口 `SystemFileOperationsApi` 在本文件的类上方。
 * `read`、`view`、`edit` 各调一个方法；三个都是一批文件（一个文件就一项），读和看里某个文件失败只标记它那一项、全部失败才整个报错，写是整批同成败；列目录和搜文本由 `run` 用系统命令做。PDF 与其他文档不在这里看。
 */

import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isArray, isEmpty, isPresent, Log, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'
import type { PlatformCompatibilityApi } from '@velaros-ai/platform'
import { currentPlatform } from '@velaros-ai/platform'
import { textCodec } from '@velaros-ai/text-files'
import type { TextEncoding } from '@velaros-ai/text-files/contracts'

import { SystemFileLimits } from '../contract/constants.js'
import type { SystemToolContext } from '../contract/requires.js'
import type { SystemEditFileInput, SystemEditFileResult, SystemEditInput, SystemEditPlan, SystemEditProblem, SystemEditResult, SystemReadFileInput, SystemReadFileResult, SystemReadInput, SystemReadResult, SystemTextFileContent, SystemViewFileInput, SystemViewFileResult, SystemViewInput, SystemViewResult } from '../types/files.js'
import { assertFileBatchSize, failureEntry, staleProblem, unresolvedEditFailure, withLinkTarget } from '../utils/file-batch.js'
import { comparisonPath, confirmCredentialAccess, confirmSensitiveSystemMutation } from '../utils/file-safety.js'
import { readErrnoCode, writeSystemFileAtomically } from '../utils/fs.js'
import {
  currentFileVersion,
  detectMediaType,
  fileVersionOf,
  readBoundedFile,
  readRawSystemFileBuffer,
  readSystemTextEncodingFromHead,
  readSystemTextFile,
  readWholeText,
  stampOf,
  stampProvesUnchanged,
} from '../utils/text-file.js'

import type { SystemFileHistoryApi } from './SystemFileHistory.js'
import { SystemFileHistory } from './SystemFileHistory.js'

const log = Log.tag('SystemFileOperations')

/**
 * 三个文件操作：读文本、看图片与 PDF、写。`read`、`view`、`edit` 各调一个方法；列目录和搜文本由 `run` 用系统命令做。
 *
 * 实现是 `SystemFileOperations`，整个进程只有一份（`systemFileOperations`）。
 *
 * @AgentView
 * 下面这几件事**三个方法都成立**，各自说明里不再重复：
 * 路径按用户输入规整，`~` 展开到家目录，相对路径相对默认工作目录。
 * **位置一律按字符算，没有行的概念**——offset 与 range 都是字符下标。
 * 读写保留原文件的编码（UTF-8、带 BOM、UTF-16、GB18030），认不出编码或有非法字节的按二进制处理。
 * 写是原子替换（先写临时文件、fsync 再换上去，权限位原样保留），失败不会留下半截文件。
 * 碰凭证文件（私钥、云凭证、口令库）与系统敏感路径前先向用户确认，被拒就不动。
 */
export interface SystemFileOperationsApi {
  /**
   * @AgentView
   * 读文本文件。
   * 每个文件从 offset 起最多 maxChars 个字符，两个都不传就一次读到上限；不切开代理对。路径是符号链接时读它指向的文件。
   * 图片要改用 view；PDF 与其他文档、其他二进制文件、目录、设备文件、超过 20 MB 的文件，都算这个文件失败。
   */
  read(input: SystemReadInput, ctx: SystemToolContext): Promise<SystemReadResult>
  /**
   * @AgentView
   * 看图片：整张图交给模型，效果和用户上传一样。
   * 只认 PNG、JPEG、GIF、WebP，单张最大 5 MB；PDF 与其他文档、文本文件、其他二进制文件、目录、设备文件、超过 20 MB 的文件，都算这个文件失败。
   */
  view(input: SystemViewInput, ctx: SystemToolContext): Promise<SystemViewResult>
  /**
   * @AgentView
   * 写文件。**优先用批量事务**：files 里放几个就改几个，整批是一次事务、一次审批、一个撤销点。
   * 要用户确认而被拒时是**整批不写**；等用户确认那段时间里文件被别人改过，同样整批不写。
   * 路径先解开符号链接：判重、审批、写入都按它指向的那个文件，链接本身不会被换成普通文件。路径是管道、设备、套接字，或文件有多个硬链接时不碰。
   * edits 写进去的文本跟着原文的换行风格走（CRLF 文件里的裸 LF 换成 CRLF），newText 整个写入原样写。新文本编不成原编码（孤立代理项、GB18030 表示不了的字符）就整批不写。
   * 写的过程中出错时前面的文件已经落盘，错误的 context.applied 里点名是哪几个，这时不能整批重发。
   */
  edit(input: SystemEditInput, ctx: SystemToolContext): Promise<SystemEditResult>
}

class SystemFileOperations implements SystemFileOperationsApi {
  private readonly platform: PlatformCompatibilityApi
  private readonly history: SystemFileHistoryApi

  constructor(platformTools: PlatformCompatibilityApi, history: SystemFileHistoryApi) {
    this.platform = platformTools
    this.history = history
  }

  public async read(input: SystemReadInput, ctx: SystemToolContext): Promise<SystemReadResult> {
    if (!isArray(input.files)) throw new AppError('VALIDATION', '缺少 files：每个要读的文件一项')
    assertFileBatchSize(input.files.length, SystemFileLimits.readFiles, 'read')
    const files: SystemReadResult['files'] = []
    const failures: AppError[] = []
    // 一次调用总共最多 readChars 个字符：预算用完之后的文件根本不读盘，那一项换成失败条目。
    // 这个预算保护的是这一侧的内存与 IPC——正文落在程序的变量里，模型看不到它。
    let remaining = SystemFileLimits.readChars
    for (const file of input.files) {
      if (remaining <= 0) {
        files.push(failureEntry(file.path, new AppError('VALIDATION', `本次调用的 ${SystemFileLimits.readChars} 字符预算已被前面的文件用完，这个文件没有读；另起一次调用再读`)))
        continue
      }
      try {
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
    return { files }
  }

  public async view(input: SystemViewInput, ctx: SystemToolContext): Promise<SystemViewResult> {
    if (!isArray(input.files)) throw new AppError('VALIDATION', '缺少 files：每张要看的图片一项')
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
    if (!isArray(input.files)) throw new AppError('VALIDATION', '缺少 files：每个要写的文件一项')
    assertFileBatchSize(input.files.length, SystemFileLimits.editFiles, 'edit')
    // 第一段：每个文件按解开符号链接后的真实路径判重、过审批（敏感路径、凭证文件），再把每一处定下来，什么都不写；
    // 有任何问题就整批失败，问题全部列出来让调用方一次改完。第一次被拒就停：这一批注定不写，不再为后面的文件打扰用户。
    const plans: SystemEditPlan[] = []
    const problems: SystemEditProblem[] = []
    const seen = new Set<string>()
    for (const [index, file] of input.files.entries()) {
      const resolvedPath = this.resolvePath(file.path, ctx)
      const target = await resolveRealPath(resolvedPath)
      const identity = comparisonPath(target, process.platform)
      if (seen.has(identity)) {
        problems.push({ file: index, path: resolvedPath, reason: 'invalid', message: '同一个文件在这一批里出现了不止一次（写法不同、经符号链接指向同一个文件的也算）；把它的改动合进一项' })
        continue
      }
      seen.add(identity)
      try {
        await confirmSensitiveSystemMutation(ctx, target, 'write')
        await confirmCredentialAccess(ctx, target, 'write')
      } catch (error) {
        const failure = AppError.from(error)
        log.debug('sensitive path write was not approved', { path: target, code: failure.code })
        problems.push({ file: index, path: resolvedPath, reason: 'denied', message: failure.message })
        break
      }
      const planned = await this.planOne(index, resolvedPath, target, file)
      if (isArray(planned)) problems.push(...planned)
      else plans.push(planned)
    }
    if (!isEmpty(problems)) throw unresolvedEditFailure(problems)
    // 审批期间文件可能又被别人改了：写之前再 stat 一次，印记没变的大文件不重读，其余重读核版本；变了就整批不写。
    for (const plan of plans) {
      const now = stampOf(await stat(plan.target).catch(() => null))
      if (stampProvesUnchanged(plan.stamp, now)) continue
      const current = await currentFileVersion(plan.target)
      if (current !== plan.baseVersion) {
        problems.push({ file: plan.index, path: plan.path, reason: 'stale', message: '等用户确认期间文件被改过了；重新读一遍再改', currentVersion: toOptional(current) })
      }
    }
    if (!isEmpty(problems)) throw unresolvedEditFailure(problems)
    // 第二段：按顺序写。写到一半出错就原样抛出，不标 not-applied，前面已写的文件在 context 里点名。
    const files: SystemEditFileResult[] = []
    for (const plan of plans) {
      try {
        files.push(withLinkTarget(await this.applyOne(plan), plan.path, plan.target))
      } catch (error) {
        throw new AppError(AppError.from(error).code, `前 ${files.length} 个文件已经写入，files[${plan.index}] ${plan.path} 写入失败：${AppError.from(error).message}`, error, { applied: files.map((file) => file.path) })
      }
    }
    return { files }
  }

  /** 把一个文件的改法定下来但不写：返回写入计划，或者这个文件的问题清单。文件系统操作都对 target（真实路径），回执里的路径用 resolvedPath。 */
  private async planOne(index: number, resolvedPath: string, target: string, file: SystemEditFileInput): Promise<SystemEditPlan | SystemEditProblem[]> {
    const problem = (message: string, extra: Partial<SystemEditProblem> = {}): SystemEditProblem[] => [{ file: index, path: resolvedPath, reason: 'invalid', message, ...extra }]
    const restoring = isPresent(file.restore)
    const wholeFile = isPresent(file.newText)
    if (!restoring && !wholeFile) return problem('给 newText 整个写入，或者给 restore 回滚，两者选一')
    if (restoring && wholeFile) return problem('newText 与 restore 只能用一种')
    const existing = await stat(target).catch(() => null)
    if (existing?.isDirectory()) return problem(`路径是目录，不是文件：${resolvedPath}`)
    // 管道、设备、套接字：读它可能永远等不到数据（读命名管道会一直挂着），整个替换又会把它换成普通文件，一律不碰。
    if (existing && !existing.isFile()) return problem(`路径不是普通文件（管道、设备或套接字），不能当文本改：${resolvedPath}`)
    // 原子替换是写一个新文件再改名：多个硬链接的文件换完就和其余链接分家了，一律不碰。
    if (existing && existing.nlink > 1) return problem(`文件有 ${existing.nlink} 个硬链接，原子替换会让它和其余链接分家，不能在这里改：${resolvedPath}；用 run 改`)
    const stamp = stampOf(existing)
    // 父路径已经存在却不是目录，写入注定失败，在计划期就报出来（缺失的父目录写的时候会补建）。
    const parentCode = await stat(dirname(target)).then((parent) => (parent.isDirectory() ? null : 'ENOTDIR')).catch((error: unknown) => readErrnoCode(error))
    if (parentCode === 'ENOTDIR') return problem(`上级路径不是目录：${dirname(target)}`)

    if (isPresent(file.restore)) {
      const snapshot = this.history.recall(target, file.restore)
      if (!snapshot) return problem(`历史里没有版本 ${file.restore}：只有本次运行里改动前留下的最近几份，而且只在内存里`)
      // 回滚后的字符数在计划期就算好：认不出是文本的版本在这里就拒，不会写完了才报错。
      const restored = textCodec.decode(snapshot.buffer)
      if (!restored) return problem(`版本 ${file.restore} 不是能认出的文本（二进制、非法字节或认不出的编码），不能在这里回滚`)
      if (existing?.isFile() && existing.size > SystemFileLimits.fileBytes) return problem(`现有文件太大，不能在这里回滚覆盖：${existing.size} 字节，上限 ${SystemFileLimits.fileBytes} 字节`)
      const current = existing?.isFile() ? await readRawSystemFileBuffer(target) : null
      const baseVersion = current ? fileVersionOf(current) : null
      const stale = staleProblem(file.version, baseVersion)
      if (stale) return problem(stale.message, stale)
      return { kind: 'restore', index, path: resolvedPath, target, current, snapshot, totalChars: restored.content.length, baseVersion, stamp }
    }

    // 到这里只剩整个写入：上面两支（restore、两者选一）都已经 return。
    {
      const newText = file.newText ?? ''
      if (newText.includes('\0')) return problem('newText 里有 NUL 字节，是二进制数据，不能当文本写入')
      if (existing?.isFile() && existing.size > SystemFileLimits.fileBytes) return problem(`现有文件太大，不能在这里整份覆盖：${existing.size} 字节，上限 ${SystemFileLimits.fileBytes} 字节；用 run 就地改（sed -i、awk）`)
      let previous: Nullable<SystemTextFileContent> = null
      let encoding: TextEncoding = 'utf8'
      if (existing?.isFile()) {
        // 已有的文件必须是文本才许整个覆盖：二进制文件被 newText 盖掉就没了，也留不下能回滚的版本。
        // 不超过 versionedBytes 的整个读进来留版本；更大的留不下版本，只读开头一段认编码、拒二进制。
        try {
          if (existing.size <= SystemFileLimits.versionedBytes) {
            previous = await readSystemTextFile(target)
            encoding = previous.encoding
          } else {
            encoding = await readSystemTextEncodingFromHead(target)
          }
        } catch (error) {
          const failure = AppError.from(error)
          log.debug('an existing file cannot be overwritten as text', { path: target, code: failure.code })
          return problem(`现有文件不能按文本重写（${failure.message}）；二进制文件用 run 替换`, { reason: failure.code === 'PERMISSION' ? 'denied' : 'invalid' })
        }
      }
      // 按原编码写不出来（孤立代理项、GB18030 表示不了的字符）就是这个文件的问题，整批不写，不静默换成替换字符或别的编码。
      let bytes: Buffer
      try {
        bytes = textCodec.encode(newText, encoding)
      } catch (error) {
        return problem(`newText 不能按 ${encoding} 无损写进这个文件：${AppError.from(error).message}`)
      }
      const baseVersion = previous ? fileVersionOf(previous.buffer) : existing?.isFile() ? await currentFileVersion(target) : null
      const stale = staleProblem(file.version, baseVersion)
      if (stale) return problem(stale.message, stale)
      return { kind: 'write', index, path: resolvedPath, target, created: !existing, previous, newText, bytes, baseVersion, stamp }
    }
  }

  private async applyOne(plan: SystemEditPlan): Promise<SystemEditFileResult> {
    if (plan.kind === 'restore') {
      const previousVersion = plan.current ? this.history.remember(plan.target, plan.current) : null
      await mkdir(dirname(plan.target), { recursive: true })
      await writeSystemFileAtomically(plan.target, plan.snapshot.buffer)
      return { path: plan.path, action: 'restored', version: plan.snapshot.version, previousVersion, bytes: plan.snapshot.buffer.byteLength, totalChars: plan.totalChars }
    }
    const previousVersion = plan.previous ? this.history.remember(plan.target, plan.previous.buffer) : null
    await mkdir(dirname(plan.target), { recursive: true })
    await writeSystemFileAtomically(plan.target, plan.bytes)
    return { path: plan.path, action: 'written', created: plan.created, version: fileVersionOf(plan.bytes), previousVersion, bytes: plan.bytes.byteLength, totalChars: plan.newText.length }
  }

  private async readOne(file: SystemReadFileInput, budgetChars: number, ctx: SystemToolContext): Promise<SystemReadFileResult> {
    const resolvedPath = this.resolvePath(file.path, ctx)
    const target = await resolveRealPath(resolvedPath)
    await confirmCredentialAccess(ctx, target, 'read')
    if (isPresent(file.version)) {
      const snapshot = this.history.recall(target, file.version)
      if (!snapshot) {
        throw new AppError('NOT_FOUND', `历史里没有 ${resolvedPath} 的版本 ${file.version}：只有本次运行里改动前留下的最近几份，而且只在内存里`)
      }
      return readWholeText(resolvedPath, snapshot.buffer, budgetChars)
    }
    const buffer = await readBoundedFile(target, SystemFileLimits.fileBytes)
    const media = detectMediaType(buffer)
    if (media) {
      throw new AppError('VALIDATION', media.kind === 'image' ? `${resolvedPath} 是图片，用 view 看` : `${resolvedPath} 是 PDF，不是文本；文档不在这里读`)
    }
    return readWholeText(resolvedPath, buffer, budgetChars)
  }

  /** 看一张图片：整张作为内容块交给模型，返回元数据、内容块和一行说明；不是模型认得的图片就报错。 */
  private async viewOne(file: SystemViewFileInput, ctx: SystemToolContext): Promise<{ entry: SystemViewFileResult; part: SystemViewResult['modelContent'][number]; label: string }> {
    const resolvedPath = this.resolvePath(file.path, ctx)
    const target = await resolveRealPath(resolvedPath)
    await confirmCredentialAccess(ctx, target, 'read')
    const buffer = await readBoundedFile(target, SystemFileLimits.fileBytes)
    const media = detectMediaType(buffer)
    if (media?.kind !== 'image') {
      throw new AppError('VALIDATION', media
        ? `${resolvedPath} 是 PDF；这个工具只看图片，文档不在这里读`
        : `${resolvedPath} 不是模型能看的图片（PNG、JPEG、GIF、WebP）；文本文件用 read，别的格式先转换`)
    }
    if (buffer.byteLength > SystemFileLimits.imageBytes) {
      throw new AppError('VALIDATION', `图片太大，不能交给模型：${buffer.byteLength} 字节，上限 ${SystemFileLimits.imageBytes} 字节；先用 run 缩小`)
    }
    return {
      entry: { path: resolvedPath, mediaType: media.mediaType, bytes: buffer.byteLength },
      part: { type: 'image-data', data: buffer.toString('base64'), mediaType: media.mediaType },
      label: resolvedPath,
    }
  }

  /** 把用户输入的路径变成绝对路径：规整特殊空格与开头的 `@`，`~` 和相对路径都交给宿主按它的家目录与默认工作目录解析。 */
  private resolvePath(path: string, ctx: SystemToolContext): string {
    return ctx.system.resolvePath(this.platform.normalizeUserPathInput(path))
  }
}

/** 整个进程只有一份的文件操作，按当前进程的平台规整路径。 */
export const systemFileOperations: SystemFileOperationsApi = new SystemFileOperations(currentPlatform, new SystemFileHistory())
