/**
 * 记忆后端 capability token 构造级探针（bun 直驱，进程内 `KernelModuleHost`）。
 *
 * 验收批一的「端口收口」面：
 *  ① 两个后端档（默认树档 + `memory-files`）**并存注册**在同一个 host 上——叠加语义要成立，
 *     一个后端一个 token 是硬前提（§九 9.2）；
 *  ② 按优先序解析：装了谁用谁，优先序换一下就换后端，**不改任何调用点**；
 *  ③ 一个都没装 → `undefined`（partial activation 的「没装就没有」，不是残废降级）；
 *  ④ `mountMemoryAdapter` 不传 `store` 时回落到默认树后端，且每个动词逐字转发 → 行为零变化；
 *  ⑤ 传 `store` 且解析到 `memory-files` 时，capture / recall 两端口确实落到文件后端。
 */

import assert from 'node:assert/strict'

import { KernelModuleHost } from '@velaros-ai/core/kernel/host'

import { createMemoryFilesBackend, MemoryFilesBackendId } from '../files'
import { createInMemoryMemoryFilesIo } from '../files/Io'
import {
  createMemoryTreeStoreBackend,
  type MemoryDomain,
  type MemoryStoreBackend,
  MemoryTreeBackendId,
} from '..'

import {
  createMemoryStoreCapabilityToken,
  createMemoryStoreKernelModule,
  listRegisteredMemoryStoreBackends,
  memoryStoreCapabilityId,
  MemoryStoreCapabilityNamespace,
  resolveMemoryStoreBackend,
} from './MemoryStoreCapability'
import { mountMemoryAdapter } from './mount'

const ExpectedAssertionCount = 32
let assertionCount = 0

function check(ok: unknown, message: string): asserts ok {
  assert.ok(ok, message)
  assertionCount += 1
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert.equal(actual, expected, message)
  assertionCount += 1
}

interface DomainCallLog {
  captureEvidence: number
  captureEvidenceBatch: Array<boolean | undefined>
  recall: string[]
  runDream: number
  forgetClaim: number
  setSessionEvidenceEligibility: number
}

function createFakeDomain(): { domain: MemoryDomain; calls: DomainCallLog } {
  const calls: DomainCallLog = {
    captureEvidence: 0,
    captureEvidenceBatch: [],
    recall: [],
    runDream: 0,
    forgetClaim: 0,
    setSessionEvidenceEligibility: 0,
  }
  const domain = {
    captureEvidence: () => {
      calls.captureEvidence += 1
      return { evidence: { id: 'ev-1' }, inserted: true }
    },
    captureEvidenceBatch: (inputs: readonly unknown[], consolidate?: boolean) => {
      calls.captureEvidenceBatch.push(consolidate)
      return { evidence: [], insertedCount: inputs.length, treeVersion: 7 }
    },
    recall: (query: string) => {
      calls.recall.push(query)
      return [{ id: 'tree-claim', title: '树后端结果' }]
    },
    getClaim: () => ({ id: 'tree-claim' }),
    getDiagnostics: () => ({
      evidenceCount: 11,
      conceptCount: 2,
      episodeCount: 3,
      claimCount: 5,
      relationCount: 1,
      treeNodeCount: 9,
      dreamRunCount: 4,
      ingestFrontier: 11,
      dreamFrontier: 11,
      treeVersion: 42,
      pendingEvidenceCount: 6,
      stalledDreamRunCount: 0,
    }),
    forgetClaim: () => {
      calls.forgetClaim += 1
      return { claimId: 'tree-claim', affectedEvidenceIds: [], treeVersion: 43 }
    },
    runDream: () => {
      calls.runDream += 1
      return { runId: 'r', state: 'committed', treeVersionAfter: 43 }
    },
    setEvidenceEligibility: () => ({}),
    setSessionEvidenceEligibility: () => {
      calls.setSessionEvidenceEligibility += 1
      return {}
    },
    warmup: () => ({ state: 'skipped' }),
    recoverOrphanDreamRuns: () => 0,
  } as unknown as MemoryDomain
  return { domain, calls }
}

