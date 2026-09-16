/**
 * `memory-vector` 构造级探针（bun 直驱；嵌入端口注入假实现，不发一次网络请求、不落一个文件）。
 *
 * 验证向量派生索引的关键不变量：
 *  ① **双写**：capture 走权威层，落地结果同批进派生索引；派生层抛错**不影响**权威层返回值；
 *  ② **并联 + 回捞全文**：语义命中的是指针，正文逐字来自权威层；索引里查不到任何内容副本；
 *  ③ **孤儿清理**：权威层已没有的指针不进结果，并被清出索引；
 *  ④ **rebuild 幂等** + 版本戳：重建两次结果一致；换嵌入模型 → `isStale()` 为真；
 *  ⑤ **卸载零损失**：`dropIndex()` 后索引空、权威层召回一条不少；
 *  ⑥ **不吃原始证据**：descriptor 不声明 capture，直接调它当场抛错而不是静默丢数据。
 *
 * 解析期的**角色门**（派生索引不会被当权威后端解析出来）住 `probe:store-capability`：token 解析
 * 是适配器切片的事，主干探针够不着它（`check:memory-boundaries` 的方向矩阵）。
 */

import assert from 'node:assert/strict'

import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { MemoryDerivedIndexFailure } from '../backend/Layered'
import { createLayeredMemoryStoreBackend } from '../backend/Layered'
import { createMemoryFilesBackend } from '../files/Backend'
import { createInMemoryMemoryFilesIo } from '../files/Io'
import type { MemoryEvidenceInput } from '../memory-tree/Types'

import { createMemoryVectorBackend } from './Backend'
import type { MemoryEmbedder } from './Contract'
import { createFileVectorIndexStore, createInMemoryVectorIndexStore } from './Store'

/** 假嵌入器维度：够大才不让散列碰撞给「不相关」也凑出相似度（那会把地板断言测成噪声）。 */
const FakeEmbeddingDimensions = 256

const ExpectedAssertionCount = 56
let assertionCount = 0

function check(ok: unknown, message: string): asserts ok {
  assert.ok(ok, message)
  assertionCount += 1
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert.equal(actual, expected, message)
  assertionCount += 1
}

/**
 * 假嵌入器：把词袋散列进固定维度。
 *
 * 不是「随便造点数」——它必须让**共享词越多余弦越高**，否则并联那几条断言就只是在测试
 * 「有没有返回东西」，而不是「语义层有没有把对的东西排前面」。
 */
function createFakeEmbedder(identity: string, dimensions = FakeEmbeddingDimensions): MemoryEmbedder & { calls: number } {
  const embedder = {
    identity,
    dimensions,
    calls: 0,
    embed(texts: readonly string[]): Promise<ReadonlyArray<readonly number[]>> {
      embedder.calls += 1
      return Promise.resolve(texts.map((text) => {
        const vector: number[] = Array.from({ length: dimensions }, () => 0)
        for (const token of tokenize(text)) {
          vector[hashToken(token) % dimensions] += 1
        }
        return vector
      }))
    },
  }
  return embedder
}

function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const raw of text.toLowerCase().split(/[^\p{Letter}\p{Number}]+/u)) {
    if (!raw) continue
    if (/^[\p{Script=Han}]+$/u.test(raw)) {
      if (raw.length === 1) tokens.push(raw)
      for (let index = 0; index + 1 < raw.length; index += 1) tokens.push(raw.slice(index, index + 2))
      continue
    }
    tokens.push(raw)
  }
  return tokens
}

function hashToken(token: string): number {
  let hash = 0x81_1c_9d_c5
  for (let index = 0; index < token.length; index += 1) {
    hash = Math.imul(hash ^ token.charCodeAt(index), 0x01_00_01_93)
  }
  return (hash >>> 0)
}

function evidence(title: string, content: string): MemoryEvidenceInput {
  return {
    sourceType: 'chat_message',
    trustLevel: 'user_stated',
    scopeType: 'global',
    scopeId: 'global',
    title,
    content,
    occurredAt: 1_000,
  }
}

