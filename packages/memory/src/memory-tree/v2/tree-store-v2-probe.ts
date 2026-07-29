import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import { MemoryBlobStoreV2 } from './storage/BlobStore'
import { ContentKeyServiceV2 } from './storage/ContentKeyService'
import { readCurrentGenerationV2 } from './storage/GenerationPointer'
import { MemoryKeyringStoreV2 } from './storage/Keyring'
import type { MemoryWrappingRootV2 } from './storage/WrappingRoot'
import { openMemoryAuthorityV2 } from './AuthorityDatabase'
import {
  buildBasicTreeDiffOpsV2,
  type MemoryTreeDiffV2,
  type MemoryTreeNodeStructV2,
  replayTreeDiffsBackwardV2,
} from './DiffChain'
import { buildMemoryTreeBaseStateV2, computeMemoryTreeBaseHashesV2 } from './TreeManifest'
import { MemoryTreeCheckpointIntervalV2, MemoryTreeProjectionIndexV2 } from './TreeProjectionIndex'
import { MemoryTreeStoreV2 } from './TreeStore'

const ExpectedMinimumAssertionsV2 = 73
let assertionCount = 0

function check(ok: unknown, message: string): asserts ok {
  assert.ok(ok, message)
  assertionCount += 1
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert.equal(actual, expected, message)
  assertionCount += 1
}

function expectThrows(run: () => unknown, message: string): unknown {
  let observed: unknown
  try {
    run()
  } catch (error) {
    observed = error
  }
  check(observed instanceof Error, `${message}: 应抛错误`)
  return observed
}

