import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, posix } from 'node:path'

import JSZip, { type JSZipObject } from 'jszip'

import {
  isArray,
  isEmpty,
  isNumber,
  isPlainObject,
  isPresent,
  stringifyPretty,
  trimmedStringOrEmpty,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import {
  parseVelarosModEnvelope,
  VelarosModManifestFileName,
} from '@velaros-ai/kernel/contracts/protocol'

import { parseAgentModManifest } from '../protocol'

const VelarModArchiveExtension = '.velarmod'
const VelarModSignatureFileName = 'velaros.mod.sig.json'
const MaxArchiveBytes = 32 * 1024 * 1024
const MaxExpandedBytes = 128 * 1024 * 1024
const MaxManifestBytes = 256 * 1024
const MaxFileCount = 512
const MaxPathLength = 240
const MaxPathDepth = 8
const MaxCompressionRatio = 100
const DefaultScanSessionTtlMs = 10 * 60 * 1000

export interface VelarModArchiveEntry {
  readonly path: string
  readonly bytes: Buffer
}

export interface VelarModPermissionDescriptor {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly risk: 'standard' | 'sensitive' | 'high'
}

export interface VelarModArchiveFinding {
  readonly severity: 'info' | 'warning' | 'blocking'
  readonly code: string
  readonly message: string
}

export interface VelarModArchiveScanReport {
  readonly scanId: string
  readonly digest: string
  readonly fileName: string
  readonly archiveBytes: number
  readonly expandedBytes: number
  readonly fileCount: number
  readonly mod: {
    readonly id: string
    readonly version: string
    readonly displayName: string
    readonly description: string
    readonly publisher: string
  }
  readonly trust: {
    readonly kind: 'marketplace-signed' | 'user-imported'
    readonly label: string
    readonly signatureKeyId: Nullable<string>
  }
  readonly permissions: readonly VelarModPermissionDescriptor[]
  readonly contributions: Readonly<Record<string, number>>
  readonly findings: readonly VelarModArchiveFinding[]
  readonly installable: boolean
}

export interface InstallScannedVelarModArchiveRequest {
  readonly scanId: string
  readonly digest: string
  readonly trustConfirmed: boolean
  readonly grantedPermissions: readonly string[]
}

export type VelarModArchiveInstallFailureReason =
  | 'archive.changed'
  | 'archive.path-escapes-root'
  | 'archive.path-unsafe'
  | 'permissions.not-declared'
  | 'trust.confirmation-required'

export interface PreparedVelarModInstall {
  readonly report: VelarModArchiveScanReport
  readonly stagingDirectory: string
  readonly grantedPermissions: readonly string[]
  cleanup(): Promise<void>
}

export interface VelarModArchiveSignatureVerifier {
  readonly fileName?: string
  verify(input: {
    readonly signature: unknown
    readonly modId: string
    readonly version: string
    readonly entries: readonly VelarModArchiveEntry[]
  }): { readonly ok: true; readonly keyId: string } | { readonly ok: false; readonly reason: string }
}

export interface VelarModArchiveImporterOptions {
  readonly resolvePermission: (permission: string) => Nullable<VelarModPermissionDescriptor>
  readonly signatureVerifier?: VelarModArchiveSignatureVerifier
  readonly scanSessionTtlMs?: number
  readonly now?: () => number
  readonly nextScanId?: () => string
}

interface ZipSizeData {
  compressedSize?: number
  uncompressedSize?: number
}

interface ScannedArchive {
  report: VelarModArchiveScanReport
  path: string
  entries: readonly VelarModArchiveEntry[]
  manifest: Record<string, unknown>
}

interface ScanSession extends ScannedArchive {
  expiresAt: number
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

function assertArchiveEntryPath(rawPath: string): string {
  if (
    rawPath.startsWith('/')
    || /^[a-z]:\//iu.test(rawPath)
    || rawPath.includes('\\')
    || rawPath.length > MaxPathLength
    || hasControlCharacter(rawPath)
  ) throw new AppError(
    'SECURITY',
    `Mod archive contains an unsafe path: ${JSON.stringify(rawPath)}`,
    undefined,
    { reason: 'archive.path-unsafe' satisfies VelarModArchiveInstallFailureReason },
  )

  const normalized = posix.normalize(rawPath)
  const segments = normalized.split('/')
  if (
    normalized === '.'
    || normalized.startsWith('../')
    || segments.includes('..')
    || segments.length > MaxPathDepth
  ) throw new AppError(
    'SECURITY',
    `Mod archive path escapes its root or is too deep: ${JSON.stringify(rawPath)}`,
    undefined,
    { reason: 'archive.path-escapes-root' satisfies VelarModArchiveInstallFailureReason },
  )
  return normalized.normalize('NFC')
}

function readZipSizes(entry: JSZipObject): { compressed: number; expanded: number } {
  const data = (entry as JSZipObject & { _data?: ZipSizeData })._data
  return {
    compressed: Number(data?.compressedSize ?? 0),
    expanded: Number(data?.uncompressedSize ?? 0),
  }
}

function readText(value: unknown): string {
  return trimmedStringOrEmpty(value)
}

function readAgentMetadata(agent: unknown, fallbackId: string) {
  if (!isPlainObject(agent)) return { displayName: fallbackId, description: '', publisher: '', claimedTrust: '' }
  return {
    displayName: readText(agent.displayName) || fallbackId,
    description: readText(agent.description),
    publisher: readText(agent.publisher),
    claimedTrust: readText(agent.trust),
  }
}

function countContributions(agent: unknown): Readonly<Record<string, number>> {
  if (!isPlainObject(agent) || !isPlainObject(agent.contributes)) return {}
  return Object.fromEntries(
    Object.entries(agent.contributes)
      .filter(([, entries]) => isArray(entries) && !isEmpty(entries))
      .map(([axis, entries]) => [axis, (entries as readonly unknown[]).length]),
  )
}

/**
 * Host-neutral `.velarmod` scan, trust ticket, and extraction transaction.
 * Permission presentation and marketplace signature roots are injected host policy ports.
 */
export class VelarModArchiveImporter {
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
    if (!session) throw new AppError('VALIDATION', 'Mod scan expired; scan the archive again.')
    if (session.report.digest !== request.digest) {
      throw new AppError('SECURITY', 'Mod install confirmation does not match the scanned digest.')
    }
    if (!session.report.installable) throw new AppError('SECURITY', 'Blocking findings prevent Mod installation.')

    const rescanned = await this.inspect(session.path)
    if (
      rescanned.report.digest !== session.report.digest
      || rescanned.report.mod.id !== session.report.mod.id
      || rescanned.report.mod.version !== session.report.mod.version
    ) {
      this.sessions.delete(request.scanId)
      throw new AppError(
        'SECURITY',
        'Mod archive changed after confirmation; scan it again.',
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
        `Granted permissions were not declared by the Mod: ${invalid.join(', ')}`,
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
        'An unsigned imported Mod requires explicit source trust confirmation.',
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
        const stamped = {
          ...rescanned.manifest,
          ...(isPlainObject(rescanned.manifest.agent)
            ? { agent: { ...rescanned.manifest.agent, trust: 'local-dev' } }
            : {}),
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
      throw new AppError('VALIDATION', `Mod archives must use the ${VelarModArchiveExtension} extension.`)
    }
    const fileStat = await stat(path)
    if (!fileStat.isFile()) throw new AppError('VALIDATION', 'Selected Mod archive is not a file.')
    if (fileStat.size <= 0 || fileStat.size > MaxArchiveBytes) {
      throw new AppError('VALIDATION', `Mod archive size must be between 1 B and ${MaxArchiveBytes} B.`)
    }

    const archiveBytes = await readFile(path)
    if (archiveBytes[0] !== 0x50 || archiveBytes[1] !== 0x4b) {
      throw new AppError('VALIDATION', 'The .velarmod file is not a supported ZIP container.')
    }
    const archiveDigest = createHash('sha256').update(archiveBytes).digest('base64url')
    let zip: JSZip
    try {
      zip = await JSZip.loadAsync(archiveBytes, { checkCRC32: true, createFolders: false })
    } catch (error) {
      throw new AppError('SECURITY', 'Mod archive is corrupt, encrypted, or failed CRC validation.', error)
    }

    const zipEntries = Object.values(zip.files)
    for (const entry of zipEntries) {
      const unixMode = entry.unixPermissions
      if (isNumber(unixMode) && (unixMode & 0o170000) === 0o120000) {
        throw new AppError('SECURITY', `Mod archives cannot contain symbolic links: ${entry.unsafeOriginalName ?? entry.name}`)
      }
    }
    const files = zipEntries.filter((entry) => !entry.dir)
    if (isEmpty(files) || files.length > MaxFileCount) {
      throw new AppError('SECURITY', `Mod archive file count must be between 1 and ${MaxFileCount}.`)
    }

    let expandedBytes = 0
    const paths = new Set<string>()
    const entries: VelarModArchiveEntry[] = []
    for (const file of files) {
      const originalPath = (file as JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName
      const safePath = assertArchiveEntryPath(originalPath ?? file.name)
      const foldedPath = safePath.toLocaleLowerCase('en-US')
      if (paths.has(foldedPath)) {
        throw new AppError('SECURITY', `Mod archive contains a duplicate normalized path: ${safePath}`)
      }
      paths.add(foldedPath)

      const sizes = readZipSizes(file)
      if (expandedBytes + sizes.expanded > MaxExpandedBytes) {
        throw new AppError('SECURITY', `Expanded Mod archive exceeds ${MaxExpandedBytes} B.`)
      }
      if (
        sizes.expanded > 1024 * 1024
        && sizes.compressed > 0
        && sizes.expanded / sizes.compressed > MaxCompressionRatio
      ) throw new AppError('SECURITY', `Mod archive entry has an unsafe compression ratio: ${safePath}`)
      const bytes = await file.async('nodebuffer')
      if (bytes.byteLength !== sizes.expanded) {
        throw new AppError('SECURITY', `Mod archive entry length does not match its directory record: ${safePath}`)
      }
      expandedBytes += bytes.byteLength
      if (expandedBytes > MaxExpandedBytes) {
        throw new AppError('SECURITY', `Expanded Mod archive exceeds ${MaxExpandedBytes} B.`)
      }
      entries.push({ path: safePath, bytes })
    }

    const manifestEntry = entries.find((entry) => entry.path === VelarosModManifestFileName)
    if (!manifestEntry) throw new AppError('VALIDATION', `Mod archive root is missing ${VelarosModManifestFileName}.`)
    if (manifestEntry.bytes.byteLength > MaxManifestBytes) {
      throw new AppError('SECURITY', `Mod manifest exceeds ${MaxManifestBytes} B.`)
    }

    let manifest: unknown
    try {
      manifest = JSON.parse(manifestEntry.bytes.toString('utf8'))
    } catch (error) {
      throw new AppError('VALIDATION', `${VelarosModManifestFileName} is not valid JSON.`, error)
    }
    const parsedEnvelope = parseVelarosModEnvelope(manifest, { origin: path })
    if (!parsedEnvelope.ok) {
      throw new AppError('VALIDATION', parsedEnvelope.diagnostics
        .map((diagnostic) => `${diagnostic.path ?? '<root>'}: ${diagnostic.message}`)
        .join('; '))
    }
    if (!isPlainObject(manifest)) throw new AppError('VALIDATION', 'Mod manifest root must be an object.')

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
        message: 'agent.permissions differs from module.permissions; module.permissions is authoritative.',
      })
    }

    const declaredPermissions = [...new Set(module.permissions)]
    if (declaredPermissions.length !== module.permissions.length) findings.push({
      severity: 'blocking',
      code: 'permissions.duplicate',
      message: 'module.permissions contains duplicate permission identifiers.',
    })
    const permissions = declaredPermissions.map((permission) => this.options.resolvePermission(permission))
    for (const [index, permission] of declaredPermissions.entries()) {
      if (!permissions[index]) findings.push({
        severity: 'blocking',
        code: 'permissions.unknown',
        message: `The host does not expose permission ${permission}; it cannot be approved or installed.`,
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
        message: 'This host cannot verify the signature carried by the Mod archive.',
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
          message: 'The signature is valid but agent.trust is not marketplace-signed.',
        })
        else findings.push({ severity: 'blocking', code: 'signature.invalid', message: verdict.reason })
      }
    } else if (metadata.claimedTrust === 'marketplace-signed') findings.push({
      severity: 'blocking',
      code: 'signature.missing',
      message: 'The Mod claims marketplace-signed trust but carries no signature.',
    })
    else findings.push({
      severity: 'warning',
      code: 'trust.user-imported',
      message: 'This Mod is unsigned; continue only if you trust its source.',
    })

    const nativeExtensions = new Set(['.node', '.dll', '.dylib', '.so', '.exe'])
    if (entries.some((entry) => nativeExtensions.has(extname(entry.path).toLowerCase()))) findings.push({
      severity: 'warning',
      code: 'payload.native-code',
      message: 'The archive contains a native executable payload; confirm its source carefully.',
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
        ? { kind: 'marketplace-signed', label: 'VelarOS signed source', signatureKeyId }
        : { kind: 'user-imported', label: 'User import - unsigned', signatureKeyId: null },
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

export { VelarModArchiveExtension, VelarModSignatureFileName }
