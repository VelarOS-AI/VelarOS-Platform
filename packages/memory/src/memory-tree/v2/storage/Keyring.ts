import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import { canonicalStringifyV2 } from '../DiffChain'

import {
  fsyncDirectoryV2,
  invokeStorageStepV2,
  removeStaleTempFilesV2,
  type StorageStepHooksV2,
  writeFileAtomicV2,
} from './AtomicFile'
import { assertMemoryBlobIdV2 } from './BlobStore'
import { MemoryStorageErrorCodesV2 } from './ErrorCodes'
import {
  commitCurrentGenerationV2,
  listGenerationEntriesV2,
  readCurrentGenerationV2,
} from './GenerationPointer'
import {
  assertMemoryWrappingRootV2,
  decodeCanonicalBase64V2,
  MemoryWrappingRootIdPatternV2,
  type MemoryWrappingRootV2,
  unwrapMemoryKeyV2,
  wrapMemoryKeyV2,
} from './WrappingRoot'

const MemoryKeyringFormatV2 = 'velaros.memory.keyring.v2'
const KeyringGenerationSuffixV2 = '.keyring.json'
const IntegrityPatternV2 = /^[0-9a-f]{64}$/
const PositiveIntegerPatternV2 = /^[1-9][0-9]*$/

interface MemoryKeyringKeysV2 {
  readonly identity: string
  readonly matchRoot: string
  readonly indexGenerations: Readonly<Record<string, string>>
  readonly contentDeks: Readonly<Record<string, string>>
}

interface MemoryKeyringUnsignedV2 {
  readonly format: typeof MemoryKeyringFormatV2
  readonly generation: number
  readonly createdAt: number
  readonly wrappingRootId: string
  readonly keys: MemoryKeyringKeysV2
}

interface MemoryKeyringFileV2 extends MemoryKeyringUnsignedV2 {
  readonly integrity: string
}

export interface MemoryKeyringOpenReportV2 {
  readonly generation: number
  readonly created: boolean
  readonly cleanedResidueCount: number
}

export interface MemoryKeyringStoreOptionsV2 {
  readonly hooks?: StorageStepHooksV2
  readonly now?: () => number
  readonly random?: (byteLength: number) => Buffer
}

/**
 * keyring 唯一物理 owner。
 *
 * 安全取舍：keyring 只保留 CURRENT 指向的一代。普通换代在 CURRENT 原子切换前旧代仍权威，
 * 切换后旧代立即删除；若崩溃落在删除窗口，下一次 open 以 CURRENT 为唯一裁决并清掉其它代。
 * 这牺牲“任意历史代回滚”，换来更强的不复活性质：成功剔除的 DEK 不可能藏在可回滚旧代。
 * storage/index 的回滚必须与一个仍含完整密钥集的新 keyring 代成对创建，不能回滚 keyring 文件。
 */
export class MemoryKeyringStoreV2 {
  private readonly keyringDir: string
  private readonly hooks: StorageStepHooksV2 | undefined
  private readonly now: () => number
  private readonly random: (byteLength: number) => Buffer
  private root: MemoryWrappingRootV2
  private current: MemoryKeyringFileV2

  private constructor(
    keyringDir: string,
    root: MemoryWrappingRootV2,
    current: MemoryKeyringFileV2,
    options: MemoryKeyringStoreOptionsV2
  ) {
    this.keyringDir = keyringDir
    this.root = root
    this.current = current
    this.hooks = options.hooks
    this.now = options.now ?? Date.now
    this.random = options.random ?? randomBytes
  }

