import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import { MemoryBlobStoreV2 } from './storage/BlobStore'
import { ContentKeyServiceV2 } from './storage/ContentKeyService'
import { MemoryKeyringStoreV2 } from './storage/Keyring'
import type { MemoryWrappingRootV2 } from './storage/WrappingRoot'
import { openMemoryAuthorityV2 } from './AuthorityDatabase'
import type { MemoryTreeNodeStructV2 } from './DiffChain'
import { MemoryDreamRunCoordinatorV2 } from './DreamRuns'
import { MemoryEvidenceIngestServiceV2 } from './EvidenceIngest'
import {
  canonicalizeWorkspacePathV2,
  computeDreamInputFingerprintV2,
  MemoryIdentityKeyServiceV2,
  normalizeIdentityTextV2,
  normalizeOriginV2,
  normalizeSourceReferenceV2,
} from './IdentityKeys'
import { MemoryTreeStoreV2 } from './TreeStore'

const ExpectedMinimumAssertionsV2 = 54
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

function runIngestDreamProbeV2(): void {
  const probeRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-ingest-dream-v2-'))
  try {
    const workspace = join(probeRoot, 'WorkspaceCanonical')
    const workspaceLink = join(probeRoot, 'workspace-link')
    mkdirSync(workspace)
    symlinkSync(workspace, workspaceLink)

    const authority = openMemoryAuthorityV2(join(probeRoot, 'data')).store
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

    equal(normalizeIdentityTextV2('  Ｖelar—OS  '), 'velar os', 'identity NFKC/空白')
    equal(normalizeIdentityTextV2('C++ / C# / C'), 'c++ c# c', '语言标点必须保留')
    equal(normalizeOriginV2('HTTPS://EXAMPLE.com:443/a'), 'https://example.com', 'origin')
    equal(
      normalizeSourceReferenceV2('https://example.com/a?q=1#secret'),
      'https://example.com/a?q=1',
      'source-ref 应去 fragment'
    )
    equal(
      canonicalizeWorkspacePathV2(workspaceLink),
      canonicalizeWorkspacePathV2(workspace),
      'symlink 与真实路径必须收敛'
    )
    equal(
      identityKeys.workspaceScopeMatchKey(canonicalizeWorkspacePathV2(workspaceLink)),
      identityKeys.workspaceScopeMatchKey(canonicalizeWorkspacePathV2(workspace)),
      '路径真值相同必须派生同 scope key'
    )
    equal(
      identityKeys.conceptStableKey({
        conceptType: 'project',
        scopeType: 'workspace',
        scopeId: 'scope-1',
        discriminator: 'Ｖelar OS',
      }),
      identityKeys.conceptStableKey({
        conceptType: 'project',
        scopeType: 'workspace',
        scopeId: 'scope-1',
        discriminator: 'velar--os',
      }),
      '同一 identity-text 等值类必须派生同 stable key'
    )
    check(
      identityKeys
        .conceptStableKey({
          conceptType: 'project',
          scopeType: 'workspace',
          scopeId: 'scope-1',
          discriminator: 'Velar',
        })
        .startsWith('k2:'),
      'stable key 前缀'
    )
    check(
      identityKeys.sourceReferenceMatchKey('https://example.com/a#x') ===
        identityKeys.sourceReferenceMatchKey('https://example.com/a#y'),
      'source fragment 不得改变盲索引'
    )

    const first = ingest.ingest({
      sourceType: 'chat',
      trustLevel: 'user_stated',
      sourceId: 'source-1',
      sourceReference: 'https://example.com/a#private',
      sessionId: 'session-1',
      scope: { type: 'workspace', rootPath: workspaceLink },
      occurredAt: 10,
      payload: '第一条 active evidence',
      metadata: { order: 1 },
      privacyClass: 'personal',
      createdAt: 11,
    })
    const second = ingest.ingest({
      sourceType: 'chat',
      trustLevel: 'system_observed',
      scope: { type: 'global' },
      occurredAt: 20,
      payload: '第二条 excluded evidence',
      privacyClass: 'standard',
      eligibilityState: 'excluded',
      createdAt: 21,
    })
    const third = ingest.ingest({
      sourceType: 'browser',
      trustLevel: 'external_content',
      scope: { type: 'origin', origin: 'https://EXAMPLE.com:443/path' },
      occurredAt: 30,
      payload: '第三条 source-deleted evidence',
      privacyClass: 'sensitive',
      eligibilityState: 'source_deleted',
      createdAt: 31,
    })
    equal(first.ingestSequence, 1, '首条序号')
    equal(second.ingestSequence, 2, '第二条序号')
    equal(third.ingestSequence, 3, '第三条序号')
    equal(readMetaV2(authority, 'evidence_ingest_sequence'), 3, '采集计数器')
    equal(
      authority.database.prepare(`SELECT count(*) FROM memory_evidence`).pluck().get(),
      3,
      '三条 Evidence 必须落库'
    )
    check(first.scopeMatchKey?.startsWith('m2:'), 'workspace scope 只落盲索引')
    check(third.scopeMatchKey?.startsWith('m2:'), 'origin scope 只落盲索引')
    const authorityBytes = Buffer.from(
      authority.database.prepare(`SELECT payload_blob_ref FROM memory_evidence`).all().toString()
    )
    check(!authorityBytes.includes(Buffer.from('第一条 active evidence')), 'authority 不含正文')

    const batch1 = dream.startNextBatch({
      trigger: 'idle',
      batchSize: 2,
      modelProfile: { provider: null, model: null },
      startedAt: 40,
    })
    check(batch1?.kind === 'started', '首批应建立 run')
    if (!batch1 || batch1.kind !== 'started') throw new Error('unreachable')
    equal(batch1.frontierBefore, 0, '首批 frontier before')
    equal(batch1.frontierAfter, 2, '首批 frontier after')
    equal(batch1.evidence.length, 2, '首批包含 active/excluded 两条')
    equal(batch1.eligibleEvidence.length, 1, '只有 active 进入推理')
    equal(
      batch1.inputFingerprint,
      computeDreamInputFingerprintV2({
        frontierBefore: 0,
        evidenceIds: [first.id, second.id],
        modelProfile: { provider: null, model: null },
        pipelineVersion: 1,
      }),
      'fingerprint 必须逐字节可复算'
    )
    const materialized = dream.materializeEvidence(batch1.eligibleEvidence[0]!)
    equal(materialized.payload.toString('utf8'), '第一条 active evidence', '推理时按需解密')
    materialized.payload.fill(0)
    materialized.metadata?.fill(0)
    expectAppError(
      'VALIDATION',
      () => dream.materializeEvidence(batch1.evidence[1]!),
      'excluded 不得进入推理'
    )
    const emptyStats = {
      tokenUsage: 0,
      candidateCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
    }
    dream.markValidating(batch1.runId, { candidates: [] }, emptyStats)
    dream.commitNoop(batch1.runId, emptyStats, 41)
    equal(readMetaV2(authority, 'dream_frontier'), 2, 'no-op run 同事务推进 frontier')
    equal(readMetaV2(authority, 'tree_version'), 0, 'no-op run 不伪造空树版本')
    equal(readRunStateV2(authority, batch1.runId), 'committed', 'no-op run committed')

    const revivedOld = ingest.reactivate(second.id, 50)
    equal(revivedOld.mode, 'reingested', 'frontier 下可逆态必须再采集')
    equal(revivedOld.evidence.ingestSequence, 4, '再采集分配新序号')
    equal(
      authority.database
        .prepare(`SELECT eligibility_state FROM memory_evidence WHERE id = ?`)
        .pluck()
        .get(second.id),
      'excluded',
      '旧 Evidence 保持不合格审计态'
    )
    check(
      revivedOld.evidence.payloadBlobRef !== second.payloadBlobRef,
      '再采集必须重新密封，不能共享 DEK/blob'
    )
    const revivedFuture = ingest.reactivate(third.id, 51)
    equal(revivedFuture.mode, 'in_place', 'frontier 上方可逆态可原地恢复')
    equal(revivedFuture.evidence.ingestSequence, 3, '原地恢复不改序号')

    seedIdentityEpochV2(authority)
    const batch2 = dream.startNextBatch({
      trigger: 'idle',
      batchSize: 2,
      modelProfile: { provider: 'local', model: 'probe' },
      startedAt: 60,
    })
    check(batch2?.kind === 'started', '第二批应建立 run')
    if (!batch2 || batch2.kind !== 'started') throw new Error('unreachable')
    equal(batch2.frontierAfter, 4, '第二批覆盖原地恢复与再采集')
    equal(batch2.eligibleEvidence.length, 2, '两条均 active')
    const oneCandidate = {
      tokenUsage: 12,
      candidateCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
    }
    dream.markValidating(batch2.runId, { candidates: [{ id: 'candidate-1' }] }, oneCandidate)
    const committed = dream.commitTree(batch2.runId, {
      ...oneCandidate,
      ops: [{ type: 'add', before: [], after: [createRootNodeV2()] }],
      identityChange: { epochId: 'epoch-1', sequence: 1, predecessorId: null },
      activeIdentityEpochId: 'epoch-1',
      globalMainlineNodeId: 'root',
      committedAt: 61,
    })
    equal(committed.version, 1, 'Dream 树提交推进版本')
    equal(readMetaV2(authority, 'dream_frontier'), 4, '树提交同事务推进 frontier')
    equal(readRunStateV2(authority, batch2.runId), 'committed', '树提交同事务翻 run')
    equal(
      authority.database
        .prepare(`SELECT tree_version_after FROM memory_dream_runs WHERE id = ?`)
        .pluck()
        .get(batch2.runId),
      1,
      'run 账本锚定提交后树版本'
    )

    const fifth = ingest.ingest({
      sourceType: 'chat',
      trustLevel: 'system_observed',
      scope: { type: 'global' },
      occurredAt: 70,
      payload: 'CAS probe',
      privacyClass: 'standard',
      createdAt: 70,
    })
    equal(fifth.ingestSequence, 5, '第五条序号')
    const batch3 = dream.startNextBatch({
      trigger: 'idle',
      batchSize: 1,
      modelProfile: { provider: 'local', model: 'probe' },
      startedAt: 71,
    })
    check(batch3?.kind === 'started', 'CAS 批次建立')
    if (!batch3 || batch3.kind !== 'started') throw new Error('unreachable')
    dream.markValidating(batch3.runId, { candidates: [] }, emptyStats)
    authority.database
      .prepare(`UPDATE memory_meta SET integer_value = 2 WHERE key = 'tree_version'`)
      .run()
    expectAppError(
      'CONFLICT',
      () => dream.commitNoop(batch3.runId, emptyStats, 72),
      '事务点 tree CAS 失败'
    )
    equal(readMetaV2(authority, 'dream_frontier'), 4, 'CAS 失败 frontier 不动')
    equal(readRunStateV2(authority, batch3.runId), 'validating', 'CAS 失败 run 不动')
    authority.database
      .prepare(`UPDATE memory_meta SET integer_value = 1 WHERE key = 'tree_version'`)
      .run()
    const diffCountBeforeRecovery = authority.database
      .prepare(`SELECT count(*) FROM memory_tree_diffs`)
      .pluck()
      .get()
    equal(dream.recoverOrphanedRuns(73), 1, '应回收 validating 孤儿')
    equal(readRunStateV2(authority, batch3.runId), 'failed', '孤儿只翻 failed')
    equal(readMetaV2(authority, 'dream_frontier'), 4, '孤儿回收 frontier 不动')
    equal(
      authority.database.prepare(`SELECT count(*) FROM memory_tree_diffs`).pluck().get(),
      diffCountBeforeRecovery,
      '孤儿回收 diff 不动'
    )

    const retry = dream.startNextBatch({
      trigger: 'retry',
      batchSize: 1,
      modelProfile: { provider: 'local', model: 'probe' },
      startedAt: 74,
    })
    check(retry?.kind === 'started', '失败同指纹应可重试')
    if (!retry || retry.kind !== 'started') throw new Error('unreachable')
    equal(retry.runId, batch3.runId, '重试复用同一 fingerprint run 账本')
    equal(retry.inputFingerprint, batch3.inputFingerprint, '重试指纹稳定')
    dream.markValidating(retry.runId, { candidates: [] }, emptyStats)
    dream.commitNoop(retry.runId, emptyStats, 75)
    equal(readMetaV2(authority, 'dream_frontier'), 5, '重试成功推进 frontier')

    const orphan = contentKeys.sealContent('authority 前崩溃残留')
    check(blobs.hasBlob(orphan.blobId), '探针孤儿 blob 应存在')
    equal(ingest.recoverOrphanedBlobs(), 1, '应清理未登记物理 blob')
    check(!blobs.hasBlob(orphan.blobId), '孤儿密文已清除')
    expectAppError(
      'MEMORY_DEK_DESTROYED',
      () => contentKeys.openContent(orphan.blobId, orphan.commitment),
      '孤儿 DEK 必须一并销毁'
    )

    expectAppError(
      'VALIDATION',
      () =>
        ingest.ingest({
          sourceType: 'chat',
          trustLevel: 'system_observed',
          scope: { type: 'workspace', rootPath: join(probeRoot, 'missing') },
          occurredAt: 80,
          payload: '不得落盘',
          privacyClass: 'standard',
        }),
      '不存在路径必须在密钥派生前拒绝'
    )
    equal(readMetaV2(authority, 'evidence_ingest_sequence'), 5, '拒绝采集不消耗序号')
    authority.close()
  } finally {
    rmSync(probeRoot, { recursive: true, force: true })
  }
}

