import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import { MemoryBlobStoreV2 } from './storage/BlobStore'
import { ContentKeyServiceV2 } from './storage/ContentKeyService'
import { MemoryKeyringStoreV2 } from './storage/Keyring'
import type { MemoryWrappingRootV2 } from './storage/WrappingRoot'
import { openMemoryAuthorityV2 } from './AuthorityDatabase'
import { MemoryDreamRunCoordinatorV2 } from './DreamRuns'
import { MemoryErasureServiceV2 } from './ErasureSaga'
import { MemoryEvidenceIngestServiceV2 } from './EvidenceIngest'
import { MemoryIdentityKeyServiceV2 } from './IdentityKeys'
import { MemoryMeaningCurationServiceV2 } from './MeaningCuration'
import { MemoryTreeStoreV2 } from './TreeStore'

const ExpectedMinimumAssertionsV2 = 49
let assertionCount = 0

function check(ok: unknown, message: string): asserts ok {
  assert.ok(ok, message)
  assertionCount += 1
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert.equal(actual, expected, message)
  assertionCount += 1
}

function expectAppError(code: string, run: () => unknown, message: string): void {
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
      const decipher = createDecipheriv('aes-256-gcm', key, wrapped.subarray(0, 12))
      decipher.setAAD(Buffer.from(id, 'utf8'))
      decipher.setAuthTag(wrapped.subarray(12, 28))
      return Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()])
    },
  }
}

function runErasureSagaProbeV2(): void {
  const probeRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-erasure-v2-'))
  try {
    runProjectedClosureProbeV2(join(probeRoot, 'projected'))
    runPreProjectionEvidenceProbeV2(join(probeRoot, 'pre-projection'))
  } finally {
    rmSync(probeRoot, { recursive: true, force: true })
  }
}