  public static open(
    keyringDir: string,
    root: MemoryWrappingRootV2,
    options: MemoryKeyringStoreOptionsV2 = {}
  ): { store: MemoryKeyringStoreV2; report: MemoryKeyringOpenReportV2 } {
    assertMemoryWrappingRootV2(root)
    mkdirSync(keyringDir, { recursive: true })
    let cleanedResidueCount = removeStaleTempFilesV2(keyringDir)
    const currentGeneration = readCurrentGenerationV2(keyringDir)
    const entries = listGenerationEntriesV2(keyringDir, {
      suffix: KeyringGenerationSuffixV2,
      kind: 'file',
    })

    if (currentGeneration === null) {
      if (entries.length > 0) {
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
      return {
        store: new MemoryKeyringStoreV2(keyringDir, root, initial, options),
        report: {
          generation: initial.generation,
          created: true,
          cleanedResidueCount,
        },
      }
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

    return {
      store: new MemoryKeyringStoreV2(keyringDir, root, current, options),
      report: {
        generation: current.generation,
        created: false,
        cleanedResidueCount,
      },
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

  /** crypto-shred 生效点：新代提交后，旧代在本次调用或下次 open 时全部清理。 */
  public destroyContentDek(blobId: string): boolean {
    assertMemoryBlobIdV2(blobId)
    if (!this.current.keys.contentDeks[blobId]) return false
    const contentDeks = { ...this.current.keys.contentDeks }
    delete contentDeks[blobId]
    this.commitKeys({ ...this.current.keys, contentDeks })
    return true
  }

  public getOrCreateIndexGenerationKey(generation: number): Buffer {
    assertGenerationV2(generation)
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
    assertGenerationV2(generation)
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
    assertGenerationV2(generation)
    const key = String(generation)
    if (!this.current.keys.indexGenerations[key]) return false
    const indexGenerations = { ...this.current.keys.indexGenerations }
    delete indexGenerations[key]
    this.commitKeys({ ...this.current.keys, indexGenerations })
    return true
  }

  /** wrapping root 轮换只重包全部 key，不改 key 字节。 */
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

  /** 探针/诊断只读：不返回包装字节，避免诊断面变成密钥旁路。 */
  public describe(): {
    generation: number
    wrappingRootId: string
    contentDekCount: number
    indexGenerationCount: number
  } {
    return {
      generation: this.current.generation,
      wrappingRootId: this.current.wrappingRootId,
      contentDekCount: Object.keys(this.current.keys.contentDeks).length,
      indexGenerationCount: Object.keys(this.current.keys.indexGenerations).length,
    }
  }

  private commitKeys(keys: MemoryKeyringKeysV2, wrappingRootId = this.root.id): void {
    const nextGeneration = this.current.generation + 1
    assertGenerationV2(nextGeneration)
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

  private randomKey(): Buffer {
    const key = this.random(32)
    if (!Buffer.isBuffer(key) || key.length !== 32) {
      throw new AppError('INVARIANT', 'keyring 随机源必须返回 32 字节。')
    }
    return Buffer.from(key)
  }
}

function createInitialKeyringV2(
  root: MemoryWrappingRootV2,
  options: MemoryKeyringStoreOptionsV2
): MemoryKeyringFileV2 {
  const random = options.random ?? randomBytes
  const identity = random(32)
  const matchRoot = random(32)
  if (identity.length !== 32 || matchRoot.length !== 32) {
    throw new AppError('INVARIANT', 'keyring 随机源必须返回 32 字节。')
  }
  try {
    return sealKeyringFileV2({
      format: MemoryKeyringFormatV2,
      generation: 1,
      createdAt: (options.now ?? Date.now)(),
      wrappingRootId: root.id,
      keys: {
        identity: wrapMemoryKeyV2(root, identity),
        matchRoot: wrapMemoryKeyV2(root, matchRoot),
        indexGenerations: {},
        contentDeks: {},
      },
    })
  } finally {
    identity.fill(0)
    matchRoot.fill(0)
  }
}

function writeKeyringGenerationV2(
  keyringDir: string,
  file: MemoryKeyringFileV2,
  hooks?: StorageStepHooksV2
): void {
  const path = join(keyringDir, `generation-${file.generation}${KeyringGenerationSuffixV2}`)
  if (existsSync(path)) {
    throw new AppError('INVARIANT', 'keyring 代际文件已存在，禁止覆盖。', undefined, {
      generation: file.generation,
    })
  }
  writeFileAtomicV2(path, canonicalStringifyV2(file), {
    label: `keyring-generation-${file.generation}`,
    hooks,
  })
}

function sealKeyringFileV2(unsigned: MemoryKeyringUnsignedV2): MemoryKeyringFileV2 {
  return {
    ...unsigned,
    integrity: createHash('sha256').update(canonicalStringifyV2(unsigned)).digest('hex'),
  }
}

function parseKeyringFileV2(raw: string, expectedGeneration: number): MemoryKeyringFileV2 {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, 'keyring JSON 无法解析。', error)
  }
  if (
    !isStrictRecordV2(parsed, [
      'format',
      'generation',
      'createdAt',
      'wrappingRootId',
      'keys',
      'integrity',
    ])
  ) {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, 'keyring 顶层字段不符合 v2 严格格式。')
  }
  if (
    parsed['format'] !== MemoryKeyringFormatV2 ||
    parsed['generation'] !== expectedGeneration ||
    !Number.isSafeInteger(parsed['createdAt']) ||
    (parsed['createdAt'] as number) < 0 ||
    typeof parsed['wrappingRootId'] !== 'string' ||
    !MemoryWrappingRootIdPatternV2.test(parsed['wrappingRootId'] as string) ||
    typeof parsed['integrity'] !== 'string' ||
    !IntegrityPatternV2.test(parsed['integrity'] as string)
  ) {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, 'keyring 标量字段不符合 v2 严格格式。')
  }
  const keys = parseKeyringKeysV2(parsed['keys'])
  const unsigned: MemoryKeyringUnsignedV2 = {
    format: MemoryKeyringFormatV2,
    generation: expectedGeneration,
    createdAt: parsed['createdAt'] as number,
    wrappingRootId: parsed['wrappingRootId'] as string,
    keys,
  }
  const expectedIntegrity = createHash('sha256')
    .update(canonicalStringifyV2(unsigned))
    .digest('hex')
  if (parsed['integrity'] !== expectedIntegrity) {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, 'keyring integrity 校验失败。')
  }
  return { ...unsigned, integrity: expectedIntegrity }
}

