import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'

import { AppError, isEmpty, isNull } from '@velaros-ai/core'

import type {
  MemoryKeyringDescriptionV2,
  MemoryKeyringFileV2,
  MemoryKeyringKeysV2,
  MemoryKeyringOpenReportV2,
  MemoryKeyringStoreOptionsV2,
  MemoryWrappingRootV2,
  StorageStepHooksV2,
} from '../../../types/tree-v2/storage.js'
import { assertPositiveSafeIntegerV2 } from '../../../utils/tree-v2/checks.js'
import {
  fsyncDirectoryV2,
  invokeStorageStepV2,
  removeStaleTempFilesV2,
} from '../../../utils/tree-v2/storage/atomic-file.js'
import { assertMemoryBlobIdV2 } from '../../../utils/tree-v2/storage/blob-id.js'
import { MemoryStorageErrorCodesV2 } from '../../../utils/tree-v2/storage/error-codes.js'
import {
  commitCurrentGenerationV2,
  listGenerationEntriesV2,
  readCurrentGenerationV2,
} from '../../../utils/tree-v2/storage/generation-pointer.js'
import {
  createInitialKeyringV2,
  KeyringGenerationSuffixV2,
  MemoryKeyringFormatV2,
  parseKeyringFileV2,
  sealKeyringFileV2,
  writeKeyringGenerationV2,
} from '../../../utils/tree-v2/storage/keyring.js'
import {
  assertMemoryWrappingRootV2,
  unwrapMemoryKeyV2,
  wrapMemoryKeyV2,
} from '../../../utils/tree-v2/storage/wrapping-root.js'

/**
 * 密钥环的唯一物理 owner：构造即打开（或新建）一个 keyring 目录并接管它的换代。
 *
 * 安全取舍：keyring 只保留 CURRENT 指向的那一代。普通换代在 CURRENT 原子切换前旧代仍权威，
 * 切换后旧代立即删除；崩溃落在删除窗口时，下一次构造以 CURRENT 为唯一裁决并清掉其它代。
 * 这牺牲"任意历史代回滚"，换来更强的不复活性质：成功剔除的 DEK 不可能藏在可回滚旧代里。
 * 实例归创建它的运行时（`MemorySystemRuntimeV2` 或探针）所有，一个 keyring 目录一份。
 */
export interface MemoryKeyringStoreV2Api {
  /** 构造时那一次打开的读数：生效代号、是不是新建、清了几个残留。 */
  readonly openReport: MemoryKeyringOpenReportV2
  /** 当前生效的代号。 */
  readonly generation: number
  /** 当前包装这些密钥的 wrapping root id。 */
  readonly wrappingRootId: string
  /** 取身份密钥（32 字节明文）；调用方用完要清零。 */
  getIdentityKey(): Buffer
  /** 取匹配键根密钥（32 字节明文）；调用方用完要清零。 */
  getMatchRootKey(): Buffer
  /** 取这个 blob 的内容密钥；已 crypto-shred 抛 MEMORY_DEK_DESTROYED。 */
  getContentDek(blobId: string): Buffer
  /** 登记一个 blob 的内容密钥，触发一次换代；同 blob 已有密钥抛 INVARIANT。 */
  addContentDek(blobId: string, dek: Buffer): void
  /** crypto-shred 生效点：剔掉这个 blob 的密钥并换代；本来就没有返回 false。 */
  destroyContentDek(blobId: string): boolean
  /** 取（没有就造并换代）这一代派生索引的密钥；返回的明文由调用方清零。 */
  getOrCreateIndexGenerationKey(generation: number): Buffer
  /** 取这一代派生索引的密钥；已销毁抛 MEMORY_DEK_DESTROYED。 */
  getIndexGenerationKey(generation: number): Buffer
  /** 销毁这一代派生索引的密钥并换代；本来就没有返回 false。 */
  destroyIndexGenerationKey(generation: number): boolean
  /** 轮换 wrapping root：只把全部密钥重新包装一遍，不改密钥字节；同一个 root 是空操作。 */
  rotateWrappingRoot(nextRoot: MemoryWrappingRootV2): void
  /** 只读诊断：只给代号、root id 与两类密钥的条数，不返回任何包装字节。 */
  describe(): MemoryKeyringDescriptionV2
}

export class MemoryKeyringStoreV2 implements MemoryKeyringStoreV2Api {
  /** 随机出来的密钥字节长度（AES-256 与 HMAC-SHA256 的密钥长度）。 */
  private static readonly KeyByteLength = 32

  public readonly openReport: MemoryKeyringOpenReportV2

  private readonly keyringDir: string
  private readonly hooks?: StorageStepHooksV2
  private readonly now: () => number
  private readonly random: (byteLength: number) => Buffer
  private root: MemoryWrappingRootV2
  private current: MemoryKeyringFileV2