function createFilesBackend(): MemoryStoreBackend {
  return createMemoryFilesBackend({
    roots: [{ scopeType: 'global', scopeId: 'global', directory: '/memory' }],
    io: createInMemoryMemoryFilesIo(),
  })
}

function mountInput(domain: MemoryDomain) {
  return {
    domain,
    idleSignal: {
      getIdleSeconds: () => 0,
      isOnBatteryPower: () => false,
      isAppFocused: () => true,
    },
    config: {
      isEnabled: () => true,
      isBackgroundGrowthEnabled: () => true,
      allowBatteryGrowth: () => false,
      isAutomaticDeepRecallEnabled: () => true,
      isChatCaptureEnabled: () => true,
      isWorkspaceCaptureEnabled: () => true,
      isComputerUseCaptureEnabled: () => true,
      isExecutionCaptureEnabled: () => true,
    },
    hostContext: {
      resolveScope: () => ({ scopeType: 'global' as const, scopeId: 'global' }),
      turnContextScopes: ['system'],
    },
  }
}

// ── token 族形状 ───────────────────────────────────────────────────────────
function probeTokenShape(): void {
  equal(MemoryStoreCapabilityNamespace, 'velaros.memory.store', 'token 族前缀按宪章命名')
  equal(memoryStoreCapabilityId('files'), 'velaros.memory.store.files', 'id 由后端 id 派生')
  equal(
    createMemoryStoreCapabilityToken('tree').id,
    'velaros.memory.store.tree',
    'token id 与 capability id 一致',
  )
  check(
    createMemoryStoreCapabilityToken('files').id
      !== createMemoryStoreCapabilityToken('tree').id,
    '一档一 token：共享 id 会把叠加语义降级成三选一',
  )
  let rejected = false
  try {
    memoryStoreCapabilityId('   ')
  } catch {
    rejected = true
  }
  check(rejected, '空后端 id 必须被拒')
}

// ── ①②③ 并存注册 / 优先序解析 / 没装就没有 ────────────────────────────────
async function probeRegistryResolution(): Promise<void> {
  const empty = new KernelModuleHost({ apiVersion: 1 })
  await empty.start()
  equal(
    resolveMemoryStoreBackend({ registry: empty, preference: ['files', 'tree'] }),
    undefined,
    '一个后端都没装 → undefined（没装就没有，不编造空后端）',
  )
  equal(
    listRegisteredMemoryStoreBackends(empty, ['files', 'tree']).length,
    0,
    '诊断面如实回报零后端',
  )

  const { domain } = createFakeDomain()
  const treeBackend = createMemoryTreeStoreBackend(domain)
  const filesBackend = createFilesBackend()

  const host = new KernelModuleHost({ apiVersion: 1 })
  host.registerModule(createMemoryStoreKernelModule({ backend: treeBackend }))
  host.registerModule(createMemoryStoreKernelModule({ backend: filesBackend }))
  await host.start()

  const descriptors = listRegisteredMemoryStoreBackends(host, ['files', 'tree'])
  equal(descriptors.length, 2, '两个后端档并存注册在同一个 host 上')
  equal(descriptors[0].id, MemoryFilesBackendId, '枚举保持请求顺序')
  equal(descriptors[0].role, 'authority', 'files 是权威层')
  equal(descriptors[1].id, MemoryTreeBackendId, '树档同时在册')

  equal(
    resolveMemoryStoreBackend({ registry: host, preference: ['files', 'tree'] })?.descriptor.id,
    MemoryFilesBackendId,
    'files 优先时解析到文件后端',
  )
  equal(
    resolveMemoryStoreBackend({ registry: host, preference: ['tree', 'files'] })?.descriptor.id,
    MemoryTreeBackendId,
    '优先序反过来就换后端，调用点一行不改',
  )
  equal(
    resolveMemoryStoreBackend({ registry: host, preference: ['vector'] }),
    undefined,
    '未注册的档（如批二的 memory-vector）解析为缺席',
  )
  equal(
    resolveMemoryStoreBackend({
      registry: host,
      preference: ['files'],
      capabilityVersion: '2.0.0',
    }),
    undefined,
    '版本不匹配视为缺席（token 版本参与解析）',
  )
  await host.dispose()
}