function seedIdentityEpochV2(
  authority: ReturnType<typeof openMemoryAuthorityV2>['store']
): void {
  authority.database
    .prepare(
      `INSERT INTO memory_identity_epochs(
         id, sequence, confidence, predecessor_id,
         started_at, created_by_run_id, created_at
       ) VALUES ('epoch-1', 1, 0.9, NULL, 1, 'seed', 1)`
    )
    .run()
}

function createRootNodeV2(): MemoryTreeNodeStructV2 {
  return {
    stableKey: 'root',
    parentKey: null,
    nodeType: 'root',
    namespace: 'root',
    subjectType: 'root',
    subjectId: 'root',
    content: {
      blobRef: null,
      commitment: `c2:${'0'.repeat(64)}`,
      redacted: false,
    },
    mainlineScore: 1,
    confidence: 1,
    activation: 1,
    firstSeenAt: 1,
    lastActiveAt: 1,
    visibilityState: 'active',
  }
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

function readRunStateV2(
  authority: ReturnType<typeof openMemoryAuthorityV2>['store'],
  runId: string
): string {
  return authority.database
    .prepare(`SELECT state FROM memory_dream_runs WHERE id = ?`)
    .pluck()
    .get(runId) as string
}

runIngestDreamProbeV2()
check(
  assertionCount >= ExpectedMinimumAssertionsV2,
  `ingest/dream v2 断言计数不足：${assertionCount}/${ExpectedMinimumAssertionsV2}`
)
process.stdout.write(`Memory ingest/dream v2 probe: ${assertionCount} assertions passed.\n`)
