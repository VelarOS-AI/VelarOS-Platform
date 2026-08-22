import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isEmpty } from '@velaros-ai/core'

import type { MemoryWrappingRootV2 } from './storage'
import { openMemorySystemRuntimeV2 } from './SystemRuntime'

const ExpectedMinimumAssertionsV2 = 35
let assertionCount = 0

function check(ok: unknown, message: string): asserts ok {
  assert.ok(ok, message)
  assertionCount += 1
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert.equal(actual, expected, message)
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

function runQueryRuntimeProbeV2(): void {
  const probeRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-query-v2-'))
  const wrappingRoot = createProbeWrappingRootV2()
  try {
    const opened = openMemorySystemRuntimeV2({
      dataRoot: probeRoot,
      wrappingRoot,
      now: () => 1,
    })
    const runtime = opened.runtime
    check(opened.report.authority.databaseCreated, '首次 open 应创建 authority')
    equal(opened.report.tree.treeVersion, 0, '首次 open 应为空树')
    equal(opened.report.recoveredOrphanBlobCount, 0, '首次 open 无孤儿 blob')
    equal(opened.report.resumedErasureCount, 0, '首次 open 无待恢复擦除')
    const empty = runtime.query.recall({ query: 'VelarOS' })
    equal(empty.snapshotVersion, 0, '空树 recall 版本为零')
    equal(empty.indexState, 'missing', '空树尚无查询 index')
    equal(empty.items.length, 0, '空树不返回伪造结果')
    equal(runtime.query.inspectTreeStructure().nodes.length, 0, '空树结构为空')
    equal(runtime.query.refreshSearchIndex().indexedNodeCount, 0, '空树显式刷新应产出可用空 index')
    const emptyReady = runtime.query.recall({ query: 'VelarOS' })
    equal(emptyReady.indexState, 'ready', '空 index 也应匹配当前双键')
    check(!emptyReady.degraded, '可用空 index 不应伪报降级')
    runtime.query.clearSearchIndex()

    const projectEvidence = runtime.ingest.ingest({
      sourceType: 'chat',
      trustLevel: 'user_stated',
      scope: { type: 'global' },
      occurredAt: 10,
      payload: '继续建设 VelarOS 的独立 Memory 产品',
      privacyClass: 'standard',
      createdAt: 10,
    })
    const deliveryEvidence = runtime.ingest.ingest({
      sourceType: 'execution',
      trustLevel: 'system_observed',
      scope: { type: 'global' },
      occurredAt: 11,
      payload: 'S8 查询运行时已落地',
      privacyClass: 'standard',
      createdAt: 11,
    })
    const sensitiveEvidence = runtime.ingest.ingest({
      sourceType: 'chat',
      trustLevel: 'user_stated',
      scope: { type: 'global' },
      occurredAt: 12,
      payload: '用户的私密部署口令',
      privacyClass: 'sensitive',
      createdAt: 12,
    })
    const dreamRun = runtime.dream.startNextBatch({
      trigger: 'manual',
      batchSize: 3,
      modelProfile: { provider: 'local', model: 'probe' },
      startedAt: 20,
    })
    check(dreamRun?.kind === 'started', '应建立 S8 整理 run')
    if (!dreamRun || dreamRun.kind !== 'started') {
      throw new Error('unreachable')
    }
    const curated = runtime.meaning.curateAndCommit({
      runId: dreamRun.runId,
      tokenUsage: 8,
      committedAt: 30,
      proposal: {
        candidates: [
          {
            kind: 'concept',
            candidateKey: 'velaros-memory',
            conceptType: 'project',
            name: 'VelarOS Memory',
            description: '独立记忆产品',
            scope: { type: 'global' },
            privacyClass: 'standard',
            lifecycleState: 'active',
            firstSeenAt: 10,
            lastActiveAt: 12,
            salience: 0.9,
            activation: 0.9,
            evidenceIds: [projectEvidence.id, deliveryEvidence.id],
          },
          {
            kind: 'episode',
            candidateKey: 's8-delivery',
            episodeType: 'task',
            title: '完成 S8',
            summary: 'S8 查询运行时已落地',
            state: 'completed',
            startedAt: 11,
            endedAt: 12,
            scope: { type: 'global' },
            primaryConceptKey: 'velaros-memory',
            phase: 'implementation',
            result: '查询门禁通过',
            salience: 0.8,
            activation: 0.85,
            evidenceIds: [deliveryEvidence.id],
          },
          {
            kind: 'claim',
            candidateKey: 'private-secret',
            subjectConceptKey: 'velaros-memory',
            predicate: 'deployment_secret',
            title: '部署口令',
            value: '用户的私密部署口令',
            summary: '用户的私密部署口令',
            storageMode: 'full',
            epistemicStatus: 'user_confirmed',
            confidence: 0.95,
            privacyClass: 'sensitive',
            lifecycleState: 'active',
            validFrom: 12,
            salience: 0.7,
            consolidationStrength: 0.7,
            activation: 0.7,
            evidenceIds: [sensitiveEvidence.id],
          },
        ],
        identity: {
          statement: '我是持续建设 VelarOS 的 AI',
          globalMainline: '继续建设 VelarOS',
          confidence: 0.9,
          evidenceIds: [projectEvidence.id, deliveryEvidence.id],
          supportingConceptKeys: ['velaros-memory'],
          supportingEpisodeKeys: ['s8-delivery'],
          supportingClaimKeys: [],
        },
      },
    })
    equal(curated.treeVersion, 1, '整理提交首个树版本')
    equal(curated.acceptedCount, 4, '概念、Episode、敏感 Claim 与 Identity 均接受')
    equal(curated.rejectedCount, 0, '高信任敏感 Claim 不应被误拒')

    const missingIndex = runtime.query.recall({ query: 'S8 查询' })
    equal(missingIndex.indexState, 'missing', '同步 recall 不得隐式建 index')
    check(missingIndex.degraded, '缺 index 时应标记降级')
    equal(missingIndex.items.length, 1, '缺 index 时只返回当前主线')
    equal(missingIndex.items[0]?.retrievalReason, 'active-path-fallback', '缺 index 时只走主线路径')
    equal(missingIndex.items[0]?.path.at(-1)?.label, '继续建设 VelarOS', '主线降级只解密最终路径')

    const refreshed = runtime.query.refreshSearchIndex()
    equal(refreshed.snapshotVersion, 1, 'index 锚定已提交树版本')
    equal(refreshed.denyGeneration, 0, '首次 index 锚定初始隐私代际')
    equal(refreshed.indexedNodeCount, 3, '只索引主线、概念与非敏感 Episode')
    equal(refreshed.skippedSensitiveCount, 1, '敏感 Claim 不得进入搜索 index')
    const searched = runtime.query.recall({ query: 'S8 查询' })
    equal(searched.indexState, 'ready', '显式刷新后 index ready')
    check(!searched.degraded, 'ready index 不应标记降级')
    equal(searched.items[0]?.retrievalReason, 'search', '命中走 search')
    check(searched.items[0]?.episodeIds.length === 1, '搜索结果应携带 Episode provenance')
    check(
      searched.items[0]?.evidenceIds.includes(deliveryEvidence.id),
      '搜索结果应携带 active Evidence provenance'
    )

    const structure = runtime.query.inspectTreeStructure()
    equal(structure.snapshotVersion, 1, '结构投影锚定树版本')
    const claimNode = structure.nodes.find((node) => node.subjectType === 'claim')
    check(claimNode, '结构投影应包含敏感 Claim 的稳定标识')
    const hidden = runtime.query.recall({
      query: '',
      branchTreeNodeId: claimNode.treeNodeId,
    })
    equal(hidden.items[0]?.path.at(-1)?.sensitive, true, '敏感节点应显式标记')
    equal(hidden.items[0]?.path.at(-1)?.label, '敏感记忆', '默认只返回稳定模糊标签')
    const revealed = runtime.query.recall({
      query: '',
      branchTreeNodeId: claimNode.treeNodeId,
      revealSensitive: true,
    })
    equal(revealed.items[0]?.path.at(-1)?.label, '用户的私密部署口令', '宿主授权后才解密敏感正文')
    const sensitiveSearch = runtime.query.recall({ query: '私密部署口令' })
    check(
      sensitiveSearch.items.every((item) => isEmpty(item.claimIds)),
      '敏感 Claim 不得被普通搜索召回'
    )

    const preview = runtime.erasure.preview({
      type: 'claim',
      id: claimNode.subjectId,
    })
    const confirmed = runtime.erasure.confirm(preview, 40)
    equal(confirmed.privacyGeneration, 1, '擦除确认推进隐私代际')
    const stale = runtime.query.recall({ query: 'S8 查询' })
    equal(stale.indexState, 'stale', '隐私代际变化立刻使旧 index 失效')
    check(stale.degraded, 'stale index 只允许确定性降级')
    equal(
      runtime.query.recall({
        query: '',
        branchTreeNodeId: claimNode.treeNodeId,
      }).items.length,
      0,
      'deny-set 第一段立即阻断 branch recall'
    )
    check(
      !runtime.query
        .inspectTreeStructure()
        .nodes.some((node) => node.subjectId === claimNode.subjectId),
      'deny-set 第一段立即移出结构投影'
    )
    runtime.close()

    const reopened = openMemorySystemRuntimeV2({
      dataRoot: probeRoot,
      wrappingRoot,
      now: () => 50,
    })
    check(!reopened.report.authority.databaseCreated, '重开应复用同一 authority')
    equal(reopened.report.tree.treeVersion, 2, '重开恢复擦除后的树版本')
    equal(reopened.report.resumedErasureCount, 1, '组合根应幂等恢复待 purge saga')
    equal(
      reopened.runtime.query.recall({ query: 'S8 查询' }).indexState,
      'missing',
      '进程内 index 不得跨重启伪装持久化'
    )
    equal(
      reopened.runtime.query.refreshSearchIndex().skippedDeniedCount,
      1,
      '重建 index 应跳过已 redacted 节点'
    )
    reopened.runtime.close()
  } finally {
    rmSync(probeRoot, { recursive: true, force: true })
  }
}

runQueryRuntimeProbeV2()
check(
  assertionCount >= ExpectedMinimumAssertionsV2,
  `S8 查询/运行时探针断言不足：${assertionCount}`
)
process.stdout.write(`memory query/runtime v2 probe: ${assertionCount} assertions\n`)