// ── ④ 默认回落 = 行为零变化 ────────────────────────────────────────────────
async function probeDefaultFallback(): Promise<void> {
  const { domain, calls } = createFakeDomain()
  const adapter = mountMemoryAdapter(mountInput(domain))

  equal(adapter.storeDescriptor.id, MemoryTreeBackendId, '不传 store → 回落默认树后端')
  check(adapter.isDefaultStore, 'isDefaultStore 如实回报回落')

  await adapter.store.recall('查询词')
  equal(calls.recall[0], '查询词', 'recall 逐字转发到 domain.recall')

  adapter.evidenceBridge.captureUserMessage({
    sessionId: 's-1',
    messages: [{ role: 'user', textBlocks: ['记住这条'], messageId: 'm-1' }],
  })
  await adapter.evidenceBridge.flush()
  equal(calls.captureEvidenceBatch.length, 1, 'capture 经窄端口落到 domain.captureEvidenceBatch')
  equal(
    calls.captureEvidenceBatch[0],
    false,
    'consolidate=false 逐字保留（Dream 触发时机仍归 EvidenceBridge）',
  )
  equal(calls.runDream, 1, '插入后照旧触发 immediate Dream')

  adapter.evidenceBridge.markSessionSourceDeleted('s-1')
  await adapter.evidenceBridge.flush()
  equal(calls.setSessionEvidenceEligibility, 1, 'govern 动词逐字转发')

  const stats = await adapter.store.inspect()
  equal(stats.backendId, MemoryTreeBackendId, 'inspect 自报树后端')
  equal(stats.itemCount, 5, '树诊断投影到 itemCount=claimCount')
  equal(stats.version, 42, 'treeVersion 投影到 version')
  equal(stats.pendingCount, 6, 'pendingEvidenceCount 投影到 pendingCount')
}

// ── ⑤ 解析到 files 时两端口真的落到文件后端 ────────────────────────────────
async function probeFilesRouting(): Promise<void> {
  const { domain, calls } = createFakeDomain()
  const filesBackend = createFilesBackend()
  const host = new KernelModuleHost({ apiVersion: 1 })
  host.registerModule(createMemoryStoreKernelModule({ backend: filesBackend }))
  await host.start()

  const adapter = mountMemoryAdapter({
    ...mountInput(domain),
    store: { registry: host, preference: ['files', 'tree'] },
  })
  equal(adapter.storeDescriptor.id, MemoryFilesBackendId, '解析到 files 后端')
  check(!adapter.isDefaultStore, 'isDefaultStore 为假')

  adapter.evidenceBridge.captureUserMessage({
    sessionId: 's-2',
    messages: [{ role: 'user', textBlocks: ['文件后端要记住这条'], messageId: 'm-2' }],
  })
  await adapter.evidenceBridge.flush()
  equal(calls.captureEvidenceBatch.length, 0, '树 domain 不再收到写入')
  equal(calls.runDream, 0, 'files 无 dream 动词 → 不触发整理，也不报错')

  const recalled = await adapter.store.recall('文件后端')
  equal(recalled.length, 1, '写入的证据可被文件后端召回')
  equal(calls.recall.length, 0, '召回没有落到树 domain')

  await host.dispose()
}

await probeTokenShape()
await probeRegistryResolution()
await probeDefaultFallback()
await probeFilesRouting()

assert.equal(
  assertionCount,
  ExpectedAssertionCount,
  `断言数应为 ${ExpectedAssertionCount}，实际 ${assertionCount}（改动断言时同步更新常量）`,
)
console.info(`[memory-store-capability] 探针通过：${assertionCount} 条断言。`)