function runProjectedClosureProbeV2(dataRoot: string): void {
  const authority = openMemoryAuthorityV2(dataRoot).store
  const keyring = MemoryKeyringStoreV2.open(
    authority.roots.keyringDir,
    createProbeWrappingRootV2()
  ).store
  const blobs = new MemoryBlobStoreV2(authority.roots.blobsDir)
  const contentKeys = new ContentKeyServiceV2(keyring, blobs)
  const identityKeys = new MemoryIdentityKeyServiceV2(keyring)
  const ingest = new MemoryEvidenceIngestServiceV2(
    authority,
    contentKeys,
    identityKeys,
    blobs
  )
  const tree = MemoryTreeStoreV2.open({ authority, contentKeys, keyring }).store
  const dream = new MemoryDreamRunCoordinatorV2(authority, contentKeys, tree)
  const curation = new MemoryMeaningCurationServiceV2(
    authority,
    contentKeys,
    identityKeys,
    tree,
    dream
  )
  const evidence = ingest.ingest({
    sourceType: 'chat',
    trustLevel: 'user_stated',
    scope: { type: 'global' },
    occurredAt: 1,
    payload: '需要彻底清除的项目证据',
    privacyClass: 'personal',
    createdAt: 1,
  })
  const run = dream.startNextBatch({
    trigger: 'manual',
    batchSize: 1,
    modelProfile: { provider: 'local', model: 'probe' },
    startedAt: 2,
  })
  check(run?.kind === 'started', '应建立整理 run')
  if (!run || run.kind !== 'started') throw new Error('unreachable')
  curation.curateAndCommit({
    runId: run.runId,
    tokenUsage: 1,
    committedAt: 3,
    proposal: {
      candidates: [
        {
          kind: 'concept',
          candidateKey: 'private-project',
          conceptType: 'project',
          name: '私密项目',
          description: '需要完整擦除',
          scope: { type: 'global' },
          privacyClass: 'personal',
          lifecycleState: 'active',
          firstSeenAt: 1,
          lastActiveAt: 1,
          salience: 0.8,
          activation: 0.8,
          evidenceIds: [evidence.id],
        },
      ],
      identity: {
        statement: '我是帮助用户处理私密项目的 AI',
        globalMainline: '完成私密项目',
        confidence: 0.8,
        evidenceIds: [evidence.id],
        supportingConceptKeys: ['private-project'],
        supportingEpisodeKeys: [],
        supportingClaimKeys: [],
      },
    },
  })
  const conceptId = authority.database
    .prepare(`SELECT id FROM memory_concepts`)
    .pluck()
    .get() as string
  const oldIdentityId = authority.database
    .prepare(`SELECT id FROM memory_identity_epochs WHERE ended_at IS NULL`)
    .pluck()
    .get() as string
  const erasure = new MemoryErasureServiceV2(
    authority,
    contentKeys,
    keyring,
    tree
  )
  const preview = erasure.preview({ type: 'concept', id: conceptId })
  equal(preview.closure.conceptIds.length, 1, '闭包含目标 Concept')
  equal(preview.closure.evidenceIds.length, 1, '闭包含支撑 Evidence')
  equal(preview.closure.identityEpochIds.length, 1, '闭包含受影响 Identity')
  equal(preview.closure.identityEpochIds[0], oldIdentityId, '闭包锚定旧 Identity')
  equal(preview.closure.treeStableKeys.length, 2, '闭包含 concept/mainline 两个树节点')
  check(preview.closure.blobIds.length >= 6, '闭包应覆盖正文、Identity 与 candidate ledger')
  equal(
    erasure.preview({ type: 'concept', id: conceptId }).digest,
    preview.digest,
    '同一权威状态闭包必须确定'
  )
  for (const blobId of preview.closure.blobIds) {
    check(blobs.hasBlob(blobId), `第一段前 blob 应存在：${blobId}`)
  }

  const confirmed = erasure.confirm(preview, 4)
  equal(confirmed.redactVersion, 2, '擦除第一段必须推进树版本')
  equal(confirmed.privacyGeneration, 1, 'privacy generation 单调推进')
  equal(erasure.status(confirmed.requestId).state, 'confirmed', '第一段状态')
  equal(readMetaV2(authority, 'tree_version'), 2, '树版本与第一段同事务')
  equal(readMetaV2(authority, 'privacy_generation'), 1, 'privacy generation 与第一段同事务')
  equal(
    authority.database
      .prepare(`SELECT eligibility_state FROM memory_evidence WHERE id = ?`)
      .pluck()
      .get(evidence.id),
    'erased',
    'Evidence 第一段即墓碑'
  )
  equal(
    authority.database
      .prepare(`SELECT lifecycle_state FROM memory_concepts WHERE id = ?`)
      .pluck()
      .get(conceptId),
    'erased',
    'Concept 第一段即墓碑'
  )
  check(erasure.isDenied({ type: 'concept', id: conceptId }), '第一段 deny-set 即时生效')
  equal(
    authority.database
      .prepare(
        `SELECT count(*) FROM memory_erasure_targets
         WHERE request_id = ? AND state = 'active'`
      )
      .pluck()
      .get(confirmed.requestId),
    Object.values(preview.counts).reduce((sum, count) => sum + count, 0),
    'normalized targets 应覆盖闭包全部类型'
  )
  equal(
    authority.database
      .prepare(`SELECT count(*) FROM memory_identity_epochs WHERE ended_at IS NULL`)
      .pluck()
      .get(),
    1,
    '受影响 Identity 应由中性 epoch 替换'
  )
  const activeIdentityId = authority.database
    .prepare(`SELECT id FROM memory_identity_epochs WHERE ended_at IS NULL`)
    .pluck()
    .get() as string
  check(activeIdentityId !== oldIdentityId, '替代 Identity 必须是新 epoch')
  equal(
    authority.database
      .prepare(
        `SELECT identity_statement_blob_ref FROM memory_identity_epochs WHERE id = ?`
      )
      .pluck()
      .get(oldIdentityId),
    null,
    '旧 Identity 正文引用第一段清空'
  )
  equal(
    tree.current.nodes.find((node) => node.subjectId === conceptId)?.visibilityState,
    'redacted',
    '当前树 Concept 第一段即 redacted'
  )
  equal(
    tree.current.nodes.find((node) => node.subjectId === oldIdentityId)?.visibilityState,
    'redacted',
    '旧主线第一段即 redacted'
  )
  equal(
    tree.current.nodes.find((node) => node.subjectId === activeIdentityId)?.visibilityState,
    'active',
    '中性替代主线应保持 active'
  )
  check(tree.inspectProjection()?.matchesAuthority, '第一段后派生投影与 authority 会合')
  for (const blobId of preview.closure.blobIds) {
    check(blobs.hasBlob(blobId), '第一段只遮蔽，不冒充已完成物理清理')
  }

  const verified = erasure.purge(confirmed.requestId, 5)
  equal(verified.state, 'verified', '第二段完成后 verified')
  equal(verified.verifiedAt, 5, 'verified 时间')
  equal(
    authority.database
      .prepare(
        `SELECT count(*) FROM memory_erasure_targets
         WHERE request_id = ? AND state = 'active'`
      )
      .pluck()
      .get(confirmed.requestId),
    0,
    '基表/投影验证后 normalized targets 可退役'
  )
  for (const blobId of preview.closure.blobIds) {
    check(!blobs.hasBlob(blobId), `第二段应物理清除 blob：${blobId}`)
    equal(
      authority.database
        .prepare(`SELECT state FROM memory_content_blobs WHERE blob_id = ?`)
        .pluck()
        .get(blobId),
      'erased',
      'content blob authority 墓碑'
    )
    expectAppError(
      'MEMORY_DEK_DESTROYED',
      () => keyring.getContentDek(blobId),
      '第二段必须 crypto-shred DEK'
    )
  }
  check(
    erasure.isDenied({ type: 'concept', id: conceptId }),
    'targets 退役后基表墓碑仍是查询权威'
  )
  equal(erasure.purge(confirmed.requestId, 6).state, 'verified', 'purge 重试幂等')
  equal(erasure.resumePending(7).length, 0, 'verified saga 不再进入恢复队列')
  equal(
    MemoryTreeStoreV2.open({ authority, contentKeys, keyring }).store.version,
    2,
    'DEK 销毁后结构链仍可重开'
  )
  authority.close()
}