function createStack(embedderIdentity = 'fake:v1') {
  const io = createInMemoryMemoryFilesIo()
  const authority = createMemoryFilesBackend({
    roots: [{ scopeType: 'global', scopeId: 'global', directory: '/memory' }],
    io,
  })
  const indexStore = createInMemoryVectorIndexStore()
  const embedder = createFakeEmbedder(embedderIdentity)
  const derived = createMemoryVectorBackend({ embedder, store: indexStore })
  const failures: MemoryDerivedIndexFailure[] = []
  const layered = createLayeredMemoryStoreBackend({
    authority,
    derived: [derived],
    onDerivedFailure: (failure) => failures.push(failure),
  })
  return { io, authority, indexStore, embedder, derived, layered, failures }
}

// ── 后端自述与「不吃原始证据」（⑥） ─────────────────────────────────────────
async function probeDescriptor(): Promise<void> {
  const { derived } = createStack()

  equal(derived.descriptor.id, 'vector', '后端 id 为 vector')
  equal(derived.descriptor.role, 'derived-index', '角色是派生索引，不是权威层')
  check(
    !derived.descriptor.verbs.includes('capture'),
    'descriptor 不声明 capture：「不吃原始证据」机械可查，不靠读文档',
  )
  check(derived.isStale(), '从没建过索引 = 过期（等着重建）')
  equal(derived.getItem('any'), null, '派生索引没有内容，getItem 诚实回 null')

  let captureThrew = false
  try {
    // 契约上 capture 是 awaitable(同步实现也可能换成异步),await 才能同时兜住同步抛与 reject。
    await derived.capture(evidence('x', 'y'))
  } catch {
    // arch-guard:silent-catch-ok 本探针只断言派生索引拒绝 capture，错误详情不参与契约。
    captureThrew = true
  }
  check(captureThrew, '直接拿派生索引 capture 当场抛错，不静默丢数据')
}

// ── ① 双写：权威先落地，派生消费落地结果 ──────────────────────────────────
async function probeDualWrite(): Promise<void> {
  const { layered, indexStore, authority, failures } = createStack()

  await layered.captureBatch([
    evidence('回复风格', '用户偏好简洁中文回答，先结论后细节'),
    evidence('部署方式', '生产环境用 electron-builder 打包分发'),
  ])

  equal(indexStore.size(), 2, '双写：两条都进了派生索引')
  equal(failures.length, 0, '正常路径不产生任何派生诊断')

  const records = indexStore.list()
  const serialized = JSON.stringify(records)
  check(!serialized.includes('简洁中文'), '索引里没有内容副本——只有指针与向量')
  check(!serialized.includes('electron-builder'), '索引里没有内容副本（第二条同样）')
  check(
    records.every((record) => record.id.includes('::')),
    '指针就是权威层分配的 id（files 档 = scopeId::相对路径）',
  )
  check(
    records.every((record) => Math.abs(magnitude(record.vector) - 1) < 1e-5),
    '向量写入时已归一化（检索点积即余弦）',
  )

  const direct = await authority.recall('回复风格')
  equal(direct.length >= 1, true, '权威层照旧能召回自己写下的东西')
}

// ── ① 反面：派生层炸了不影响权威层 ────────────────────────────────────────
async function probeDerivedFailureIsolation(): Promise<void> {
  const io = createInMemoryMemoryFilesIo()
  const authority = createMemoryFilesBackend({
    roots: [{ scopeType: 'global', scopeId: 'global', directory: '/memory' }],
    io,
  })
  const brokenEmbedder: MemoryEmbedder = {
    identity: 'broken:v1',
    dimensions: 8,
    embed: () => Promise.reject(new Error('embedding provider down')),
  }
  const failures: MemoryDerivedIndexFailure[] = []
  const layered = createLayeredMemoryStoreBackend({
    authority,
    derived: [createMemoryVectorBackend({ embedder: brokenEmbedder })],
    onDerivedFailure: (failure) => failures.push(failure),
  })

  const result = await layered.captureBatch([evidence('离线也要记住', '嵌入服务挂了也不能丢记忆')])
  equal(result.insertedCount, 1, '嵌入服务挂了，权威写入照常成功')
  equal(failures.length, 1, '派生失败进诊断')
  equal(failures[0].stage, 'index', '诊断标出失败发生在双写的第二写')

  const recalled = await layered.recall('离线')
  equal(recalled.length, 1, '召回照常走权威层——派生层缺席只是变笨，不是功能缺失')
}

