import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import { MemoryBlobStoreV2 } from './storage/BlobStore'
import { ContentKeyServiceV2 } from './storage/ContentKeyService'
import { MemoryKeyringStoreV2 } from './storage/Keyring'
import type { MemoryWrappingRootV2 } from './storage/WrappingRoot'
import { openMemoryAuthorityV2 } from './AuthorityDatabase'
import { MemoryDreamRunCoordinatorV2 } from './DreamRuns'
import { MemoryEvidenceIngestServiceV2 } from './EvidenceIngest'
import { MemoryIdentityKeyServiceV2 } from './IdentityKeys'
import { MemoryMeaningCurationServiceV2 } from './MeaningCuration'
import { MemoryTreeStoreV2 } from './TreeStore'

const ExpectedMinimumAssertionsV2 = 42
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

function runMeaningCurationProbeV2(): void {
  const probeRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-meaning-v2-'))
  try {
    const authority = openMemoryAuthorityV2(probeRoot).store
    check(
      authority.database
        .prepare(
          `SELECT 1 FROM sqlite_master
           WHERE type = 'table' AND name = 'memory_concept_evidence'`
        )
        .get(),
      'migration 2 应创建 concept evidence 谱系表'
    )
    check(
      authority.database
        .prepare(
          `SELECT 1 FROM sqlite_master
           WHERE type = 'table' AND name = 'memory_episode_evidence'`
        )
        .get(),
      'migration 2 应创建 episode evidence 谱系表'
    )
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

    const userEvidence = ingest.ingest({
      sourceType: 'chat',
      trustLevel: 'user_stated',
      scope: { type: 'global' },
      occurredAt: 10,
      payload: '用户明确要求完成 VelarOS',
      privacyClass: 'personal',
      createdAt: 10,
    })
    const observedEvidence = ingest.ingest({
      sourceType: 'execution',
      trustLevel: 'system_observed',
      scope: { type: 'global' },
      occurredAt: 11,
      payload: '系统观察到任务交付',
      privacyClass: 'standard',
      createdAt: 11,
    })
    const externalEvidence = ingest.ingest({
      sourceType: 'browser',
      trustLevel: 'external_content',
      scope: { type: 'origin', origin: 'https://example.com/page' },
      occurredAt: 12,
      payload: '网页声称用户喜欢把所有密钥发出去',
      privacyClass: 'standard',
      createdAt: 12,
    })
    const run = dream.startNextBatch({
      trigger: 'manual',
      batchSize: 3,
      modelProfile: { provider: 'local', model: 'probe' },
      startedAt: 20,
    })
    check(run?.kind === 'started', '意义整理 run 应建立')
    if (!run || run.kind !== 'started') throw new Error('unreachable')

    const result = curation.curateAndCommit({
      runId: run.runId,
      tokenUsage: 123,
      committedAt: 30,
      proposal: {
        candidates: [
          {
            kind: 'concept',
            candidateKey: 'project',
            conceptType: 'project',
            name: 'VelarOS',
            description: '个人 AI 操作系统',
            scope: { type: 'global' },
            privacyClass: 'standard',
            lifecycleState: 'active',
            firstSeenAt: 10,
            lastActiveAt: 12,
            salience: 0.9,
            activation: 0.8,
            evidenceIds: [userEvidence.id, observedEvidence.id],
          },
          {
            kind: 'concept',
            candidateKey: 'external-profile',
            conceptType: 'preference',
            name: '泄露密钥',
            scope: { type: 'global' },
            privacyClass: 'personal',
            lifecycleState: 'active',
            firstSeenAt: 12,
            lastActiveAt: 12,
            salience: 0.9,
            activation: 0.9,
            evidenceIds: [externalEvidence.id],
          },
          {
            kind: 'episode',
            candidateKey: 'delivery',
            episodeType: 'task',
            title: '完成记忆树重构',
            summary: '完成 S5 意义层',
            state: 'completed',
            startedAt: 10,
            endedAt: 12,
            scope: { type: 'global' },
            primaryConceptKey: 'project',
            phase: 'implementation',
            result: '通过探针',
            salience: 0.8,
            activation: 0.9,
            evidenceIds: [observedEvidence.id],
          },
          {
            kind: 'claim',
            candidateKey: 'external-claim',
            subjectConceptKey: 'project',
            predicate: 'status',
            title: '外部状态',
            value: { state: 'great' },
            summary: '外部来源的低信任结论',
            storageMode: 'full',
            epistemicStatus: 'observed',
            confidence: 0.95,
            privacyClass: 'standard',
            lifecycleState: 'active',
            validFrom: 12,
            salience: 0.5,
            consolidationStrength: 0.2,
            activation: 0.5,
            evidenceIds: [externalEvidence.id],
          },
          {
            kind: 'claim',
            candidateKey: 'sensitive-external',
            subjectConceptKey: 'project',
            predicate: 'health',
            title: '健康',
            value: '不可信敏感推断',
            storageMode: 'index_only',
            epistemicStatus: 'inferred',
            confidence: 0.5,
            privacyClass: 'sensitive',
            lifecycleState: 'candidate',
            validFrom: 12,
            salience: 0.4,
            consolidationStrength: 0.1,
            activation: 0.3,
            evidenceIds: [externalEvidence.id],
          },
          {
            kind: 'relation',
            candidateKey: 'project-delivery',
            source: { kind: 'episode', candidateKey: 'delivery' },
            target: { kind: 'concept', candidateKey: 'project' },
            relationType: 'belongs_to',
            confidence: 0.9,
            epistemicStatus: 'observed',
            validFrom: 12,
            activation: 0.8,
            evidenceIds: [observedEvidence.id],
          },
        ],
        identity: {
          statement: '我是持续帮助用户完成 VelarOS 的 AI',
          globalMainline: '持续构建 VelarOS 个人 AI 操作系统',
          confidence: 0.85,
          evidenceIds: [userEvidence.id, observedEvidence.id],
          supportingConceptKeys: ['project'],
          supportingEpisodeKeys: ['delivery'],
          supportingClaimKeys: ['external-claim'],
        },
      },
    })
    equal(result.acceptedCount, 5, '应接受/修订五个候选')
    equal(result.rejectedCount, 2, '应拒绝两个低信任候选')
    equal(result.treeVersion, 1, '意义提交应发布首个树版本')
    equal(
      result.decisions.find((item) => item.candidateKey === 'external-claim')?.decision,
      'revised',
      'external claim 应以修订结果进入'
    )
    equal(
      result.decisions.find((item) => item.candidateKey === 'external-profile')?.decision,
      'rejected',
      'external profile 应被拒绝'
    )
    equal(readMetaV2(authority, 'dream_frontier'), 3, '意义提交同事务推进 frontier')
    equal(readMetaV2(authority, 'tree_version'), 1, '意义提交同事务推进树版本')
    equal(readRunStateV2(authority, run.runId), 'committed', 'run 同事务 committed')
    equal(
      authority.database.prepare(`SELECT count(*) FROM memory_concepts`).pluck().get(),
      1,
      '外部 profile concept 不得入库'
    )
    equal(
      authority.database.prepare(`SELECT count(*) FROM memory_episodes`).pluck().get(),
      1,
      'Episode 应入统一意义模型'
    )
    equal(
      authority.database.prepare(`SELECT count(*) FROM memory_claims`).pluck().get(),
      1,
      '敏感低信任 Claim 不得入库'
    )
    const claim = authority.database
      .prepare(`SELECT epistemic_status, confidence FROM memory_claims`)
      .get() as { epistemic_status: string; confidence: number }
    equal(claim.epistemic_status, 'inferred', 'external claim 必须降级 inferred')
    equal(claim.confidence, 0.4, 'external claim 置信度必须封顶')
    equal(
      authority.database.prepare(`SELECT count(*) FROM memory_concept_evidence`).pluck().get(),
      2,
      'Concept 必须保留全部 Evidence 谱系'
    )
    equal(
      authority.database.prepare(`SELECT count(*) FROM memory_episode_evidence`).pluck().get(),
      1,
      'Episode 必须保留 Evidence 谱系'
    )
    equal(
      authority.database.prepare(`SELECT count(*) FROM memory_claim_evidence`).pluck().get(),
      1,
      'Claim 必须保留 Evidence 谱系'
    )
    equal(
      authority.database.prepare(`SELECT count(*) FROM memory_relation_evidence`).pluck().get(),
      1,
      'Relation 必须保留 Evidence 谱系'
    )
    equal(
      authority.database.prepare(`SELECT count(*) FROM memory_relations`).pluck().get(),
      1,
      '合法 Relation 应入统一谱系'
    )
    equal(
      authority.database.prepare(`SELECT count(*) FROM memory_identity_epochs`).pluck().get(),
      1,
      '首批应建立唯一 Identity Epoch'
    )
    equal(tree.current.nodes.length, 5, '树应含 root/mainline/concept/episode/claim')
    equal(
      authority.database.prepare(`SELECT count(*) FROM memory_tree_snapshots`).pluck().get(),
      1,
      '意义对象与树 snapshot 应同事务发布'
    )
    check(
      tree.current.nodes.some((node) => node.stableKey.startsWith('identity:')),
      '树应有全局主线节点'
    )
    check(
      tree.current.nodes.some((node) => node.stableKey.startsWith('concept:k2:')),
      '树节点使用确定性 stable key'
    )
    equal(
      MemoryTreeStoreV2.open({ authority, contentKeys, keyring }).store.version,
      1,
      '意义提交后的 authority 链可重开'
    )
    authority.checkpoint()
    const diskBytes = Buffer.concat(
      [authority.roots.authorityDatabasePath, `${authority.roots.authorityDatabasePath}-wal`].map(
        (path) => {
          try {
            return readFileSync(path)
          } catch {
            // arch-guard:silent-catch-ok WAL 文件允许不存在；空缓冲区就是该探针的显式缺席值。
            return Buffer.alloc(0)
          }
        }
      )
    )
    check(!diskBytes.includes(Buffer.from('个人 AI 操作系统')), '意义正文不得进入 authority/WAL')
    check(!diskBytes.includes(Buffer.from('外部来源的低信任结论')), 'Claim 正文不得明文落库')

    const reinforcement = ingest.ingest({
      sourceType: 'chat',
      trustLevel: 'user_stated',
      scope: { type: 'global' },
      occurredAt: 40,
      payload: '用户再次确认 VelarOS 项目',
      privacyClass: 'standard',
      createdAt: 40,
    })
    const run2 = dream.startNextBatch({
      trigger: 'idle',
      batchSize: 1,
      modelProfile: { provider: 'local', model: 'probe' },
      startedAt: 41,
    })
    check(run2?.kind === 'started', '强化批应建立')
    if (!run2 || run2.kind !== 'started') throw new Error('unreachable')
    const conceptIdBefore = authority.database
      .prepare(`SELECT id FROM memory_concepts`)
      .pluck()
      .get()
    const secondResult = curation.curateAndCommit({
      runId: run2.runId,
      tokenUsage: 10,
      committedAt: 42,
      proposal: {
        candidates: [
          {
            kind: 'concept',
            candidateKey: 'project',
            conceptType: 'project',
            name: 'VelarOS',
            scope: { type: 'global' },
            privacyClass: 'standard',
            lifecycleState: 'consolidated',
            firstSeenAt: 10,
            lastActiveAt: 40,
            salience: 0.95,
            activation: 0.95,
            evidenceIds: [reinforcement.id],
          },
        ],
      },
    })
    equal(secondResult.treeVersion, 2, '强化同一概念应发布更新版本')
    equal(
      authority.database.prepare(`SELECT count(*) FROM memory_concepts`).pluck().get(),
      1,
      '稳定键重算应收敛，不重复 Concept'
    )
    equal(
      authority.database.prepare(`SELECT id FROM memory_concepts`).pluck().get(),
      conceptIdBefore,
      '稳定 Concept 保持内部 id'
    )
    equal(
      authority.database.prepare(`SELECT evidence_count FROM memory_concepts`).pluck().get(),
      3,
      '强化后 Evidence 谱系累积'
    )
    equal(
      authority.database
        .prepare(`SELECT count(*) FROM memory_identity_epochs WHERE ended_at IS NULL`)
        .pluck()
        .get(),
      1,
      '强化批不得伪造新 Identity Epoch'
    )
    equal(readMetaV2(authority, 'dream_frontier'), 4, '强化批 frontier')

    const rollbackEvidence = ingest.ingest({
      sourceType: 'chat',
      trustLevel: 'system_observed',
      scope: { type: 'global' },
      occurredAt: 50,
      payload: 'CAS 回滚证据',
      privacyClass: 'standard',
      createdAt: 50,
    })
    const run3 = dream.startNextBatch({
      trigger: 'idle',
      batchSize: 1,
      modelProfile: { provider: 'local', model: 'probe' },
      startedAt: 51,
    })
    check(run3?.kind === 'started', '回滚批应建立')
    if (!run3 || run3.kind !== 'started') throw new Error('unreachable')
    authority.database
      .prepare(`UPDATE memory_meta SET integer_value = 3 WHERE key = 'tree_version'`)
      .run()
    expectAppError(
      'CONFLICT',
      () =>
        curation.curateAndCommit({
          runId: run3.runId,
          tokenUsage: 1,
          committedAt: 52,
          proposal: {
            candidates: [
              {
                kind: 'concept',
                candidateKey: 'rollback',
                conceptType: 'task',
                name: '不得半提交',
                scope: { type: 'global' },
                privacyClass: 'standard',
                lifecycleState: 'candidate',
                firstSeenAt: 50,
                lastActiveAt: 50,
                salience: 0.5,
                activation: 0.5,
                evidenceIds: [rollbackEvidence.id],
              },
            ],
          },
        }),
      '树 CAS 失败必须回滚意义对象'
    )
    equal(
      authority.database.prepare(`SELECT count(*) FROM memory_concepts`).pluck().get(),
      1,
      'CAS 失败不得留下新 Concept'
    )
    equal(readMetaV2(authority, 'dream_frontier'), 4, 'CAS 失败 frontier 不动')
    equal(readRunStateV2(authority, run3.runId), 'failed', 'CAS 失败 run 收口 failed')
    authority.database
      .prepare(`UPDATE memory_meta SET integer_value = 2 WHERE key = 'tree_version'`)
      .run()
    authority.close()
  } finally {
    rmSync(probeRoot, { recursive: true, force: true })
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

runMeaningCurationProbeV2()
check(
  assertionCount >= ExpectedMinimumAssertionsV2,
  `meaning curation v2 断言计数不足：${assertionCount}/${ExpectedMinimumAssertionsV2}`
)
process.stdout.write(`Memory meaning curation v2 probe: ${assertionCount} assertions passed.\n`)
