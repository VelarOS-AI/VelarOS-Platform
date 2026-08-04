import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from 'node:fs/promises'
import { join } from 'node:path'

import {
  isFalse,
  isNotUndefined,
  isNull,
  isString,
  isTrue,
  isUndefined,
  Log,
  optionalWhen,
  toNullable,
} from '@velaros-ai/core'

import { downloadKernelArtifact } from './download'
import {
  KernelArtifactVerificationError,
  KernelUpdaterError,
} from './errors'
import {
  type KernelArtifactExtractor,
  PassthroughKernelArtifactExtractor,
} from './extraction'
import {
  ignoreMissing,
  writeJsonFileAtomic,
} from './fs-utils'
import {
  type KernelInstalledVersion,
  type KernelInstallRecord,
  listKernelInstalledVersions,
  readKernelInstallRecord,
  writeKernelInstallRecord,
} from './installation'
import {
  createKernelInstallLayout,
  ensureKernelInstallLayout,
  type KernelInstallLayout,
  kernelVersionDirectory,
} from './layout'
import { KernelUpdateLock } from './lock'
import {
  type KernelArtifactTarget,
  type KernelUpdateManifest,
  loadKernelUpdateManifest,
  resolveKernelArtifactTarget,
  selectKernelArtifact,
  selectKernelManifestVersion,
} from './manifest'
import {
  type KernelActivePointer,
  readKernelActivePointer,
  writeKernelActivePointer,
} from './pointer'
import {
  type KernelArtifactSignatureVerifier,
  UnverifiedKernelArtifactSignatureVerifier,
} from './signature'
import type { KernelFetch } from './transport'
import {
  assertKernelVersion,
  satisfiesKernelVersionRange,
} from './version'

export interface KernelHealthCheckContext {
  readonly version: string
  readonly path: string
  readonly previousVersion: Nullable<string>
}

/** Caller-supplied predicate deciding whether a freshly activated Kernel works. */
export type KernelHealthCheck = (
  context: KernelHealthCheckContext,
) => Promise<boolean> | boolean

export interface KernelActivationOptions {
  readonly healthCheck?: KernelHealthCheck
}

export interface KernelEnsureInstalledOptions {
  readonly manifest?: KernelUpdateManifest
  readonly manifestSource?: string
  readonly force?: boolean
  readonly signal?: AbortSignal
}

export interface KernelCompatibilityRequirement {
  readonly range: string
  readonly manifestSource?: string
  readonly healthCheck?: KernelHealthCheck
  readonly allowInstall?: boolean
  readonly signal?: AbortSignal
}

export interface KernelInstallOutcome {
  readonly version: string
  readonly path: string
  readonly installed: boolean
  readonly record: KernelInstallRecord
}

export interface KernelCompatibilityOutcome {
  readonly version: string
  readonly installed: boolean
  readonly activated: boolean
  readonly pointer: KernelActivePointer
}

export interface KernelPruneOptions {
  readonly retain?: number
}

export interface KernelUpdaterOptions {
  readonly root?: string
  readonly layout?: KernelInstallLayout
  readonly manifestSource?: string
  readonly platform?: string
  readonly architecture?: string
  readonly target?: KernelArtifactTarget
  readonly fetch?: KernelFetch
  readonly extractor?: KernelArtifactExtractor
  readonly signatureVerifier?: KernelArtifactSignatureVerifier
  readonly requireSignature?: boolean
  readonly retainedVersions?: number
  readonly holderId?: string
  readonly now?: () => number
  readonly isProcessAlive?: (pid: number) => boolean
}

const DefaultRetainedVersions = 3
const log = Log.tag('KernelUpdater')

/**
 * Façade over the shared Kernel install root.
 *
 * The updater owns bytes on disk and the active version pointer; it never
 * starts, stops, or calls into a Kernel. Every mutating operation runs under
 * the cross-process update lock, installs land through an atomic rename, and
 * the pointer is only ever replaced whole.
 */
export class KernelUpdater {
  private readonly layout: KernelInstallLayout
  private readonly target: KernelArtifactTarget
  private readonly fetch?: KernelFetch
  private readonly extractor: KernelArtifactExtractor
  private readonly signatureVerifier: KernelArtifactSignatureVerifier
  private readonly requireSignature: boolean
  private readonly retainedVersions: number
  private readonly holderId: string
  private readonly now: () => number
  private readonly isProcessAlive?: (pid: number) => boolean
  private readonly manifestSource?: string
  private queue: Promise<unknown> = Promise.resolve()