// ── ② 并联 + 回捞全文 ─────────────────────────────────────────────────────
async function probeParallelRecall(): Promise<void> {
  const { layered, authority } = createStack()

  // 正文分两行：索引行只吃得到第一行（description = firstLine），第二行的词只有语义层看得见。
  const body = '先给结论再展开细节\n另外不要写任何寒暄'
  await layered.captureBatch([
    evidence('沟通偏好', body),
    evidence('构建命令', 'bun run check 是提交前必过的总门'),
  ])

  const lexical = await authority.recall('寒暄')
  const merged = await layered.recall('寒暄')
  equal(lexical.length, 0, '前提成立：权威层的索引行匹配对这个查询是空手')
  equal(merged.length, 1, '并联后语义层补上了这一条')
  equal(merged[0].title, '沟通偏好', '标题逐字来自权威层，不是索引里的副本')
  equal(merged[0].value, body, '正文逐字来自权威层回捞')
  equal(merged[0].retrievalReason, 'deep', '检索理由如实标成语义层')

  // 两层都命中时不互相挤掉。
  const both = await layered.recall('构建命令')
  check(both.length >= 1, '词法命中照旧在结果里')
  check(both.some((item) => item.title === '构建命令'), '命中的是对的那一条')

  // 相似度地板：一个字都不沾的查询语义层不该硬凑结果。
  const unrelated = await layered.recall('量子色动力学')
  equal(unrelated.length, 0, '不相关查询两层都空手，语义层不靠地板以下的噪声凑数')
}

// ── ③ 孤儿清理 ────────────────────────────────────────────────────────────
async function probeOrphanPruning(): Promise<void> {
  const { layered, indexStore, io } = createStack()

  await layered.captureBatch([evidence('会消失的条目', '这段正文里有一个特征词寒暄')])
  equal(indexStore.size(), 1, '前提：索引里有这条指针')
  const pointer = indexStore.list()[0].id
  check(pointer.startsWith('global::entries/'), '前提：指针指向权威层的那份 markdown')

  // 用户在外部编辑器里把文件删了（权威层从不假设自己是唯一写者）——指针于是成了孤儿。
  io.deleteFile(`/memory/${pointer.slice('global::'.length)}`)

  const results = await layered.recall('寒暄')
  equal(results.length, 0, '权威层认不出的指针不进结果（绝不返回一条没有内容的记忆）')
  // 清理是异步 best-effort（不挡召回），让出一轮事件循环再断言。
  await TimerScope.sleep(0, { label: 'memory-vector-orphan-pruning' })
  equal(indexStore.size(), 0, '孤儿指针被清出索引')
}

// ── ④ rebuild 幂等 + 版本戳 ───────────────────────────────────────────────
async function probeRebuild(): Promise<void> {
  const { layered, indexStore, derived, authority, embedder } = createStack()

  await layered.captureBatch([
    evidence('第一条', '内容一'),
    evidence('第二条', '内容二'),
    evidence('第三条', '内容三'),
  ])
  check(derived.isStale(), 'capture 双写不写版本戳：只有全量重建才敢盖章')

  const first = await layered.rebuildDerivedIndexes()
  equal(first.length, 1, '重建了一个派生索引')
  equal(first[0].indexedCount, 3, '权威层三条全进索引')
  check(!derived.isStale(), '重建后版本戳对上，不再过期')

  const callsAfterFirst = embedder.calls
  const second = await layered.rebuildDerivedIndexes()
  equal(second[0].indexedCount, 3, 'rebuild 幂等：再来一次条数一致')
  equal(indexStore.size(), 3, '索引没有因为重复重建而膨胀')
  equal(second[0].version, first[0].version, '版本戳一致')
  check(embedder.calls > callsAfterFirst, '重建确实重新嵌入了（不是空转）')

  // 换嵌入模型 = 索引作废 = 重建，不写迁移器（§九 9.4）。
  const swapped = createMemoryVectorBackend({
    embedder: createFakeEmbedder('fake:v2'),
    store: indexStore,
  })
  check(swapped.isStale(), '换嵌入模型后版本戳对不上 → 过期 → 该重建')

  // 索引里混进了权威层没有的条目 → 重建把它算成孤儿清掉。
  indexStore.upsert([{
    id: 'global::entries/ghost.md',
    scopeType: 'global',
    scopeId: 'global',
    updatedAt: 1,
    vector: new Float32Array([1]),
  }])
  const third = await layered.rebuildDerivedIndexes()
  equal(third[0].indexedCount, 3, '重建后仍是权威层的三条')
  equal(third[0].removedOrphanCount, 1, '混进来的孤儿被算进清理数')
  equal(indexStore.size(), 3, '孤儿不在重建结果里')

  const all = await authority.recall('内容')
  check(all.length >= 1, '重建全程没有碰过权威层')
}

