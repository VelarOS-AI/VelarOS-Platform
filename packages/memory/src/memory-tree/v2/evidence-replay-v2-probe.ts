import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'

import { MemoryTreeSchemaSql } from '../schema/MemoryTreeSchema'

import { MemoryBlobStoreV2 } from './storage/BlobStore'
import { ContentKeyServiceV2 } from './storage/ContentKeyService'
import { MemoryKeyringStoreV2 } from './storage/Keyring'
import type { MemoryWrappingRootV2 } from './storage/WrappingRoot'
import { openMemoryAuthorityV2 } from './AuthorityDatabase'
import { MemoryDreamRunCoordinatorV2 } from './DreamRuns'
import { MemoryEvidenceIngestServiceV2 } from './EvidenceIngest'
import {
  evaluateMemoryAuthorityCutoverV2,
  LegacyMemoryEvidenceSqliteReaderV2,
  MemoryEvidenceReplayMigrationV2,
} from './EvidenceReplayMigration'
import { MemoryIdentityKeyServiceV2 } from './IdentityKeys'
import { MemoryMeaningCurationServiceV2 } from './MeaningCuration'
import { MemoryTreeStoreV2 } from './TreeStore'

const ExpectedMinimumAssertionsV2 = 58
let assertionCount = 0

function check(ok: unknown, message: string): asserts ok {
  assert.ok(ok, message)
  assertionCount += 1
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert.equal(actual, expected, message)
  assertionCount += 1
}