  constructor(
    keyringDir: string,
    root: MemoryWrappingRootV2,
    options: MemoryKeyringStoreOptionsV2 = {}
  ) {
    assertMemoryWrappingRootV2(root)
    mkdirSync(keyringDir, { recursive: true })
    this.keyringDir = keyringDir
    this.root = root
    this.hooks = options.hooks
    this.now = options.now ?? Date.now
    this.random = options.random ?? randomBytes

    let cleanedResidueCount = removeStaleTempFilesV2(keyringDir)
    const currentGeneration = readCurrentGenerationV2(keyringDir)
    const entries = listGenerationEntriesV2(keyringDir, {
      suffix: KeyringGenerationSuffixV2,
      kind: 'file',
    })

    if (isNull(currentGeneration)) {
      if (!isEmpty(entries)) {
        throw new AppError(
          MemoryStorageErrorCodesV2.corruption,
          'keyring 存在代际文件但缺少 CURRENT，拒绝猜测生效代。',
          undefined,
          { keyringDir }
        )
      }
      const initial = createInitialKeyringV2(root, options)
      writeKeyringGenerationV2(keyringDir, initial, options.hooks)
      commitCurrentGenerationV2(keyringDir, initial.generation, {
        label: 'keyring-current',
        hooks: options.hooks,
      })
      this.current = initial
      this.openReport = {
        generation: initial.generation,
        created: true,
        cleanedResidueCount,
      }
      return
    }

    const currentEntry = entries.find((entry) => entry.generation === currentGeneration)
    if (!currentEntry) {
      throw new AppError(
        MemoryStorageErrorCodesV2.corruption,
        'CURRENT 指向的 keyring 代际文件不存在。',
        undefined,
        { generation: currentGeneration }
      )
    }
    const current = parseKeyringFileV2(readFileSync(currentEntry.path, 'utf8'), currentGeneration)
    if (current.wrappingRootId !== root.id) {
      throw new AppError(
        MemoryStorageErrorCodesV2.wrappingRootMismatch,
        '注入的 wrapping root 与 keyring 记录不一致。',
        undefined,
        { expectedRootId: current.wrappingRootId, actualRootId: root.id }
      )
    }

    for (const entry of entries) {
      if (entry.generation === currentGeneration) continue
      rmSync(entry.path, { force: true })
      cleanedResidueCount += 1
    }
    if (entries.length > 1) fsyncDirectoryV2(keyringDir)

    this.current = current
    this.openReport = {
      generation: current.generation,
      created: false,
      cleanedResidueCount,
    }
  }

  public get generation(): number {
    return this.current.generation
  }

  public get wrappingRootId(): string {
    return this.current.wrappingRootId
  }

  public getIdentityKey(): Buffer {
    return unwrapMemoryKeyV2(this.root, this.current.keys.identity)
  }

  public getMatchRootKey(): Buffer {
    return unwrapMemoryKeyV2(this.root, this.current.keys.matchRoot)
  }

  public getContentDek(blobId: string): Buffer {
    assertMemoryBlobIdV2(blobId)
    const wrapped = this.current.keys.contentDeks[blobId]
    if (!wrapped) {
      throw new AppError(
        MemoryStorageErrorCodesV2.dekDestroyed,
        '内容密钥已销毁，正文不可恢复。',
        undefined,
        { blobId }
      )
    }
    return unwrapMemoryKeyV2(this.root, wrapped)
  }

  public addContentDek(blobId: string, dek: Buffer): void {
    assertMemoryBlobIdV2(blobId)
    if (this.current.keys.contentDeks[blobId]) {
      throw new AppError('INVARIANT', 'blob 已存在内容密钥，禁止覆盖。', undefined, { blobId })
    }
    this.commitKeys({
      ...this.current.keys,
      contentDeks: {
        ...this.current.keys.contentDeks,
        [blobId]: wrapMemoryKeyV2(this.root, dek),
      },
    })
  }

  public destroyContentDek(blobId: string): boolean {
    assertMemoryBlobIdV2(blobId)
    if (!this.current.keys.contentDeks[blobId]) return false
    const contentDeks = { ...this.current.keys.contentDeks }
    delete contentDeks[blobId]
    this.commitKeys({ ...this.current.keys, contentDeks })
    return true
  }

  public getOrCreateIndexGenerationKey(generation: number): Buffer {
    assertPositiveSafeIntegerV2(generation, 'keyring generation')
    const key = String(generation)
    const existing = this.current.keys.indexGenerations[key]
    if (existing) return unwrapMemoryKeyV2(this.root, existing)

    const raw = this.randomKey()
    try {
      this.commitKeys({
        ...this.current.keys,
        indexGenerations: {
          ...this.current.keys.indexGenerations,
          [key]: wrapMemoryKeyV2(this.root, raw),
        },
      })
      return Buffer.from(raw)
    } finally {
      raw.fill(0)
    }
  }

