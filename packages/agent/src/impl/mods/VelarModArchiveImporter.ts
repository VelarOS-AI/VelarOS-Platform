import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

import JSZip, { type JSZipObject } from 'jszip'

import { isEmpty, isNumber, isPlainObject, isPresent, stringifyPretty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { velarosModEnvelopes } from '@velaros-ai/kernel'
import { VelarosModManifestFileName } from '@velaros-ai/kernel/contracts'

import { VelarModArchiveFiles, VelarModArchiveLimits } from '../../contract/constants.js'
import type { InstallScannedVelarModArchiveRequest, PreparedVelarModInstall, ScannedArchive, ScanSession, VelarModArchiveEntry, VelarModArchiveFinding, VelarModArchiveImporterOptions, VelarModArchiveInstallFailureReason, VelarModArchiveScanReport, VelarModPermissionDescriptor } from '../../types/mods.js'
import { assertArchiveEntryPath, countContributions, readAgentMetadata } from '../../utils/mods/archive'
import { readZipSizes } from '../../utils/mods/velar-mod-archive-importer'
import { AgentTuning } from '../../utils/tuning'
import { parseAgentModManifest } from '../../utils/wire/mods'

/** Mod 包的扩展名，等价于 `VelarModArchiveFiles.archiveExtension`。 */
export const VelarModArchiveExtension: string = VelarModArchiveFiles.archiveExtension
/** 归档内签名文件的固定名字，等价于 `VelarModArchiveFiles.signatureFileName`。 */
export const VelarModSignatureFileName: string = VelarModArchiveFiles.signatureFileName
/** 归档文件本身的字节上限，等价于 `VelarModArchiveLimits.maxArchiveBytes`。 */
export const MaxArchiveBytes: number = VelarModArchiveLimits.maxArchiveBytes
/** 解压后总字节上限，等价于 `VelarModArchiveLimits.maxExpandedBytes`。 */
export const MaxExpandedBytes: number = VelarModArchiveLimits.maxExpandedBytes
/** 清单文件的字节上限，等价于 `VelarModArchiveLimits.maxManifestBytes`。 */
export const MaxManifestBytes: number = VelarModArchiveLimits.maxManifestBytes
/** 归档里允许的文件数上限，等价于 `VelarModArchiveLimits.maxFileCount`。 */
export const MaxFileCount: number = VelarModArchiveLimits.maxFileCount
/** 允许的最大压缩比，等价于 `VelarModArchiveLimits.maxCompressionRatio`。 */
export const MaxCompressionRatio: number = VelarModArchiveLimits.maxCompressionRatio
/** 扫描会话的缺省有效期（ms），值在 `AgentTuning.mods.scanSessionTtlMs`。 */
export const DefaultScanSessionTtlMs: number = AgentTuning.mods.scanSessionTtlMs

/**
 * `.velarmod` 归档的导入面：扫描一个包并给出可展示的结论，用户确认后再把它解到暂存目录。
 * 只做与宿主无关的那部分——权限怎么呈现、签名信谁由 options 里的宿主策略端口决定。
 *
 * 宿主装配期建一个、长期持有；实例内只暂存扫描会话（扫到了什么、包在哪、什么时候过期），
 * 每次扫描前先清掉过期的。扫描不落任何东西到磁盘，解包只写系统临时目录且失败即清理。
 * 一切拒绝都是抛 `AppError`（`VALIDATION` 是包本身不合格，`SECURITY` 是安全判定），不静默降级。
 * 实现是 `VelarModArchiveImporter`。
 */
export interface VelarModArchiveImporterApi {
  /**
   * 扫描一个 `.velarmod` 包并留下一次扫描会话，返回给用户看的报告：
   * 摘要（digest、体积、文件数）、mod 身份、信任来源、要申请的权限、贡献统计，
   * 以及 warning / blocking 两级发现与最终的 `installable`。
   * 扩展名不对、不是 ZIP、超限、带符号链接、路径越界、压缩比异常、manifest 缺失或非法等一律抛错。
   */
  scan(path: string): Promise<VelarModArchiveScanReport>
  /**
   * 用户确认后落地安装的前半程：校验这次确认对得上刚才那次扫描，然后把包解到一个新建的临时暂存目录，
   * 返回暂存路径、获批权限清单与清理回调（真正搬进 mod 目录由调用方做，清理由调用方负责调）。
   *
   * 会话过期、digest 对不上、有 blocking 发现、重扫发现包被换过、批了没声明的权限、
   * 未签名包没拿到显式信任确认——每一条都抛 `AppError` 并带上机器可读的 reason。
   * 成功后这次扫描会话即作废，同一次扫描不能装两遍。
   */
  prepareInstall(request: InstallScannedVelarModArchiveRequest): Promise<PreparedVelarModInstall>
}

/**
 * Host-neutral `.velarmod` scan, trust ticket, and extraction transaction.
 * Permission presentation and marketplace signature roots are injected host policy ports.
 */
export class VelarModArchiveImporter implements VelarModArchiveImporterApi {
  private readonly sessions = new Map<string, ScanSession>()
  private readonly now: () => number
  private readonly nextScanId: () => string
  private readonly sessionTtlMs: number

  public constructor(private readonly options: VelarModArchiveImporterOptions) {
    this.now = options.now ?? Date.now
    this.nextScanId = options.nextScanId ?? randomUUID
    this.sessionTtlMs = options.scanSessionTtlMs ?? DefaultScanSessionTtlMs
  }

  public async scan(path: string): Promise<VelarModArchiveScanReport> {
    const scanned = await this.inspect(path)
    this.evictExpired()
    this.sessions.set(scanned.report.scanId, {
      ...scanned,
      expiresAt: this.now() + this.sessionTtlMs,
    })
    return scanned.report
  }

  public async prepareInstall(
    request: InstallScannedVelarModArchiveRequest,
  ): Promise<PreparedVelarModInstall> {
    this.evictExpired()
    const session = this.sessions.get(request.scanId)
    if (!session) throw new AppError('VALIDATION', '这次扫描的结果已经过期：确认安装要在扫描后的有效期内完成，请重新扫描这个包再装。')
    if (session.report.digest !== request.digest) {
      throw new AppError('SECURITY', '安装确认里的 digest 和扫描时记下的对不上：确认的不是刚才扫的那个包，已拒绝安装。')
    }
    if (!session.report.installable) throw new AppError('SECURITY', '扫描报告里有 blocking 级发现：这些问题不解决就不能安装这个 Mod。')

    const rescanned = await this.inspect(session.path)
    if (
      rescanned.report.digest !== session.report.digest
      || rescanned.report.mod.id !== session.report.mod.id
      || rescanned.report.mod.version !== session.report.mod.version
    ) {
      this.sessions.delete(request.scanId)
      throw new AppError(
        'SECURITY',
        '确认之后包又被改过了：重扫拿到的 digest 或 mod 身份和扫描时不一致，请重新扫描再确认。',
        undefined,
        { reason: 'archive.changed' satisfies VelarModArchiveInstallFailureReason },
      )
    }

    const declared = new Set(session.report.permissions.map((permission) => permission.id))
    const grantedPermissions = [...new Set(request.grantedPermissions.map((value) => value.trim()).filter(Boolean))]
    const invalid = grantedPermissions.filter((permission) => !declared.has(permission))
    if (!isEmpty(invalid)) {
      throw new AppError(
        'SECURITY',
        `批准了 Mod 没有声明的权限：${invalid.join(', ')}；只能批准 manifest 的 module.permissions 里列出来的权限。`,
        undefined,
        {
          reason: 'permissions.not-declared' satisfies VelarModArchiveInstallFailureReason,
          permissions: invalid,
        },
      )
    }
    if (session.report.trust.kind === 'user-imported' && !request.trustConfirmed) {
      throw new AppError(
        'SECURITY',
        '未签名的导入包必须显式确认来源可信：请在确认安装时带上 trustConfirmed，表示你认可这个包的来源。',
        undefined,
        { reason: 'trust.confirmation-required' satisfies VelarModArchiveInstallFailureReason },
      )
    }

    const stagingDirectory = await mkdtemp(join(tmpdir(), 'velaros-mod-import-'))
    try {
      for (const entry of rescanned.entries) {
        const destination = join(stagingDirectory, ...entry.path.split('/'))
        await mkdir(join(destination, '..'), { recursive: true })
        await writeFile(destination, entry.bytes)
      }
      if (rescanned.report.trust.kind === 'user-imported') {
        const agent = rescanned.manifest.agent
        const stamped = {
          ...rescanned.manifest,
          agent: isPlainObject(agent) ? { ...agent, trust: 'local-dev' } : agent,
        }
        await writeFile(
          join(stagingDirectory, VelarosModManifestFileName),
          `${stringifyPretty(stamped)}\n`,
          'utf8',
        )
      }
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true })
      throw error
    }

    this.sessions.delete(request.scanId)
    return {
      report: session.report,
      stagingDirectory,
      grantedPermissions,
      cleanup: () => rm(stagingDirectory, { recursive: true, force: true }),
    }
  }

  private async inspect(path: string): Promise<ScannedArchive> {
    if (extname(path).toLowerCase() !== VelarModArchiveExtension) {
      throw new AppError('VALIDATION', `Mod 包的扩展名必须是 ${VelarModArchiveExtension}：所选文件不是 Mod 包。`)
    }
    const fileStat = await stat(path)
    if (!fileStat.isFile()) throw new AppError('VALIDATION', '所选的 Mod 包不是文件：这个路径指向的是目录或别的类型。')
    if (fileStat.size <= 0 || fileStat.size > MaxArchiveBytes) {
      throw new AppError('VALIDATION', `Mod 包的体积必须在 1 B 到 ${MaxArchiveBytes} B 之间：空文件和超大文件都不收。`)
    }

    const archiveBytes = await readFile(path)
    if (archiveBytes[0] !== 0x50 || archiveBytes[1] !== 0x4b) {
      throw new AppError('VALIDATION', '这个 .velarmod 文件不是 ZIP 容器：开头的魔数不对，Mod 包必须是 ZIP 格式。')
    }
    const archiveDigest = createHash('sha256').update(archiveBytes).digest('base64url')
    let zip: JSZip
    try {
      zip = await JSZip.loadAsync(archiveBytes, { checkCRC32: true, createFolders: false })
    } catch (error) {
      throw new AppError('SECURITY', 'Mod 包打不开：文件已损坏、被加密，或者 CRC 校验没过。', error)
    }

    const zipEntries = Object.values(zip.files)
    for (const entry of zipEntries) {
      const unixMode = entry.unixPermissions
      if (isNumber(unixMode) && (unixMode & 0o170000) === 0o120000) {
        throw new AppError('SECURITY', `Mod 包里不许有符号链接：${entry.unsafeOriginalName ?? entry.name}；解包时它能指到目录外面去。`)
      }
    }
    const files = zipEntries.filter((entry) => !entry.dir)
    if (isEmpty(files) || files.length > MaxFileCount) {
      throw new AppError('SECURITY', `Mod 包的文件数必须在 1 到 ${MaxFileCount} 之间：空包和文件过多的包都不收。`)
    }

    let expandedBytes = 0
    const paths = new Set<string>()
    const entries: VelarModArchiveEntry[] = []
    for (const file of files) {
      const originalPath = (file as JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName
      const safePath = assertArchiveEntryPath(originalPath ?? file.name)
      const foldedPath = safePath.toLocaleLowerCase('en-US')
      if (paths.has(foldedPath)) {
        throw new AppError('SECURITY', `Mod 包里有大小写折叠后重名的路径：${safePath}；在不区分大小写的文件系统上它们会互相覆盖。`)
      }
      paths.add(foldedPath)

      const sizes = readZipSizes(file)
      if (expandedBytes + sizes.expanded > MaxExpandedBytes) {
        throw new AppError('SECURITY', `Mod 包解开后超过 ${MaxExpandedBytes} B：按 ZIP 目录记录预估就已经超限，已中止解包。`)
      }
      if (
        sizes.expanded > 1024 * 1024
        && sizes.compressed > 0
        && sizes.expanded / sizes.compressed > MaxCompressionRatio
      ) throw new AppError('SECURITY', `Mod 包里这个文件的压缩比异常：${safePath}；解开后会膨胀到危险体积，疑似压缩炸弹。`)
      const bytes = await file.async('nodebuffer')
      if (bytes.byteLength !== sizes.expanded) {
        throw new AppError('SECURITY', `Mod 包里这个文件的实际长度和 ZIP 目录记录对不上：${safePath}；包可能被篡改过。`)
      }
      expandedBytes += bytes.byteLength
      if (expandedBytes > MaxExpandedBytes) {
        throw new AppError('SECURITY', `Mod 包解开后超过 ${MaxExpandedBytes} B：实际解出的字节数已经超限，已中止解包。`)
      }
      entries.push({ path: safePath, bytes })
    }

    const manifestEntry = entries.find((entry) => entry.path === VelarosModManifestFileName)
    if (!manifestEntry) throw new AppError('VALIDATION', `Mod 包根目录缺少 ${VelarosModManifestFileName}：清单必须放在包的根目录下。`)
    if (manifestEntry.bytes.byteLength > MaxManifestBytes) {
      throw new AppError('SECURITY', `Mod 清单超过 ${MaxManifestBytes} B：清单只放元数据，这么大多半不对。`)
    }

    let manifest: unknown
    try {
      manifest = JSON.parse(manifestEntry.bytes.toString('utf8'))
    } catch (error) {
      throw new AppError('VALIDATION', `${VelarosModManifestFileName} 不是合法 JSON：清单解析失败。`, error)
    }
    const parsedEnvelope = velarosModEnvelopes.parse(manifest, { origin: path })
    if (!parsedEnvelope.ok) {
      throw new AppError('VALIDATION', parsedEnvelope.diagnostics
        .map((diagnostic) => `${diagnostic.path ?? '<root>'}: ${diagnostic.message}`)
        .join('; '))
    }
    if (!isPlainObject(manifest)) throw new AppError('VALIDATION', 'Mod 清单的根必须是对象：顶层写成数组或别的类型都不认。')

    const { module, agent } = parsedEnvelope.envelope
    const findings: VelarModArchiveFinding[] = []
    if (isPresent(agent)) {
      const parsedAgent = parseAgentModManifest(agent, { origin: path })
      if (!parsedAgent.ok) {
        throw new AppError('VALIDATION', parsedAgent.diagnostics
          .map((diagnostic) => `${diagnostic.path ?? '<root>'}: ${diagnostic.message}`)
          .join('; '))
      }
      if (
        parsedAgent.manifest.permissions
        && JSON.stringify([...parsedAgent.manifest.permissions].sort())
          !== JSON.stringify([...module.permissions].sort())
      ) findings.push({
        severity: 'warning',
        code: 'permissions.metadata-mismatch',
        message: 'agent.permissions 与 module.permissions 不一致：以 module.permissions 为准。',
      })
    }

    const declaredPermissions = [...new Set(module.permissions)]
    if (declaredPermissions.length !== module.permissions.length) findings.push({
      severity: 'blocking',
      code: 'permissions.duplicate',
      message: 'module.permissions 里有重复的权限 id：去重之后再声明。',
    })
    const permissions = declaredPermissions.map((permission) => this.options.resolvePermission(permission))
    for (const [index, permission] of declaredPermissions.entries()) {
      if (!permissions[index]) findings.push({
        severity: 'blocking',
        code: 'permissions.unknown',
        message: `本宿主没有 ${permission} 这个权限：用户批不了，这个包也就装不上。`,
      })
    }

    const metadata = readAgentMetadata(agent, module.id)
    let signatureKeyId: Nullable<string> = null
    const verifier = this.options.signatureVerifier
    const signatureFileName = verifier?.fileName ?? VelarModSignatureFileName
    const signatureEntry = entries.find((entry) => entry.path === signatureFileName)
    if (signatureEntry) {
      let signatureRaw: unknown = null
      try {
        signatureRaw = JSON.parse(signatureEntry.bytes.toString('utf8'))
      } catch {
        // arch-guard:silent-catch-ok 签名 JSON 的形态错误由下方验证器或不支持分支统一报告。
      }
      if (!verifier) findings.push({
        severity: 'blocking',
        code: 'signature.unsupported',
        message: '本宿主验不了这个 Mod 包里带的签名：没有注入签名验证器，不能当作已验证放行。',
      })
      else {
        const verdict = verifier.verify({
          signature: signatureRaw,
          modId: module.id,
          version: module.version,
          entries,
        })
        if (verdict.ok && metadata.claimedTrust === 'marketplace-signed') signatureKeyId = verdict.keyId
        else if (verdict.ok) findings.push({
          severity: 'blocking',
          code: 'signature.trust-mismatch',
          message: '签名本身有效，但 agent.trust 不是 marketplace-signed：清单声明的信任级别和签名对不上。',
        })
        else findings.push({ severity: 'blocking', code: 'signature.invalid', message: verdict.reason })
      }
    } else if (metadata.claimedTrust === 'marketplace-signed') findings.push({
      severity: 'blocking',
      code: 'signature.missing',
      message: '这个 Mod 自称 marketplace-signed，包里却没有签名文件。',
    })
    else findings.push({
      severity: 'warning',
      code: 'trust.user-imported',
      message: '这个 Mod 没有签名：只有在你信得过它的来源时才继续安装。',
    })

    const nativeExtensions = new Set(['.node', '.dll', '.dylib', '.so', '.exe'])
    if (entries.some((entry) => nativeExtensions.has(extname(entry.path).toLowerCase()))) findings.push({
      severity: 'warning',
      code: 'payload.native-code',
      message: '包里含有原生可执行文件：这类文件不受沙箱约束，请仔细确认它的来源。',
    })

    const report: VelarModArchiveScanReport = {
      scanId: this.nextScanId(),
      digest: archiveDigest,
      fileName: basename(path),
      archiveBytes: archiveBytes.byteLength,
      expandedBytes,
      fileCount: entries.length,
      mod: {
        id: module.id,
        version: module.version,
        displayName: metadata.displayName,
        description: metadata.description,
        publisher: metadata.publisher,
      },
      trust: signatureKeyId
        ? { kind: 'marketplace-signed', label: 'VelarOS 签名来源', signatureKeyId }
        : { kind: 'user-imported', label: '用户导入（未签名）', signatureKeyId: null },
      permissions: permissions.filter((permission): permission is VelarModPermissionDescriptor => !!permission),
      contributions: countContributions(agent),
      findings,
      installable: !findings.some((finding) => finding.severity === 'blocking'),
    }
    return { report, path, entries, manifest }
  }

  private evictExpired(): void {
    const now = this.now()
    for (const [scanId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(scanId)
    }
  }
}

/** 建一台 `.velarmod` 归档导入器：逐条核对上限，越界一律拒载。 */
export function createVelarModArchiveImporter(options: VelarModArchiveImporterOptions): VelarModArchiveImporterApi {
  return new VelarModArchiveImporter(options)
}