  public constructor(options: KernelUpdaterOptions = {}) {
    this.layout = options.layout ?? createKernelInstallLayout(options.root)
    this.target = options.target
      ?? resolveKernelArtifactTarget(options.platform, options.architecture)
    this.fetch = options.fetch
    this.extractor = options.extractor ?? new PassthroughKernelArtifactExtractor()
    this.signatureVerifier = options.signatureVerifier
      ?? new UnverifiedKernelArtifactSignatureVerifier()
    this.requireSignature = !!options.requireSignature
    this.retainedVersions = Math.max(1, options.retainedVersions ?? DefaultRetainedVersions)
    this.holderId = options.holderId ?? randomUUID()
    this.now = options.now ?? Date.now
    this.isProcessAlive = options.isProcessAlive
    this.manifestSource = options.manifestSource
  }

  public getLayout(): KernelInstallLayout {
    return this.layout
  }

  public getArtifactTarget(): KernelArtifactTarget {
    return this.target
  }

  public async getActivePointer(): Promise<KernelActivePointer | undefined> {
    return readKernelActivePointer(this.layout.pointerPath)
  }

  public async getActiveVersion(): Promise<string | undefined> {
    return (await this.getActivePointer())?.version
  }

  public async listInstalledVersions(): Promise<readonly KernelInstalledVersion[]> {
    const pointer = await this.getActivePointer()
    return listKernelInstalledVersions(this.layout, pointer?.version)
  }

  public async loadManifest(
    source?: string,
    signal?: AbortSignal,
  ): Promise<KernelUpdateManifest> {
    const resolved = source ?? this.manifestSource
    if (isUndefined(resolved)) {
      throw new KernelUpdaterError(
        'MANIFEST_UNREACHABLE',
        'No Kernel update manifest source was configured',
      )
    }
    return loadKernelUpdateManifest(resolved, { fetch: this.fetch, signal })
  }

  /** Installs `version` side by side if it is not already installed and whole. */
  public async ensureInstalled(
    version: string,
    options: KernelEnsureInstalledOptions = {},
  ): Promise<KernelInstallOutcome> {
    return this.exclusively(() => this.installVersion(version, options))
  }

  /**
   * Guarantees an active Kernel satisfying `requirement`, preferring the
   * running version, then the newest acceptable local install, then the newest
   * acceptable published release.
   */
  public async ensureCompatible(
    requirement: KernelCompatibilityRequirement | string,
  ): Promise<KernelCompatibilityOutcome> {
    const resolved: KernelCompatibilityRequirement = isString(requirement)
      ? { range: requirement }
      : requirement
    return this.exclusively(() => this.resolveCompatible(resolved))
  }

  /**
   * Switches `current.json` to an installed version. When a health check is
   * supplied it runs after the switch and a failure restores the previous
   * pointer before the call rejects.
   */
  public async activateVersion(
    version: string,
    options: KernelActivationOptions = {},
  ): Promise<KernelActivePointer> {
    return this.exclusively(() => this.activate(version, options))
  }

  /** Restores the pointer recorded as `previousVersion`. */
  public async rollback(
    options: KernelActivationOptions = {},
  ): Promise<KernelActivePointer> {
    return this.exclusively(async () => {
      const pointer = await readKernelActivePointer(this.layout.pointerPath)
      const target = toNullable(pointer?.previousVersion)
      if (isNull(target)) {
        throw new KernelUpdaterError(
          'NO_ROLLBACK_TARGET',
          'No previous Kernel version is recorded for rollback',
          { version: pointer?.version },
        )
      }
      return this.activate(target, options)
    })
  }

  /**
   * Removes the oldest installs beyond the retention count. The active version
   * and the recorded rollback target are always kept.
   */
  public async pruneVersions(
    options: KernelPruneOptions = {},
  ): Promise<readonly string[]> {
    return this.exclusively(async () => {
      const retain = Math.max(1, options.retain ?? this.retainedVersions)
      const pointer = await readKernelActivePointer(this.layout.pointerPath)
      const installed = await listKernelInstalledVersions(
        this.layout,
        pointer?.version,
      )
      const protectedVersions = new Set(
        [pointer?.version, pointer?.previousVersion].filter(
          (version): version is string => isString(version),
        ),
      )
      const removable = installed.filter(
        (entry) => !protectedVersions.has(entry.version),
      )
      const keepCount = Math.max(0, retain - protectedVersions.size)
      const removed: string[] = []
      for (const entry of removable.slice(0, Math.max(0, removable.length - keepCount))) {
        await rm(entry.path, { recursive: true, force: true })
        removed.push(entry.version)
      }
      return removed
    })
  }

