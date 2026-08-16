import assert from 'node:assert/strict'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import { MemoryBlobStoreV2 } from './BlobStore'
import { ContentKeyServiceV2 } from './ContentKeyService'
import { MemoryStorageErrorCodesV2 } from './ErrorCodes'
import { MemoryKeyringStoreV2 } from './Keyring'
import {
  formatBackupSnapshotNameV2,
  openMemoryPhysicalRootsV2,
} from './PhysicalRoots'
import type { MemoryWrappingRootV2 } from './WrappingRoot'

const CrashStepsV2 = [
  'keyring-generation-3:write-temp',
  'keyring-generation-3:fsync-temp',
  'keyring-generation-3:rename',
  'keyring-generation-3:fsync-dir',
  'keyring-current:write-temp',
  'keyring-current:fsync-temp',
  'keyring-current:rename',
  'keyring-current:fsync-dir',
  'keyring:delete-old-generations',
  'keyring:fsync-after-delete',
] as const

const ExpectedAssertionCountV2 = 136
let assertionCount = 0

function check(ok: unknown, message: string): asserts ok {
  assert.ok(ok, message)
  assertionCount += 1
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert.equal(actual, expected, message)
  assertionCount += 1
}

function expectCode(code: string, run: () => unknown, message: string): void {
  let observed: unknown
  try {
    run()
  } catch (error) {
    // arch-guard:silent-catch-ok 探针在下方断言捕获到的错误类型与错误码。
    observed = error
  }
  check(observed instanceof AppError, `${message}: 应抛 AppError`)
  equal((observed as AppError).code, code, message)
}