function runPreProjectionEvidenceProbeV2(dataRoot: string): void {
  const authority = openMemoryAuthorityV2(dataRoot).store
  const keyring = MemoryKeyringStoreV2.open(
    authority.roots.keyringDir,
    createProbeWrappingRootV2()
  ).store
  const blobs = new MemoryBlobStoreV2(authority.roots.blobsDir)
  const contentKeys = new ContentKeyServiceV2(keyring, blobs)
  const identityKeys = new MemoryIdentityKeyServiceV2(keyring)
  const ingest = new MemoryEvidenceIngestServiceV2(
    authority,
    contentKeys,
    identityKeys,
    blobs
  )
  const tree = MemoryTreeStoreV2.open({ authority, contentKeys, keyring }).store
  const evidence = ingest.ingest({
    sourceType: 'chat',
    trustLevel: 'user_stated',
    scope: { type: 'global' },
    occurredAt: 1,
    payload: '尚未投影就要求擦除',
    privacyClass: 'personal',
    createdAt: 1,
  })
  const erasure = new MemoryErasureServiceV2(
    authority,
    contentKeys,
    keyring,
    tree
  )
  const confirmed = erasure.confirm(erasure.preview({ type: 'evidence', id: evidence.id }), 2)
  equal(confirmed.redactVersion, 1, '未投影 Evidence 擦除也必须推进 CAS 版本')
  equal(tree.current.nodes.length, 2, '空树擦除应建立 root + 中性主线')
  check(tree.current.nodes.some((node) => node.stableKey === 'root'), '空树擦除补 root')
  check(
    tree.current.nodes.some((node) => node.namespace === 'identity'),
    '空树擦除补中性 Identity'
  )
  equal(erasure.purge(confirmed.requestId, 3).state, 'verified', '未投影 Evidence 可完整清除')
  authority.close()
}

function readMetaV2(
  authority: ReturnType<typeof openMemoryAuthorityV2>['store'],
  key: string
): number {
  return authority.database
    .prepare(`SELECT integer_value FROM memory_meta WHERE key = ?`)
    .pluck()
    .get(key) as number
}

runErasureSagaProbeV2()
check(
  assertionCount >= ExpectedMinimumAssertionsV2,
  `erasure saga v2 断言计数不足：${assertionCount}/${ExpectedMinimumAssertionsV2}`
)
process.stdout.write(`Memory erasure saga v2 probe: ${assertionCount} assertions passed.\n`)