  private async resolveCompatible(
    requirement: KernelCompatibilityRequirement,
  ): Promise<KernelCompatibilityOutcome> {
    const pointer = await readKernelActivePointer(this.layout.pointerPath)
    const installed = await listKernelInstalledVersions(
      this.layout,
      pointer?.version,
    )
    const acceptable = installed.filter((entry) =>
      entry.complete && satisfiesKernelVersionRange(entry.version, requirement.range))

    const running = isNotUndefined(pointer)
      && acceptable.some((entry) => entry.version === pointer.version)
      ? pointer
      : undefined
    if (isNotUndefined(running)) return runningKernelOutcome(running)

    const local = acceptable.at(-1)
    if (isNotUndefined(local)) return this.switchTo(local.version, false, requirement)

    if (isFalse(requirement.allowInstall)) {
      throw new KernelUpdaterError(
        'VERSION_UNAVAILABLE',
        `No installed Kernel version satisfies "${requirement.range}"`,
        { versionRange: requirement.range },
      )
    }

    const manifest = await this.loadManifest(
      requirement.manifestSource,
      requirement.signal,
    )
    const published = selectKernelManifestVersion(manifest, {
      range: requirement.range,
      target: this.target,
    })
    if (isUndefined(published)) {
      throw new KernelUpdaterError(
        'VERSION_UNAVAILABLE',
        `No published Kernel version satisfies "${requirement.range}" on ${this.target}`,
        { versionRange: requirement.range, target: this.target },
      )
    }

    const outcome = await this.installVersion(published.version, {
      manifest,
      signal: requirement.signal,
    })
    return this.switchTo(outcome.version, outcome.installed, requirement)
  }

  private async switchTo(
    version: string,
    installed: boolean,
    options: KernelActivationOptions,
  ): Promise<KernelCompatibilityOutcome> {
    return {
      version,
      installed,
      activated: true,
      pointer: await this.activate(version, options),
    }
  }

  private async installVersion(
    version: string,
    options: KernelEnsureInstalledOptions,
  ): Promise<KernelInstallOutcome> {
    assertKernelVersion(version)
    const destination = kernelVersionDirectory(this.layout, version)
    const existing = await readKernelInstallRecord(destination)
    const reusable = isNotUndefined(existing) && !isTrue(options.force)
      ? { version, path: destination, installed: false, record: existing }
      : undefined
    if (isNotUndefined(reusable)) return reusable
    if (
      isNotUndefined(existing)
      && (await readKernelActivePointer(this.layout.pointerPath))?.version === version
    ) {
      throw new KernelUpdaterError(
        'INSTALL_FAILED',
        `Kernel version "${version}" is active and cannot be reinstalled in place`,
        { version, path: destination },
      )
    }

    const manifest = options.manifest
      ?? await this.loadManifest(options.manifestSource, options.signal)
    const selection = selectKernelArtifact(manifest, version, this.target)

    await this.discardOrphanedStaging()
    const stagingRoot = await mkdtemp(
      join(this.layout.stagingDirectory, `${version}-`),
    )
    const payloadPath = join(stagingRoot, 'artifact.payload')
    const stagedDirectory = join(stagingRoot, 'install')
    try {
      const download = await downloadKernelArtifact({
        artifact: selection.artifact,
        destination: payloadPath,
        fetch: this.fetch,
        signal: options.signal,
      })
      const signature = await this.signatureVerifier.verify({
        version,
        target: this.target,
        artifact: selection.artifact,
        payloadPath,
        sha256: download.sha256,
      })
      if (this.requireSignature && !signature.verified) {
        throw new KernelArtifactVerificationError(
          'SIGNATURE_REJECTED',
          `Kernel artifact signature was not verified: ${signature.reason ?? signature.method}`,
          { version, target: this.target, url: selection.artifact.url },
        )
      }

      await mkdir(stagedDirectory, { recursive: true, mode: 0o755 })
      await this.extractor.extract({
        version,
        target: this.target,
        artifact: selection.artifact,
        payloadPath,
        destinationDirectory: stagedDirectory,
      })
      const record: KernelInstallRecord = {
        schemaVersion: 1,
        version,
        target: this.target,
        format: selection.artifact.format,
        sha256: download.sha256,
        size: download.size,
        installedAt: this.now(),
      }
      await writeKernelInstallRecord(stagedDirectory, record)
      await rm(destination, { recursive: true, force: true })
      await rename(stagedDirectory, destination)
      return { version, path: destination, installed: true, record }
    } catch (error) {
      throw error instanceof KernelUpdaterError
        ? error
        : new KernelUpdaterError(
          'INSTALL_FAILED',
          `Kernel version "${version}" could not be installed`,
          { version, target: this.target },
          { cause: error },
        )
    } finally {
      await rm(stagingRoot, { recursive: true, force: true })
    }
  }