function parseKeyringKeysV2(input: unknown): MemoryKeyringKeysV2 {
  if (!isStrictRecordV2(input, ['identity', 'matchRoot', 'indexGenerations', 'contentDeks'])) {
    throw new AppError(
      MemoryStorageErrorCodesV2.corruption,
      'keyring keys 字段不符合 v2 严格格式。'
    )
  }
  if (typeof input['identity'] !== 'string' || typeof input['matchRoot'] !== 'string') {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, 'keyring 基础密钥信封缺失。')
  }
  assertWrappedKeyEnvelopeV2(input['identity'], 'identity')
  assertWrappedKeyEnvelopeV2(input['matchRoot'], 'matchRoot')
  const indexGenerations = parseWrappedMapV2(input['indexGenerations'], (key) =>
    PositiveIntegerPatternV2.test(key)
  )
  const contentDeks = parseWrappedMapV2(input['contentDeks'], (key) => {
    try {
      assertMemoryBlobIdV2(key)
      return true
    } catch {
      return false
    }
  })
  return {
    identity: input['identity'],
    matchRoot: input['matchRoot'],
    indexGenerations,
    contentDeks,
  }
}

function parseWrappedMapV2(
  input: unknown,
  validateKey: (key: string) => boolean
): Record<string, string> {
  if (!isPlainRecordV2(input)) {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, 'keyring wrapped map 不是纯对象。')
  }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!validateKey(key) || typeof value !== 'string' || !value) {
      throw new AppError(MemoryStorageErrorCodesV2.corruption, 'keyring wrapped map 含非法条目。')
    }
    assertWrappedKeyEnvelopeV2(value, key)
    result[key] = value
  }
  return result
}

function assertWrappedKeyEnvelopeV2(value: string, label: string): void {
  try {
    decodeCanonicalBase64V2(value, `keyring wrapped key ${label}`)
  } catch (error) {
    throw new AppError(
      MemoryStorageErrorCodesV2.corruption,
      'keyring 密钥信封不是规范 base64。',
      error
    )
  }
}

function isStrictRecordV2(
  input: unknown,
  expectedKeys: readonly string[]
): input is Record<string, unknown> {
  if (!isPlainRecordV2(input)) return false
  const actual = Object.keys(input).sort()
  const expected = [...expectedKeys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isPlainRecordV2(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false
  const prototype: unknown = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function assertGenerationV2(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new AppError('VALIDATION', 'keyring generation 必须是正整数。')
  }
}