function expectAppErrorCode(code: string, run: () => unknown, message: string): void {
  const error = expectThrows(run, message)
  check(error instanceof AppError, `${message}: 应抛 AppError`)
  equal((error as AppError).code, code, message)
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

function runTreeStoreProbeV2(): void {
  const probeRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-tree-store-v2-'))
  try {
    runAuthorityChainProbeV2(join(probeRoot, 'chain'))
    runStaticBackwardWriteBoundaryProbeV2()
  } finally {
    rmSync(probeRoot, { recursive: true, force: true })
  }
}

function runAuthorityChainProbeV2(dataRoot: string): void {
  const authority = openMemoryAuthorityV2(dataRoot).store
  const wrappingRoot = createProbeWrappingRootV2()
  const keyring = MemoryKeyringStoreV2.open(authority.roots.keyringDir, wrappingRoot).store
  const contentKeys = new ContentKeyServiceV2(
    keyring,
    new MemoryBlobStoreV2(authority.roots.blobsDir)
  )
  seedIdentityEpochV2(authority.database, contentKeys)
  const leafContent = sealAndRegisterV2(
    authority.database,
    contentKeys,
    'S3 树叶正文只存在于加密 blob'
  )
  const root = createRootNodeV2()
  const leaf = createLeafNodeV2(leafContent.blobId, leafContent.commitment)
  const opened = MemoryTreeStoreV2.open({ authority, contentKeys, keyring })
  equal(opened.report.treeVersion, 0, '空 authority 的树版本应为 0')
  equal(opened.report.replayedDiffCount, 0, '空 authority 不重放 diff')
  equal(opened.report.projectionRebuilt, false, '空树不生成派生代')

  const first = opened.store.commitVersion({
    expectedBaseVersion: 0,
    ops: [
      { type: 'add', before: [], after: [root] },
      { type: 'add', before: [], after: [leaf] },
    ],
    identityChange: {
      epochId: 'epoch-1',
      sequence: 1,
      predecessorId: null,
    },
    activeIdentityEpochId: 'epoch-1',
    globalMainlineNodeId: 'root',
    frontierEvidenceSequence: 0,
    createdByRunId: 'run-genesis',
    createdAt: 100,
  })
  equal(first.version, 1, '创世提交版本')
  equal(first.projectionPersisted, true, '创世提交后应刷新加密投影')
  equal(opened.store.version, 1, '内存 head 应推进')
  equal(
    authority.database
      .prepare(`SELECT integer_value FROM memory_meta WHERE key = 'tree_version'`)
      .pluck()
      .get(),
    1,
    'tree_version meta 与提交同事务推进'
  )
  equal(
    authority.database.prepare(`SELECT count(*) FROM memory_tree_diffs`).pluck().get(),
    1,
    '创世 diff 应落 authority'
  )
  equal(
    authority.database.prepare(`SELECT count(*) FROM memory_tree_snapshots`).pluck().get(),
    1,
    '创世 snapshot 应落 authority'
  )

  leaf.lastActiveAt = 999
  equal(
    opened.store.current.nodes.find((node) => node.stableKey === leaf.stableKey)?.lastActiveAt,
    1,
    '提交后状态不得继续引用调用方可变节点'
  )
  expectAppErrorCode(
    'CONFLICT',
    () =>
      opened.store.commitVersion({
        expectedBaseVersion: 0,
        ops: [],
        identityChange: {
          epochId: 'epoch-1',
          sequence: 1,
          predecessorId: null,
        },
        activeIdentityEpochId: 'epoch-1',
        globalMainlineNodeId: 'root',
        frontierEvidenceSequence: 0,
        createdByRunId: 'run-stale',
      }),
    '陈旧基线必须在写入前被 CAS 拒绝'
  )
  equal(opened.store.version, 1, 'CAS 冲突不得推进内存版本')

  const projection = new MemoryTreeProjectionIndexV2(authority.roots.indexDir, keyring)
  const publicCopy = opened.store.current
  expectAppErrorCode(
    'INVARIANT',
    () => projection.persist(1, publicCopy, []),
    '来源不明的伪 forward 对象不得进入投影写路径'
  )

  let latestDiff: MemoryTreeDiffV2 | null = null
  while (opened.store.version < MemoryTreeCheckpointIntervalV2) {
    const before = opened.store.current.nodes
    const beforeLeaf = before.find((node) => node.stableKey === 'concept:k2:leaf')
    check(beforeLeaf !== undefined, '循环提交前 leaf 必须存在')
    const afterLeaf: MemoryTreeNodeStructV2 = {
      ...beforeLeaf,
      content: { ...beforeLeaf.content },
      lastActiveAt: opened.store.version + 1,
      activation: Number((0.5 + (opened.store.version % 10) / 100).toFixed(6)),
    }
    const after = before.map((node) => (node.stableKey === afterLeaf.stableKey ? afterLeaf : node))
    const ops = buildBasicTreeDiffOpsV2(before, after)
    latestDiff = {
      version: opened.store.version + 1,
      baseVersion: opened.store.version,
      ops,
    }
    const committed = opened.store.commitVersion({
      expectedBaseVersion: opened.store.version,
      ops,
      activeIdentityEpochId: 'epoch-1',
      globalMainlineNodeId: 'root',
      frontierEvidenceSequence: 0,
      createdByRunId: `run-${opened.store.version + 1}`,
      createdAt: 100 + opened.store.version,
    })
    check(committed.projectionPersisted, '正常提交应刷新派生投影')
  }
  equal(opened.store.version, MemoryTreeCheckpointIntervalV2, '应推进到首个 checkpoint 间隔')
  const inspection = opened.store.inspectProjection()
  check(inspection !== null, '投影代应存在')
  equal(inspection.checkpointCount, 1, 'v64 应产生一个 checkpoint')

  check(latestDiff !== null, '应记录最后一条 diff')
  const backward = replayTreeDiffsBackwardV2(opened.store.current.nodes, [latestDiff])
  equal(backward.direction, 'backward', '逆放结果必须带 backward 来源')
  expectAppErrorCode(
    'INVARIANT',
    () => projection.persist(opened.store.version - 1, backward, []),
    'INV-BR 必须阻止逆放结果写入派生投影'
  )

  const beforeInvalidCommit = opened.store.version
  const invalidBeforeLeaf = opened.store.current.nodes.find(
    (node) => node.stableKey === 'concept:k2:leaf'
  )
  check(invalidBeforeLeaf !== undefined, 'FK 回滚负控前 leaf 必须存在')
  expectThrows(
    () =>
      opened.store.commitVersion({
        expectedBaseVersion: beforeInvalidCommit,
        ops: [
          {
            type: 'update',
            before: [invalidBeforeLeaf],
            after: [
              {
                ...invalidBeforeLeaf,
                content: { ...invalidBeforeLeaf.content },
                lastActiveAt: invalidBeforeLeaf.lastActiveAt + 1,
              },
            ],
          },
        ],
        activeIdentityEpochId: 'missing-epoch',
        globalMainlineNodeId: 'root',
        frontierEvidenceSequence: 0,
        createdByRunId: 'run-fk-failure',
      }),
    'FK 失败必须回滚 snapshot/diff/meta 整个事务'
  )
  equal(
    authority.database
      .prepare(`SELECT integer_value FROM memory_meta WHERE key = 'tree_version'`)
      .pluck()
      .get(),
    beforeInvalidCommit,
    '失败事务不得推进 tree_version meta'
  )
  equal(opened.store.version, beforeInvalidCommit, '失败事务不得推进内存 head')

  const stateBeforeCompaction = opened.store.current
  const compaction = opened.store.compactHead({
    compactionId: 'compaction-64',
    createdAt: 1_000,
  })
  equal(compaction.baseVersion, MemoryTreeCheckpointIntervalV2, '基点版本')
  equal(
    compaction.deletedDiffCount,
    MemoryTreeCheckpointIntervalV2,
    'head 压缩应删除基点之前的全部细粒度 diff'
  )
  equal(
    authority.database.prepare(`SELECT count(*) FROM memory_tree_diffs`).pluck().get(),
    0,
    '压缩后旧 diff 应删除'
  )
  equal(
    authority.database.prepare(`SELECT count(*) FROM memory_tree_snapshots`).pluck().get(),
    1,
    '压缩后只保留基点 snapshot'
  )
  equal(
    authority.database.prepare(`SELECT count(*) FROM memory_tree_bases`).pluck().get(),
    1,
    '物化基点必须是 authority 对象'
  )
  const baseRow = authority.database
    .prepare(`SELECT * FROM memory_tree_bases WHERE base_version = ?`)
    .get(MemoryTreeCheckpointIntervalV2) as {
    state_blob_ref: string
    state_commitment: string
    prior_segment_event_head: string
    base_event_hash: string
    manifest_hash: string
  }
  const basePlaintext = contentKeys.openContent(baseRow.state_blob_ref, baseRow.state_commitment)
  check(
    !readFileSync(
      join(
        authority.roots.blobsDir,
        baseRow.state_blob_ref.slice(0, 2),
        `${baseRow.state_blob_ref}.blob`
      )
    ).includes(Buffer.from('concept:k2:leaf')),
    '基点结构也必须以密文 blob 落盘'
  )
  basePlaintext.fill(0)

  const reopened = MemoryTreeStoreV2.open({ authority, contentKeys, keyring })
  equal(reopened.report.baseVersion, MemoryTreeCheckpointIntervalV2, '重开应从基点起步')
  equal(reopened.report.replayedDiffCount, 0, '基点 head 重开无需旧 diff')
  equal(reopened.store.current.stateHash, stateBeforeCompaction.stateHash, '基点重建状态')
  equal(reopened.report.projectionRebuilt, false, '未损坏投影无需重建')

  const before65 = reopened.store.current.nodes
  const leaf64 = before65.find((node) => node.stableKey === 'concept:k2:leaf')
  check(leaf64 !== undefined, 'v64 leaf 存在')
  const leaf65 = {
    ...leaf64,
    content: { ...leaf64.content },
    lastActiveAt: 65,
  }
  const commit65 = reopened.store.commitVersion({
    expectedBaseVersion: 64,
    ops: buildBasicTreeDiffOpsV2(
      before65,
      before65.map((node) => (node.stableKey === leaf65.stableKey ? leaf65 : node))
    ),
    activeIdentityEpochId: 'epoch-1',
    globalMainlineNodeId: 'root',
    frontierEvidenceSequence: 0,
    createdByRunId: 'run-65',
    createdAt: 1_001,
  })
  equal(commit65.version, 65, '基点后的首个版本')
  equal(
    authority.database
      .prepare(`SELECT previous_event_hash FROM memory_tree_diffs WHERE version = 65`)
      .pluck()
      .get(),
    compaction.baseEventHash,
    '基点后的首个 diff 必须指向 base_event_hash'
  )

  const generationBeforeTamper = readCurrentGenerationV2(authority.roots.indexDir)
  check(generationBeforeTamper !== null, '篡改前 CURRENT index generation 存在')
  const sealedPath = join(
    authority.roots.indexDir,
    `generation-${generationBeforeTamper}`,
    'index-generation.sealed'
  )
  const envelope = JSON.parse(readFileSync(sealedPath, 'utf8')) as {
    ciphertext: string
  }
  envelope.ciphertext =
    envelope.ciphertext.slice(0, -2) + (envelope.ciphertext.endsWith('AA') ? 'AQ' : 'AA')
  writeFileSync(sealedPath, JSON.stringify(envelope))
  const recovered = MemoryTreeStoreV2.open({ authority, contentKeys, keyring })
  equal(recovered.report.projectionRebuilt, true, '损坏派生代应从 authority 正向链重建')
  equal(recovered.store.version, 65, '派生代损坏不得影响 authority head')
  const generationAfterRecovery = readCurrentGenerationV2(authority.roots.indexDir)
  check(
    generationAfterRecovery !== null && generationAfterRecovery > generationBeforeTamper,
    '派生重建必须切到新 generation'
  )

  const originalManifestHash = baseRow.manifest_hash
  authority.database
    .prepare(
      `UPDATE memory_tree_bases
       SET manifest_hash = ?
       WHERE base_version = ?`
    )
    .run('f'.repeat(64), 64)
  expectAppErrorCode(
    'INVARIANT',
    () => MemoryTreeStoreV2.open({ authority, contentKeys, keyring }),
    '基点 manifest_hash 漂移必须在 open 时拒绝'
  )
  authority.database
    .prepare(
      `UPDATE memory_tree_bases
       SET manifest_hash = ?
       WHERE base_version = ?`
    )
    .run(originalManifestHash, 64)
  equal(
    MemoryTreeStoreV2.open({ authority, contentKeys, keyring }).store.version,
    65,
    '恢复 manifest 后 authority 链应可重开'
  )

  const manifestState = buildMemoryTreeBaseStateV2(65, [...recovered.store.current.nodes].reverse())
  const hashesA = computeMemoryTreeBaseHashesV2(manifestState, commit65.eventHash)
  const hashesB = computeMemoryTreeBaseHashesV2(
    buildMemoryTreeBaseStateV2(65, recovered.store.current.nodes),
    commit65.eventHash
  )
  equal(hashesA.manifestHash, hashesB.manifestHash, 'manifest 必须与节点输入顺序无关')
  equal(hashesA.treeHash, hashesB.treeHash, '基点 tree_hash 必须与输入顺序无关')
  authority.close()
}

function seedIdentityEpochV2(
  database: ReturnType<typeof openMemoryAuthorityV2>['store']['database'],
  contentKeys: ContentKeyServiceV2
): void {
  const identity = sealAndRegisterV2(database, contentKeys, '我是持续帮助用户完成项目的 AI')
  const mainline = sealAndRegisterV2(database, contentKeys, '当前主线：完成 VelarOS 重构')
  database
    .prepare(
      `INSERT INTO memory_identity_epochs(
         id, sequence, identity_statement_blob_ref, identity_statement_commitment,
         global_mainline_blob_ref, global_mainline_commitment, confidence,
         predecessor_id, started_at, created_by_run_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'epoch-1',
      1,
      identity.blobId,
      identity.commitment,
      mainline.blobId,
      mainline.commitment,
      0.9,
      null,
      1,
      'run-seed',
      1
    )
}

function sealAndRegisterV2(
  database: ReturnType<typeof openMemoryAuthorityV2>['store']['database'],
  contentKeys: ContentKeyServiceV2,
  content: string
): { blobId: string; commitment: string } {
  const sealed = contentKeys.sealContent(content)
  database
    .prepare(
      `INSERT INTO memory_content_blobs(blob_id, byte_length, state, created_at)
       VALUES (?, ?, 'active', 1)`
    )
    .run(sealed.blobId, sealed.byteLength)
  return sealed
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

function createLeafNodeV2(blobRef: string, commitment: string): MemoryTreeNodeStructV2 {
  return {
    stableKey: 'concept:k2:leaf',
    parentKey: 'root',
    nodeType: 'leaf',
    namespace: 'concept',
    subjectType: 'concept',
    subjectId: `k2:${'1'.repeat(32)}`,
    content: { blobRef, commitment, redacted: false },
    mainlineScore: 0.5,
    confidence: 0.8,
    activation: 0.5,
    firstSeenAt: 1,
    lastActiveAt: 1,
    visibilityState: 'active',
  }
}

function runStaticBackwardWriteBoundaryProbeV2(): void {
  const sourceRoot = join(process.cwd(), 'packages', 'memory', 'src', 'memory-tree', 'v2')
  const productionSources = collectTypeScriptSourcesV2(sourceRoot).filter(
    (path) =>
      !path.endsWith('DiffChain.ts') &&
      !path.endsWith('-probe.ts') &&
      !path.endsWith('tree-store-v2-probe.ts')
  )
  const offenders = productionSources.filter((path) =>
    readFileSync(path, 'utf8').includes('replayTreeDiffsBackwardV2')
  )
  equal(
    offenders.length,
    0,
    `INV-BR：生产持久化模块不得调用 backward replay：${offenders.join(', ')}`
  )
}

function collectTypeScriptSourcesV2(directory: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      result.push(...collectTypeScriptSourcesV2(path))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      result.push(path)
    }
  }
  return result
}

runTreeStoreProbeV2()
check(
  assertionCount >= ExpectedMinimumAssertionsV2,
  `tree store v2 断言计数不足：${assertionCount}/${ExpectedMinimumAssertionsV2}`
)
process.stdout.write(`Memory tree store v2 probe: ${assertionCount} assertions passed.\n`)