  private async activate(
    version: string,
    options: KernelActivationOptions,
  ): Promise<KernelActivePointer> {
    assertKernelVersion(version)
    const path = kernelVersionDirectory(this.layout, version)
    if (isUndefined(await readKernelInstallRecord(path))) {
      throw new KernelUpdaterError(
        'VERSION_NOT_INSTALLED',
        `Kernel version "${version}" is not installed`,
        { version, path },
      )
    }

    const previous = await readKernelActivePointer(this.layout.pointerPath)
    const previousVersion = isUndefined(previous)
      ? null
      : previous.version === version
        ? previous.previousVersion
        : previous.version
    const pointer: KernelActivePointer = {
      schemaVersion: 1,
      version,
      previousVersion,
      updatedAt: this.now(),
      updatedBy: this.holderId,
    }

    await this.backupPointer(previous)
    await writeKernelActivePointer(this.layout.pointerPath, pointer)
    if (isUndefined(options.healthCheck)) return pointer

    let healthy = false
    let failure: unknown
    try {
      healthy = await options.healthCheck({ version, path, previousVersion })
    } catch (error) {
      log.warn('Activated Kernel failed its health check', { error, version })
      failure = error
    }
    if (healthy) return pointer

    await this.revertPointer(previous)
    throw new KernelUpdaterError(
      'HEALTH_CHECK_FAILED',
      `Kernel version "${version}" failed its activation health check`,
      {
        version,
        previousVersion: optionalWhen(isString, previousVersion),
        path,
      },
      isUndefined(failure) ? undefined : { cause: failure },
    )
  }

  private async revertPointer(
    previous?: KernelActivePointer,
  ): Promise<void> {
    if (isUndefined(previous)) {
      await rm(this.layout.pointerPath, { force: true })
      return
    }
    await writeKernelActivePointer(this.layout.pointerPath, {
      ...previous,
      updatedAt: this.now(),
    })
  }

  private async backupPointer(
    previous?: KernelActivePointer,
  ): Promise<void> {
    if (isUndefined(previous)) return
    await mkdir(this.layout.backupsDirectory, { recursive: true, mode: 0o700 })
    await writeJsonFileAtomic(
      join(
        this.layout.backupsDirectory,
        `current.${previous.version}.${previous.updatedAt}.json`,
      ),
      previous,
    )
  }

  /** Under the lock, any staging directory left behind belongs to a dead run. */
  private async discardOrphanedStaging(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.layout.stagingDirectory)
    } catch (error) {
      ignoreMissing(error)
      log.debug('Kernel staging directory does not exist', {
        error,
        path: this.layout.stagingDirectory,
      })
      return
    }
    for (const entry of entries) {
      await rm(join(this.layout.stagingDirectory, entry), {
        recursive: true,
        force: true,
      })
    }
  }

  private async exclusively<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await ensureKernelInstallLayout(this.layout)
      const lock = await KernelUpdateLock.acquire({
        lockPath: this.layout.lockPath,
        holderId: this.holderId,
        isProcessAlive: this.isProcessAlive,
        now: this.now,
      })
      try {
        return await operation()
      } finally {
        await lock.release()
      }
    })
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }
}

function runningKernelOutcome(
  pointer: KernelActivePointer,
): KernelCompatibilityOutcome {
  return {
    version: pointer.version,
    installed: false,
    activated: false,
    pointer,
  }
}