function createProbeWrappingRootV2(secret = randomBytes(32)): MemoryWrappingRootV2 {
  const key = Buffer.from(secret)
  const id = `wr-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
  return {
    id,
    wrapKey(raw): Buffer {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from(id, 'utf8'))
      const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
    },
    unwrapKey(wrapped): Buffer {
      if (wrapped.length !== 60) throw new Error('probe wrapping envelope length mismatch')
      const decipher = createDecipheriv('aes-256-gcm', key, wrapped.subarray(0, 12))
      decipher.setAAD(Buffer.from(id, 'utf8'))
      decipher.setAuthTag(wrapped.subarray(12, 28))
      return Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()])
    },
  }
}

function generationFiles(keyringDir: string): string[] {
  return readdirSync(keyringDir)
    .filter((name) => /^generation-[1-9][0-9]*\.keyring\.json$/.test(name))
    .sort()
}

function hasTempResidue(directory: string): boolean {
  return readdirSync(directory).some((name) => name.endsWith('.tmp'))
}

function runStorageProbeV2(): void {
  const probeRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-storage-v2-'))
  try {
    runPhysicalRootProbeV2(join(probeRoot, 'layout'))
    runContentEnvelopeProbeV2(join(probeRoot, 'content'))
    runKeyringStrictnessProbeV2(join(probeRoot, 'strictness'))
    for (const [index, step] of CrashStepsV2.entries()) {
      runCrashRecoveryProbeV2(join(probeRoot, `crash-${index}`), step)
    }
  } finally {
    rmSync(probeRoot, { force: true, recursive: true })
  }
}

function runPhysicalRootProbeV2(dataRoot: string): void {
  const opened = openMemoryPhysicalRootsV2(dataRoot)
  const { roots } = opened
  for (const directory of [
    roots.authorityDir,
    roots.blobsDir,
    roots.keyringDir,
    roots.indexDir,
    roots.backupDir,
  ]) {
    check(existsSync(directory), `五根目录应存在：${directory}`)
  }
  equal(opened.report.createdDirectories.length, 6, '首次 open 应创建 memory 根与五个物理根')
  equal(openMemoryPhysicalRootsV2(dataRoot).report.createdDirectories.length, 0, '重复 open 应幂等')

  const snapshot = join(roots.backupDir, formatBackupSnapshotNameV2(0))
  mkdirSync(join(snapshot, 'keyring'), { recursive: true })
  expectCode(
    'INVARIANT',
    () => openMemoryPhysicalRootsV2(dataRoot),
    'backup 内出现 keyring 必须硬拒绝'
  )
}

function runContentEnvelopeProbeV2(dataRoot: string): void {
  const { roots } = openMemoryPhysicalRootsV2(dataRoot)
  const firstRoot = createProbeWrappingRootV2()
  const opened = MemoryKeyringStoreV2.open(roots.keyringDir, firstRoot)
  equal(opened.report.generation, 1, '初始 keyring 代号')
  check(opened.report.created, '初始 keyring 应标为新建')

  const identity = opened.store.getIdentityKey()
  const matchRoot = opened.store.getMatchRootKey()
  try {
    equal(identity.length, 32, 'identity key 长度')
    equal(matchRoot.length, 32, 'match root key 长度')
    check(!identity.equals(matchRoot), 'identity key 与 match root key 必须独立')
    const initialKeyring = readFileSync(
      join(roots.keyringDir, 'generation-1.keyring.json'),
      'utf8'
    )
    check(!initialKeyring.includes(identity.toString('base64')), 'keyring 不得落盘裸 identity key')
    check(!initialKeyring.includes(matchRoot.toString('base64')), 'keyring 不得落盘裸 match root key')
  } finally {
    identity.fill(0)
    matchRoot.fill(0)
  }

  const blobs = new MemoryBlobStoreV2(roots.blobsDir)
  const contentKeys = new ContentKeyServiceV2(opened.store, blobs)
  const secret = 'low-entropy-secret: 0000'
  const sealed = contentKeys.sealContent(secret)
  equal(sealed.byteLength, Buffer.byteLength(secret), 'seal 应返回明文字节长度')
  check(/^c2:[0-9a-f]{64}$/.test(sealed.commitment), '随机化内容承诺形态')
  const envelope = blobs.readBlob(sealed.blobId)
  check(!envelope.includes(Buffer.from(secret, 'utf8')), '密文 blob 不得含明文')
  equal(
    contentKeys.openContent(sealed.blobId, sealed.commitment).toString('utf8'),
    secret,
    '正确承诺应解密正文'
  )
  expectCode(
    MemoryStorageErrorCodesV2.commitmentMismatch,
    () => contentKeys.openContent(sealed.blobId, `c2:${'0'.repeat(64)}`),
    '错误承诺必须拒绝'
  )

  const blobPath = blobs.pathForBlob(sealed.blobId)
  const originalEnvelope = readFileSync(blobPath)
  const damagedEnvelope = Buffer.from(originalEnvelope)
  damagedEnvelope[damagedEnvelope.length - 2] ^= 1
  writeFileSync(blobPath, damagedEnvelope)
  expectCode(
    MemoryStorageErrorCodesV2.blobCorrupted,
    () => contentKeys.openContent(sealed.blobId, sealed.commitment),
    '篡改 blob 必须被 GCM/严格解析捕获'
  )
  writeFileSync(blobPath, originalEnvelope)

  const secondRoot = createProbeWrappingRootV2()
  const identityBeforeRotation = opened.store.getIdentityKey()
  opened.store.rotateWrappingRoot(secondRoot)
  const identityAfterRotation = opened.store.getIdentityKey()
  try {
    check(
      identityBeforeRotation.equals(identityAfterRotation),
      'wrapping root 轮换不得改变被包密钥'
    )
  } finally {
    identityBeforeRotation.fill(0)
    identityAfterRotation.fill(0)
  }
  equal(opened.store.wrappingRootId, secondRoot.id, '轮换后记录新 wrapping root id')
  expectCode(
    MemoryStorageErrorCodesV2.wrappingRootMismatch,
    () => MemoryKeyringStoreV2.open(roots.keyringDir, firstRoot),
    '旧 wrapping root 不得重开 keyring'
  )
  const reopened = MemoryKeyringStoreV2.open(roots.keyringDir, secondRoot).store
  equal(
    new ContentKeyServiceV2(reopened, blobs)
      .openContent(sealed.blobId, sealed.commitment)
      .toString('utf8'),
    secret,
    '新 wrapping root 应可恢复正文'
  )

  check(contentKeys.eraseContent(sealed.blobId), 'crypto-shred 应报告销毁了 DEK')
  check(!blobs.hasBlob(sealed.blobId), 'crypto-shred 后应卫生删除密文 blob')
  expectCode(
    MemoryStorageErrorCodesV2.dekDestroyed,
    () => opened.store.getContentDek(sealed.blobId),
    '销毁后的 DEK 不可读取'
  )
  const keyringText = readFileSync(
    join(roots.keyringDir, generationFiles(roots.keyringDir)[0]),
    'utf8'
  )
  check(!keyringText.includes(sealed.blobId), 'CURRENT keyring 不得保留已销毁 DEK 条目')
  equal(generationFiles(roots.keyringDir).length, 1, 'keyring 只保留 CURRENT 一代')
}

function runKeyringStrictnessProbeV2(dataRoot: string): void {
  const { roots } = openMemoryPhysicalRootsV2(dataRoot)
  const root = createProbeWrappingRootV2()
  MemoryKeyringStoreV2.open(roots.keyringDir, root)
  const filePath = join(roots.keyringDir, 'generation-1.keyring.json')
  const original = readFileSync(filePath, 'utf8')
  const parsed = JSON.parse(original) as Record<string, unknown>
  writeFileSync(filePath, JSON.stringify({ ...parsed, unknown: true }))
  expectCode(
    MemoryStorageErrorCodesV2.corruption,
    () => MemoryKeyringStoreV2.open(roots.keyringDir, root),
    'keyring 未知字段必须拒绝'
  )
  writeFileSync(filePath, original)

  const integrityDamaged = JSON.parse(original) as { integrity: string }
  integrityDamaged.integrity = '0'.repeat(64)
  writeFileSync(filePath, JSON.stringify(integrityDamaged))
  expectCode(
    MemoryStorageErrorCodesV2.corruption,
    () => MemoryKeyringStoreV2.open(roots.keyringDir, root),
    'keyring integrity 失配必须拒绝'
  )
}

function runCrashRecoveryProbeV2(dataRoot: string, crashStep: string): void {
  const { roots } = openMemoryPhysicalRootsV2(dataRoot)
  const root = createProbeWrappingRootV2()
  const seed = MemoryKeyringStoreV2.open(roots.keyringDir, root).store
  const blobId = createHash('sha256').update(crashStep).digest('hex').slice(0, 32)
  const dek = randomBytes(32)
  try {
    seed.addContentDek(blobId, dek)
  } finally {
    dek.fill(0)
  }
  const crashing = MemoryKeyringStoreV2.open(roots.keyringDir, root, {
    hooks: {
      beforeStep(step): void {
        if (step === crashStep) throw new Error(`simulated crash before ${step}`)
      },
    },
  }).store
  assert.throws(() => crashing.destroyContentDek(blobId), /simulated crash/)
  assertionCount += 1

  const recovered = MemoryKeyringStoreV2.open(roots.keyringDir, root)
  check(!hasTempResidue(roots.keyringDir), `${crashStep}: 恢复后不得留 temp`)
  equal(generationFiles(roots.keyringDir).length, 1, `${crashStep}: 恢复后只留 CURRENT`)
  if (recovered.store.describe().contentDekCount > 0) {
    check(recovered.store.destroyContentDek(blobId), `${crashStep}: 未提交销毁应可重试`)
  }
  const final = MemoryKeyringStoreV2.open(roots.keyringDir, root).store
  expectCode(
    MemoryStorageErrorCodesV2.dekDestroyed,
    () => final.getContentDek(blobId),
    `${crashStep}: 销毁提交后 DEK 不得复活`
  )
  equal(generationFiles(roots.keyringDir).length, 1, `${crashStep}: 最终只保留 CURRENT`)
  check(
    !readFileSync(
      join(roots.keyringDir, generationFiles(roots.keyringDir)[0]),
      'utf8'
    ).includes(blobId),
    `${crashStep}: 可存活代际中不得含已销毁 DEK`
  )
  const reopened = MemoryKeyringStoreV2.open(roots.keyringDir, root).store
  expectCode(
    MemoryStorageErrorCodesV2.dekDestroyed,
    () => reopened.getContentDek(blobId),
    `${crashStep}: 二次重开不得复活 DEK`
  )
}

runStorageProbeV2()
assert.equal(
  assertionCount,
  ExpectedAssertionCountV2,
  'storage v2 探针断言数变化时必须显式复核并更新冻结基线'
)
console.info(
  `memory storage v2 probe: ${assertionCount}/${ExpectedAssertionCountV2} assertions passed`
)