function deepEqual<T>(actual: T, expected: T, message: string): void {
  assert.deepEqual(actual, expected, message)
  assertionCount += 1
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

function runEvidenceReplayProbeV2(): void {
  const probeRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-evidence-replay-v2-'))
  const legacyPath = join(probeRoot, 'legacy-authority.sqlite3')
  try {
    seedLegacyDatabaseV2(legacyPath, join(probeRoot, 'missing-workspace'))
    const legacyHashBefore = fileSha256V2(legacyPath)
    const sourceDatabaseId = `sha256:${legacyHashBefore}`
    const reader = LegacyMemoryEvidenceSqliteReaderV2.open(legacyPath, sourceDatabaseId)

    const authority = openMemoryAuthorityV2(join(probeRoot, 'v2')).store
    const keyring = MemoryKeyringStoreV2.open(
      authority.roots.keyringDir,
      createProbeWrappingRootV2()
    ).store
    const blobs = new MemoryBlobStoreV2(authority.roots.blobsDir)
    const contentKeys = new ContentKeyServiceV2(keyring, blobs)
    const identityKeys = new MemoryIdentityKeyServiceV2(keyring)
    const ingest = new MemoryEvidenceIngestServiceV2(authority, contentKeys, identityKeys, blobs)
    const tree = MemoryTreeStoreV2.open({
      authority,
      contentKeys,
      keyring,
    }).store
    const dream = new MemoryDreamRunCoordinatorV2(authority, contentKeys, tree)
    const curation = new MemoryMeaningCurationServiceV2(
      authority,
      contentKeys,
      identityKeys,
      tree,
      dream
    )
    const migration = new MemoryEvidenceReplayMigrationV2(
      authority,
      ingest,
      contentKeys,
      identityKeys
    )

    const first = migration.replay(reader, 100)
    equal(first.sourceEvidenceCount, 4, '应读取四条旧 Evidence')
    equal(first.replayedCount, 3, '三条未擦除 Evidence 应重灌正文')
    equal(first.tombstoneCount, 1, '旧 erased Evidence 只能重灌墓碑')
    equal(first.alreadyReplayedCount, 0, '首轮不得误报已重灌')
    equal(first.governanceAppliedCount, 6, 'eligibility 与三条旧治理 deny 已应用')
    equal(first.governancePendingCount, 0, '可归一化治理不得伪装成待处理')
    equal(first.knownLossCount, 5, '五条归一化损耗必须显式记账')

    const parity = migration.verify(reader)
    equal(parity.ledgerCount, 4, '重灌账本必须逐条覆盖')
    equal(parity.payloadMatchedCount, 4, '三条正文与一条墓碑逐条匹配')
    equal(parity.payloadMismatchCount, 0, '不得有正文差异')
    equal(parity.missingMappingCount, 0, '不得缺映射')
    equal(parity.orderMismatchCount, 0, '旧 ingest 顺序必须保序')
    equal(parity.eligibilityMismatchCount, 0, 'eligibility 必须等价')
    equal(parity.governanceAppliedCount, 6, 'parity 应包含 eligibility 与治理 deny')
    equal(parity.governancePendingCount, 0, 'parity 不得虚报待处理治理')
    equal(parity.knownLossCount, 5, 'parity 应暴露全部已知损耗')
    equal(parity.mappingDigest.length, 64, '映射摘要应为 SHA-256')
    equal(parity.governanceDigest.length, 64, '治理摘要应为 SHA-256')
    equal(parity.verificationDigest.length, 64, '报告摘要应为 SHA-256')

    deepEqual(
      authority.database
        .prepare(
          `SELECT legacy_ingest_sequence
           FROM memory_evidence_replay_ledger
           ORDER BY legacy_ingest_sequence`
        )
        .pluck()
        .all(),
      [10, 20, 30, 40],
      '账本保留旧序号'
    )
    deepEqual(
      authority.database
        .prepare(`SELECT ingest_sequence FROM memory_evidence ORDER BY ingest_sequence`)
        .pluck()
        .all(),
      [1, 2, 3, 4],
      'v2 序号按旧顺序连续分配'
    )
    const tombstone = authority.database
      .prepare(
        `SELECT payload_blob_ref, payload_commitment, eligibility_state
         FROM memory_evidence evidence
         JOIN memory_evidence_replay_ledger replay ON replay.evidence_id = evidence.id
         WHERE replay.legacy_evidence_id = 'e-erased'`
      )
      .get() as {
      payload_blob_ref: Nullable<string>
      payload_commitment: Nullable<string>
      eligibility_state: string
    }
    equal(tombstone.payload_blob_ref, null, '擦除项不得复制旧正文')
    equal(tombstone.payload_commitment, null, '擦除项不得生成正文承诺')
    equal(tombstone.eligibility_state, 'erased', '擦除项保持墓碑态')
    equal(
      authority.database
        .prepare(`SELECT integer_value FROM memory_meta WHERE key = 'privacy_generation'`)
        .pluck()
        .get(),
      1,
      '旧治理 deny 必须单调推进 privacy generation'
    )
    const normalizedDenyTargets = authority.database
      .prepare(
        `SELECT target_match_key FROM memory_replay_governance
         WHERE governance_type IN ('forgotten', 'superseded', 'erased')
           AND disposition = 'applied'
           AND deny_generation = 1`
      )
      .pluck()
      .all() as string[]
    equal(normalizedDenyTargets.length, 3, '三条旧治理必须转为 normalized deny target')
    check(
      normalizedDenyTargets.every((target) => /^d2:[0-9a-f]{32}$/.test(target)),
      '治理 target 必须是 keyed token'
    )

    const degradedMetadata = readReplayMetadataV2(authority, contentKeys, 'e-degraded')
    equal(
      degradedMetadata['legacyWorkspaceRoot'],
      join(probeRoot, 'missing-workspace'),
      '旧路径仅进入密文 metadata'
    )
    equal(degradedMetadata['metadataParseState'], 'invalid_json', '坏 metadata 不阻断正文')
    equal(
      authority.database
        .prepare(
          `SELECT scope_type FROM memory_evidence evidence
           JOIN memory_evidence_replay_ledger replay ON replay.evidence_id = evidence.id
           WHERE replay.legacy_evidence_id = 'e-degraded'`
        )
        .pluck()
        .get(),
      'global',
      '不可解析 workspace 必须 fail-closed 到 global'
    )

    const second = migration.replay(reader, 200)
    equal(second.replayedCount, 0, '重跑不得重复写 Evidence')
    equal(second.tombstoneCount, 0, '重跑不得重复写墓碑')
    equal(second.alreadyReplayedCount, 4, '重跑应命中全部账本')
    equal(second.governanceAppliedCount, 6, '重跑应修复并保持治理边车')
    equal(second.governancePendingCount, 0, '治理 deny 重跑幂等')
    equal(second.knownLossCount, 5, '已知损耗幂等')
    equal(
      migration.verify(reader).verificationDigest,
      parity.verificationDigest,
      '相同权威状态必须产生相同 parity 摘要'
    )
    const activeEvidenceId = authority.database
      .prepare(
        `SELECT evidence_id FROM memory_evidence_replay_ledger
         WHERE legacy_evidence_id = 'e-active'`
      )
      .pluck()
      .get() as string
    const batch = dream.startNextBatch({
      trigger: 'manual',
      batchSize: 4,
      modelProfile: { provider: 'local', model: 'probe' },
      startedAt: 210,
    })
    check(batch?.kind === 'started', '重灌后应能建立首个 Dream 批次')
    if (!batch || batch.kind !== 'started') throw new Error('unreachable')
    const governed = curation.curateAndCommit({
      runId: batch.runId,
      tokenUsage: 1,
      committedAt: 211,
      proposal: {
        candidates: [
          {
            kind: 'concept',
            candidateKey: 'legacy-concept-candidate',
            conceptType: 'project',
            name: '旧概念',
            scope: { type: 'global' },
            privacyClass: 'standard',
            lifecycleState: 'active',
            firstSeenAt: 1,
            lastActiveAt: 1,
            salience: 0.5,
            activation: 0.5,
            evidenceIds: [activeEvidenceId],
          },
          {
            kind: 'claim',
            candidateKey: 'legacy-governed-claim',
            subjectConceptKey: 'legacy-concept-candidate',
            predicate: 'state',
            title: '模型换了标题也必须命中治理',
            value: {},
            storageMode: 'full',
            epistemicStatus: 'inferred',
            confidence: 0.5,
            privacyClass: 'standard',
            lifecycleState: 'active',
            validFrom: 1,
            salience: 0.5,
            consolidationStrength: 0.5,
            activation: 0.5,
            evidenceIds: [activeEvidenceId],
          },
        ],
        identity: {
          statement: '我是持续帮助用户的 AI 助手',
          globalMainline: '继续帮助用户推进项目',
          confidence: 0.5,
          evidenceIds: [activeEvidenceId],
          supportingConceptKeys: ['legacy-concept-candidate'],
          supportingEpisodeKeys: [],
          supportingClaimKeys: [],
        },
      },
    })
    equal(governed.rejectedCount, 1, '旧治理目标不得在 v2 意义层复活')
    check(
      governed.decisions.some(
        (decision) =>
          decision.candidateKey === 'legacy-governed-claim' &&
          decision.decision === 'rejected' &&
          decision.reasons.some((reason) => reason.startsWith('legacy_governance_denied:'))
      ),
      '候选账本必须给出跨库治理 deny 原因'
    )
    equal(
      authority.database.prepare(`SELECT count(*) FROM memory_claims`).pluck().get(),
      0,
      '命中旧治理的 Claim 不得落 authority'
    )

    const locked = evaluateMemoryAuthorityCutoverV2({ report: parity })
    equal(locked.ready, false, '没有真机回执与签字不得切权')
    deepEqual(
      locked.missing,
      ['true_device_verification', 'user_signoff'],
      '切权闸门必须同时指出两项外部条件'
    )
    const mismatched = evaluateMemoryAuthorityCutoverV2({
      report: parity,
      trueDeviceReceipt: {
        verificationDigest: '0'.repeat(64),
        verifiedAt: 300,
        receiptId: 'device-receipt',
      },
      userSignoff: {
        verificationDigest: parity.verificationDigest,
        confirmedAt: 301,
        signoffId: 'user-signoff',
      },
    })
    equal(mismatched.ready, false, '摘要不一致不得切权')
    deepEqual(mismatched.missing, ['digest_mismatch'], '摘要不一致必须单独暴露')
    const unlocked = evaluateMemoryAuthorityCutoverV2({
      report: parity,
      trueDeviceReceipt: {
        verificationDigest: parity.verificationDigest,
        verifiedAt: 300,
        receiptId: 'device-receipt',
      },
      userSignoff: {
        verificationDigest: parity.verificationDigest,
        confirmedAt: 301,
        signoffId: 'user-signoff',
      },
    })
    equal(unlocked.ready, true, '仅匹配的真机回执与用户签字可通过判定')
    deepEqual(unlocked.missing, [], '通过后不得遗留缺口')
    const invalidSignoff = evaluateMemoryAuthorityCutoverV2({
      report: parity,
      trueDeviceReceipt: {
        verificationDigest: parity.verificationDigest,
        verifiedAt: 300,
        receiptId: 'device-receipt',
      },
      userSignoff: {
        verificationDigest: parity.verificationDigest,
        confirmedAt: 301,
        signoffId: '',
      },
    })
    equal(invalidSignoff.ready, false, '空签字身份不得冒充用户明示确认')
    deepEqual(invalidSignoff.missing, ['user_signoff'], '无效签字按缺失处理')
    const tamperedReport = evaluateMemoryAuthorityCutoverV2({
      report: { ...parity, sourceEvidenceCount: 3 },
      trueDeviceReceipt: {
        verificationDigest: parity.verificationDigest,
        verifiedAt: 300,
        receiptId: 'device-receipt',
      },
      userSignoff: {
        verificationDigest: parity.verificationDigest,
        confirmedAt: 301,
        signoffId: 'user-signoff',
      },
    })
    equal(tamperedReport.ready, false, '报告字段被改写后不得沿用旧摘要')
    deepEqual(tamperedReport.missing, ['parity'], '自校验失败必须归入 parity')

    equal(fileSha256V2(legacyPath), legacyHashBefore, '旧权威库必须逐字节保持只读')
    equal(readLegacyScalarV2(legacyPath, `SELECT count(*) FROM memory_evidence`), 4, '旧表不得删除')
    equal(
      readLegacyScalarV2(legacyPath, `SELECT content FROM memory_evidence WHERE id = 'e-erased'`),
      '旧 erased 正文只留在只读旧库，不得被迁移器改写',
      '旧库历史字节不得被清理器提前修改'
    )
    for (const plaintext of [
      '用户明确说明偏好深色界面',
      '浏览器观察到文档入口',
      '损坏元数据仍需保住正文',
      '旧 erased 正文只留在只读旧库，不得被迁移器改写',
    ]) {
      check(
        !directoryContainsV2(authority.roots.memoryRoot, Buffer.from(plaintext, 'utf8')),
        `v2 五物理根不得出现明文：${plaintext}`
      )
    }

    reader.close()
    authority.close()
  } finally {
    rmSync(probeRoot, { recursive: true, force: true })
  }
}

function seedLegacyDatabaseV2(databasePath: string, missingWorkspace: string): void {
  const database = new BetterSqlite3(databasePath)
  database.pragma('journal_mode = DELETE')
  database.pragma('foreign_keys = ON')
  database.exec(MemoryTreeSchemaSql)
  const insertEvidence = database.prepare(
    `INSERT INTO memory_evidence(
       id, source_type, trust_level, source_id, session_id, execution_id,
       workspace_root, scope_type, scope_id, occurred_at, title, content,
       category, privacy_class, eligibility_state, metadata_json,
       ingest_sequence, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  insertEvidence.run(
    'e-active',
    'chat',
    'user_stated',
    'source-active',
    'session-1',
    '',
    '',
    'global',
    '',
    10,
    '偏好',
    '用户明确说明偏好深色界面',
    'preference',
    'personal',
    'active',
    '{"source":"chat"}',
    10,
    11
  )
  insertEvidence.run(
    'e-excluded',
    'browser',
    'system_observed',
    'source-excluded',
    '',
    'execution-1',
    '',
    'site',
    'https://Example.com:443/docs?q=1',
    20,
    '入口',
    '浏览器观察到文档入口',
    'reference',
    'standard',
    'excluded',
    '{"source":"browser"}',
    20,
    21
  )
  insertEvidence.run(
    'e-degraded',
    '',
    'unknown_trust',
    'source-degraded',
    '',
    '',
    missingWorkspace,
    'workspace',
    missingWorkspace,
    30,
    '坏元数据',
    '损坏元数据仍需保住正文',
    'note',
    'unknown_privacy',
    'source_deleted',
    '{broken',
    30,
    31
  )
  insertEvidence.run(
    'e-erased',
    'chat',
    'user_stated',
    'source-erased',
    '',
    '',
    '',
    'global',
    '',
    40,
    '已擦除',
    '旧 erased 正文只留在只读旧库，不得被迁移器改写',
    'private',
    'sensitive',
    'erased',
    '{}',
    40,
    41
  )
  database
    .prepare(
      `INSERT INTO memory_concepts(
         id, stable_key, concept_type, canonical_name, scope_type, scope_id,
         privacy_class, first_seen_at, last_active_at, created_at, updated_at
       ) VALUES ('legacy-concept', 'legacy-concept', 'project', '旧概念',
                 'global', '', 'standard', 1, 1, 1, 1)`
    )
    .run()
  const insertClaim = database.prepare(
    `INSERT INTO memory_claims(
       id, stable_key, subject_concept_id, predicate, value_json, summary,
       epistemic_status, confidence, privacy_class, lifecycle_state,
       lifecycle_reason, valid_from, created_by_run_id, last_reinforced_at,
       created_at, updated_at
     ) VALUES (?, ?, 'legacy-concept', 'state', '{}', ?, 'inferred', 0.5,
               'standard', 'dormant', ?, 1, 'legacy-run', 1, 1, 1)`
  )
  insertClaim.run('claim-forgotten', 'claim-forgotten', '已忘记', 'forgotten')
  insertClaim.run('claim-superseded', 'claim-superseded', '已替代', 'superseded')
  insertClaim.run('claim-erased', 'claim-erased', '已擦除', 'erased')
  const insertLink = database.prepare(
    `INSERT INTO memory_claim_evidence(
       claim_id, evidence_id, relation, weight, created_at
     ) VALUES (?, ?, 'support', 1, 1)`
  )
  insertLink.run('claim-forgotten', 'e-active')
  insertLink.run('claim-superseded', 'e-excluded')
  insertLink.run('claim-erased', 'e-degraded')
  database.close()
}

function readReplayMetadataV2(
  authority: ReturnType<typeof openMemoryAuthorityV2>['store'],
  contentKeys: ContentKeyServiceV2,
  legacyEvidenceId: string
): Record<string, unknown> {
  const row = authority.database
    .prepare(
      `SELECT evidence.metadata_blob_ref, evidence.metadata_commitment
       FROM memory_evidence evidence
       JOIN memory_evidence_replay_ledger replay ON replay.evidence_id = evidence.id
       WHERE replay.legacy_evidence_id = ?`
    )
    .get(legacyEvidenceId) as {
    metadata_blob_ref: string
    metadata_commitment: string
  }
  const plaintext = contentKeys.openContent(row.metadata_blob_ref, row.metadata_commitment)
  try {
    return JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>
  } finally {
    plaintext.fill(0)
  }
}

function readLegacyScalarV2(databasePath: string, sql: string): unknown {
  const database = new BetterSqlite3(databasePath, {
    readonly: true,
    fileMustExist: true,
  })
  database.pragma('query_only = ON')
  try {
    return database.prepare(sql).pluck().get()
  } finally {
    database.close()
  }
}

function fileSha256V2(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function directoryContainsV2(path: string, needle: Buffer): boolean {
  for (const entry of readdirSync(path)) {
    const child = join(path, entry)
    const stats = statSync(child)
    if (stats.isDirectory()) {
      if (directoryContainsV2(child, needle)) return true
    } else if (readFileSync(child).includes(needle)) return true
  }
  return false
}

runEvidenceReplayProbeV2()
check(
  assertionCount >= ExpectedMinimumAssertionsV2,
  `evidence replay v2 断言计数不足：${assertionCount}/${ExpectedMinimumAssertionsV2}`
)
process.stdout.write(`Memory evidence replay v2 probe: ${assertionCount} assertions passed.\n`)