// ── ⑤ 卸载：只删派生数据，权威零损失 ──────────────────────────────────────
async function probeUninstall(): Promise<void> {
  const io = createInMemoryMemoryFilesIo()
  const authority = createMemoryFilesBackend({
    roots: [{ scopeType: 'global', scopeId: 'global', directory: '/memory' }],
    io,
  })
  const indexStore = createFileVectorIndexStore({ io, directory: '/memory/.index' })
  const derived = createMemoryVectorBackend({
    embedder: createFakeEmbedder('fake:v1'),
    store: indexStore,
  })
  const layered = createLayeredMemoryStoreBackend({ authority, derived: [derived] })

  await layered.captureBatch([
    evidence('保留下来的记忆', '卸载索引不该动它一个字节'),
    evidence('另一条', '同样必须存活'),
  ])
  await layered.rebuildDerivedIndexes()

  const indexPath = '/memory/.index/vector-index.json'
  check(!!io.readTextFile(indexPath), '派生索引确实落了盘')
  const authorityBefore = Object.keys(io.snapshot()).filter((path) => path.startsWith('/memory/entries/'))
  equal(authorityBefore.length, 2, '权威层两个 markdown 文件在盘上')

  await layered.dropDerivedIndexes()

  equal(io.readTextFile(indexPath), null, '卸载：派生索引文件消失')
  equal(indexStore.list().length, 0, '卸载：索引空了')
  const authorityAfter = Object.keys(io.snapshot()).filter((path) => path.startsWith('/memory/entries/'))
  equal(authorityAfter.length, 2, '**权威内容零丢失**（3.7 硬验收）')
  equal(
    io.readTextFile(authorityBefore[0]),
    io.readTextFile(authorityAfter[0]),
    '权威文件逐字节未变',
  )

  const stillRecallable = await layered.recall('保留下来')
  equal(stillRecallable.length, 1, '卸载后照旧能召回：功能面不缺，只是召回变笨')

  // 落盘往返：重开一个 store 应当读回同一份索引。
  await layered.rebuildDerivedIndexes()
  const reopened = createFileVectorIndexStore({ io, directory: '/memory/.index' })
  equal(reopened.list().length, 2, '索引落盘往返：重开读回两条')
  check(
    reopened.list().every((record) => record.vector.length === FakeEmbeddingDimensions),
    '向量经 base64 往返后维度不变',
  )
}

// ── 编排层的诊断面 ────────────────────────────────────────────────────────
async function probeInspect(): Promise<void> {
  const { layered } = createStack()
  await layered.captureBatch([evidence('一条', '内容')])

  const stats = await layered.inspect()
  equal(stats.backendId, 'files', '叠加不产生第三个后端身份：权威层的身份就是它的身份')
  equal(stats.details?.['derived:vector'], 1, '诊断面报出派生索引的条数')
  equal(stats.details?.['derived:vector:stale'], 'yes', '也报出派生索引过没过期')
  equal(layered.derivedDescriptors.length, 1, '在册派生索引可枚举')
  check(layered.hasStaleDerivedIndex(), '过期状态可被宿主查询（重建时机归宿主）')
}

function magnitude(vector: Float32Array): number {
  let sum = 0
  for (const value of vector) sum += value * value
  return Math.sqrt(sum)
}

await probeDescriptor()
await probeDualWrite()
await probeDerivedFailureIsolation()
await probeParallelRecall()
await probeOrphanPruning()
await probeRebuild()
await probeUninstall()
await probeInspect()

assert.equal(
  assertionCount,
  ExpectedAssertionCount,
  `断言数应为 ${ExpectedAssertionCount}，实际 ${assertionCount}（改动断言时同步更新常量）`,
)
console.info(`[memory-vector] 探针通过：${assertionCount} 条断言。`)