  public getIndexGenerationKey(generation: number): Buffer {
    assertPositiveSafeIntegerV2(generation, 'keyring generation')
    const wrapped = this.current.keys.indexGenerations[String(generation)]
    if (!wrapped) {
      throw new AppError(
        MemoryStorageErrorCodesV2.dekDestroyed,
        'index generation 密钥已销毁，派生代不可恢复。',
        undefined,
        { generation }
      )
    }
    return unwrapMemoryKeyV2(this.root, wrapped)
  }

  public destroyIndexGenerationKey(generation: number): boolean {
    assertPositiveSafeIntegerV2(generation, 'keyring generation')
    const key = String(generation)
    if (!this.current.keys.indexGenerations[key]) return false
    const indexGenerations = { ...this.current.keys.indexGenerations }
    delete indexGenerations[key]
    this.commitKeys({ ...this.current.keys, indexGenerations })
    return true
  }

  public rotateWrappingRoot(nextRoot: MemoryWrappingRootV2): void {
    assertMemoryWrappingRootV2(nextRoot)
    if (nextRoot.id === this.root.id) return

    const identity = this.getIdentityKey()
    const matchRoot = this.getMatchRootKey()
    const indexEntries = Object.entries(this.current.keys.indexGenerations).map(
      ([generation, wrapped]) => [generation, unwrapMemoryKeyV2(this.root, wrapped)] as const
    )
    const contentEntries = Object.entries(this.current.keys.contentDeks).map(
      ([blobId, wrapped]) => [blobId, unwrapMemoryKeyV2(this.root, wrapped)] as const
    )
    try {
      const keys: MemoryKeyringKeysV2 = {
        identity: wrapMemoryKeyV2(nextRoot, identity),
        matchRoot: wrapMemoryKeyV2(nextRoot, matchRoot),
        indexGenerations: Object.fromEntries(
          indexEntries.map(([generation, key]) => [generation, wrapMemoryKeyV2(nextRoot, key)])
        ),
        contentDeks: Object.fromEntries(
          contentEntries.map(([blobId, key]) => [blobId, wrapMemoryKeyV2(nextRoot, key)])
        ),
      }
      this.commitKeys(keys, nextRoot.id)
      this.root = nextRoot
    } finally {
      identity.fill(0)
      matchRoot.fill(0)
      for (const [, key] of indexEntries) key.fill(0)
      for (const [, key] of contentEntries) key.fill(0)
    }
  }

  public describe(): MemoryKeyringDescriptionV2 {
    return {
      generation: this.current.generation,
      wrappingRootId: this.current.wrappingRootId,
      contentDekCount: Object.keys(this.current.keys.contentDeks).length,
      indexGenerationCount: Object.keys(this.current.keys.indexGenerations).length,
    }
  }

  /** 封一代新密钥环、切 CURRENT、删掉其余代；这是 keyring 唯一的写路径。 */
  private commitKeys(keys: MemoryKeyringKeysV2, wrappingRootId = this.root.id): void {
    const nextGeneration = this.current.generation + 1
    assertPositiveSafeIntegerV2(nextGeneration, 'keyring generation')
    const next = sealKeyringFileV2({
      format: MemoryKeyringFormatV2,
      generation: nextGeneration,
      createdAt: this.now(),
      wrappingRootId,
      keys,
    })
    writeKeyringGenerationV2(this.keyringDir, next, this.hooks)
    commitCurrentGenerationV2(this.keyringDir, nextGeneration, {
      label: 'keyring-current',
      hooks: this.hooks,
    })
    this.current = next

    invokeStorageStepV2(this.hooks, 'keyring:delete-old-generations')
    const entries = listGenerationEntriesV2(this.keyringDir, {
      suffix: KeyringGenerationSuffixV2,
      kind: 'file',
    })
    for (const entry of entries) {
      if (entry.generation !== nextGeneration) rmSync(entry.path, { force: true })
    }
    invokeStorageStepV2(this.hooks, 'keyring:fsync-after-delete')
    fsyncDirectoryV2(this.keyringDir)
  }

  /** 从注入的随机源取一把密钥；长度不对就是随机源坏了，抛 INVARIANT。 */
  private randomKey(): Buffer {
    const key = this.random(MemoryKeyringStoreV2.KeyByteLength)
    if (!Buffer.isBuffer(key) || key.length !== MemoryKeyringStoreV2.KeyByteLength) {
      throw new AppError('INVARIANT', 'keyring 随机源必须返回 32 字节。')
    }
    return Buffer.from(key)
  }
}
