import { isArray, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { MemorySqliteDatabaseV2 } from '../../types/tree-v2/authority'
import type { MemoryTreeDiffOpV2, MemoryTreeNodeStructV2 } from '../../types/tree-v2/diff'
import type {
  MemoryCandidateLedgerRowV2,
  MemoryErasureClosureSetsV2,
  MemoryErasureClosureV2,
  MemoryErasureRequestRowV2,
  MemoryErasureStatusV2,
  MemoryErasureTargetTypeV2,
  MemoryErasureTargetV2,
  MemoryIdRowV2,
  ReplacementIdentityV2,
} from '../../types/tree-v2/erasure'
import type { MemoryContentReaderV2 } from '../../types/tree-v2/storage'

import { canonicalStringifyV2 } from './diff-chain'

/**
 * 彻底清除 saga 的纯判据与 SQL 片段：闭包扩张、墓碑批改、中性接续节点构造与严格解析。
 * 这些只依赖传进来的连接与数据，用不着实例状态。
 */

/** 擦除闭包的格式身份。 */
export const MemoryErasureClosureFormatV2 = 'velaros.memory.erasure-closure.v2'

/** 七类擦除目标的名单（也是入参校验的依据）。 */
export const MemoryErasureTargetTypesV2 = Object.freeze([
  'evidence',
  'concept',
  'episode',
  'claim',
  'relation',
  'identity_epoch',
  'tree_node',
] as const)

/** 根节点与中性接续节点用的空承诺（没有正文，但承诺列不许为空）。 */
export const MemoryEmptyCommitmentV2 = `c2:${'0'.repeat(64)}`

/** 校验擦除目标形态：种类在册且 id 非空。 */
export function validateTargetV2(target: MemoryErasureTargetV2): void {
  if (
    !(MemoryErasureTargetTypesV2 as readonly string[]).includes(target.type) ||
    !target.id
  ) {
    throw new AppError('VALIDATION', '擦除目标形态非法。')
  }
}

/** 核对擦除目标在权威库里真的存在；tree_node 由调用方对着当前树自己查。 */
export function assertTargetExistsV2(
  database: MemorySqliteDatabaseV2,
  target: MemoryErasureTargetV2
): void {
  const tableByType: Partial<Record<MemoryErasureTargetTypeV2, string>> = {
    evidence: 'memory_evidence',
    concept: 'memory_concepts',
    episode: 'memory_episodes',
    claim: 'memory_claims',
    relation: 'memory_relations',
    identity_epoch: 'memory_identity_epochs',
  }
  if (target.type === 'tree_node') return
  const table = tableByType[target.type]
  if (!table || !database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(target.id)) {
    throw new AppError('NOT_FOUND', '擦除目标不存在。', undefined, { ...target })
  }
}

/** 把闭包里各类对象的语义正文列清空并打上墓碑（第一段权威事务的一部分）。 */
export function applyAuthorityTombstonesV2(
  database: MemorySqliteDatabaseV2,
  closure: MemoryErasureClosureV2
): void {
  runForIdsV2(
    database,
    `UPDATE memory_evidence
     SET eligibility_state = 'erased',
         source_match_key = NULL, scope_match_key = NULL,
         payload_blob_ref = NULL, payload_commitment = NULL,
         metadata_blob_ref = NULL, metadata_commitment = NULL
     WHERE id IN`,
    closure.evidenceIds
  )
  runForIdsV2(database, `DELETE FROM memory_concept_aliases WHERE concept_id IN`, closure.conceptIds)
  runForIdsV2(
    database,
    `UPDATE memory_concepts
     SET lifecycle_state = 'erased',
         name_blob_ref = NULL, name_commitment = NULL, name_match_key = NULL,
         description_blob_ref = NULL, description_commitment = NULL
     WHERE id IN`,
    closure.conceptIds
  )
  runForIdsV2(
    database,
    `UPDATE memory_episodes
     SET state = 'erased',
         title_blob_ref = NULL, title_commitment = NULL,
         summary_blob_ref = NULL, summary_commitment = NULL,
         result_blob_ref = NULL, result_commitment = NULL
     WHERE id IN`,
    closure.episodeIds
  )
  runForIdsV2(
    database,
    `UPDATE memory_claims
     SET lifecycle_state = 'erased',
         value_blob_ref = NULL, value_commitment = NULL,
         summary_blob_ref = NULL, summary_commitment = NULL
     WHERE id IN`,
    closure.claimIds
  )
  runForIdsV2(
    database,
    `UPDATE memory_identity_epochs
     SET identity_statement_blob_ref = NULL,
         identity_statement_commitment = NULL,
         global_mainline_blob_ref = NULL,
         global_mainline_commitment = NULL,
         supporting_concept_ids_json = '[]',
         supporting_episode_ids_json = '[]',
         supporting_claim_ids_json = '[]'
     WHERE id IN`,
    closure.identityEpochIds
  )
  runForIdsV2(database, `DELETE FROM memory_relations WHERE id IN`, closure.relationIds)
}

/** 收进只由这一条证据支撑的对象：证据没了它们也就没有依据了。 */
export function addSolelySupportedObjectsV2(
  database: MemorySqliteDatabaseV2,
  evidenceId: string,
  concepts: Set<string>,
  episodes: Set<string>,
  claims: Set<string>,
  relations: Set<string>
): void {
  const definitions = [
    ['memory_concept_evidence', 'concept_id', concepts],
    ['memory_episode_evidence', 'episode_id', episodes],
    ['memory_claim_evidence', 'claim_id', claims],
    ['memory_relation_evidence', 'relation_id', relations],
  ] as const
  for (const [table, idColumn, target] of definitions) {
    const rows = database
      .prepare(
        `SELECT ${idColumn} AS id
         FROM ${table}
         WHERE evidence_id = ?
           AND (SELECT count(*) FROM ${table} all_links
                WHERE all_links.${idColumn} = ${table}.${idColumn}) = 1`
      )
      .all(evidenceId) as MemoryIdRowV2[]
    for (const row of rows) target.add(row.id)
  }
}

/** 把这些对象挂着的证据一并收进闭包。 */
export function addLinkedEvidenceV2(
  database: MemorySqliteDatabaseV2,
  table: string,
  idColumn: string,
  ids: ReadonlySet<string>,
  evidence: Set<string>
): void {
  if (ids.size === 0) return
  const rows = database
    .prepare(
      `SELECT evidence_id AS id FROM ${table}
       WHERE ${idColumn} IN (${placeholdersV2(ids)})`
    )
    .all(...ids) as MemoryIdRowV2[]
  for (const row of rows) evidence.add(row.id)
}

/** 把闭包里各类对象引用到的密文 blob 全收起来。 */
export function collectClosureBlobIdsV2(
  database: MemorySqliteDatabaseV2,
  sets: MemoryErasureClosureSetsV2
): Set<string> {
  const blobs = new Set<string>()
  collectBlobColumnsV2(
    database,
    'memory_evidence',
    'id',
    sets.evidence,
    ['payload_blob_ref', 'metadata_blob_ref'],
    blobs
  )
  collectBlobColumnsV2(
    database,
    'memory_concepts',
    'id',
    sets.concepts,
    ['name_blob_ref', 'description_blob_ref'],
    blobs
  )
  collectBlobColumnsV2(
    database,
    'memory_concept_aliases',
    'concept_id',
    sets.concepts,
    ['alias_blob_ref'],
    blobs
  )
  collectBlobColumnsV2(
    database,
    'memory_episodes',
    'id',
    sets.episodes,
    ['title_blob_ref', 'summary_blob_ref', 'result_blob_ref'],
    blobs
  )
  collectBlobColumnsV2(
    database,
    'memory_claims',
    'id',
    sets.claims,
    ['value_blob_ref', 'summary_blob_ref'],
    blobs
  )
  collectBlobColumnsV2(
    database,
    'memory_identity_epochs',
    'id',
    sets.identities,
    ['identity_statement_blob_ref', 'global_mainline_blob_ref'],
    blobs
  )
  return blobs
}

/** 解开还活着的候选账本，读到过这些证据的账本本身也要一起 shred。 */
export function addCandidateLedgerBlobsV2(
  database: MemorySqliteDatabaseV2,
  contentReader: MemoryContentReaderV2,
  evidenceIds: ReadonlySet<string>,
  blobIds: Set<string>
): void {
  if (evidenceIds.size === 0) return
  const ledgers = database
    .prepare(
      `SELECT candidate_ledger_blob_ref AS blob_ref,
              candidate_ledger_commitment AS commitment
       FROM memory_dream_runs run
       JOIN memory_content_blobs blob
         ON blob.blob_id = run.candidate_ledger_blob_ref
        AND blob.state = 'active'
       WHERE candidate_ledger_blob_ref IS NOT NULL
         AND candidate_ledger_commitment IS NOT NULL`
    )
    .all() as MemoryCandidateLedgerRowV2[]
  for (const ledger of ledgers) {
    const plaintext = contentReader.openContent(ledger.blob_ref, ledger.commitment)
    try {
      let parsed: unknown
      try {
        parsed = JSON.parse(plaintext.toString('utf8'))
      } catch (error) {
        throw new AppError('INVARIANT', 'Candidate ledger JSON 损坏。', error)
      }
      if (
        isPlainObject(parsed) &&
        isArray((parsed as Record<string, unknown>)['readSet']) &&
        ((parsed as Record<string, unknown>)['readSet'] as unknown[]).some(
          (id) => isString(id) && evidenceIds.has(id)
        )
      ) {
        blobIds.add(ledger.blob_ref)
      }
    } finally {
      plaintext.fill(0)
    }
  }
}

/** 把一张表指定几列里的非空 blob 引用收进集合。 */
export function collectBlobColumnsV2(
  database: MemorySqliteDatabaseV2,
  table: string,
  idColumn: string,
  ids: ReadonlySet<string>,
  columns: readonly string[],
  target: Set<string>
): void {
  if (ids.size === 0) return
  const rows = database
    .prepare(
      `SELECT ${columns.join(', ')} FROM ${table}
       WHERE ${idColumn} IN (${placeholdersV2(ids)})`
    )
    .all(...ids) as Array<Record<string, Nullable<string>>>
  for (const row of rows) {
    for (const column of columns) {
      const value = row[column]
      if (value) target.add(value)
    }
  }
}

/** 造根节点的 add 事件：空树上做擦除时先得有根，树形校验才过得去。 */
export function createRootAddOpV2(createdAt: number): MemoryTreeDiffOpV2 {
  return {
    type: 'add',
    before: [],
    after: [
      {
        stableKey: 'root',
        parentKey: null,
        nodeType: 'root',
        namespace: 'root',
        subjectType: 'root',
        subjectId: 'root',
        content: {
          blobRef: null,
          commitment: MemoryEmptyCommitmentV2,
          redacted: false,
        },
        mainlineScore: 1,
        confidence: 1,
        activation: 1,
        firstSeenAt: createdAt,
        lastActiveAt: createdAt,
        visibilityState: 'active',
      },
    ],
  }
}

/** 造中性接续身份主线节点的 add 事件（置信度为 0：它不是从证据推出来的）。 */
export function createIdentityMainlineAddOpV2(
  identity: ReplacementIdentityV2,
  createdAt: number
): MemoryTreeDiffOpV2 {
  const node: MemoryTreeNodeStructV2 = {
    stableKey: `identity:${identity.id}`,
    parentKey: 'root',
    nodeType: 'mainline',
    namespace: 'identity',
    subjectType: 'identity_epoch',
    subjectId: identity.id,
    content: {
      blobRef: identity.globalMainline.blobId,
      commitment: identity.globalMainline.commitment,
      redacted: false,
    },
    mainlineScore: 1,
    confidence: 0,
    activation: 1,
    firstSeenAt: createdAt,
    lastActiveAt: createdAt,
    visibilityState: 'active',
  }
  return { type: 'add', before: [], after: [node] }
}

/** 把闭包摊平成「目标种类 → id 列表」，写 deny-set 时逐条插入。 */
export function closureTargetEntriesV2(
  closure: MemoryErasureClosureV2
): ReadonlyArray<readonly [string, readonly string[]]> {
  return [
    ['evidence', closure.evidenceIds],
    ['concept', closure.conceptIds],
    ['episode', closure.episodeIds],
    ['claim', closure.claimIds],
    ['relation', closure.relationIds],
    ['identity_epoch', closure.identityEpochIds],
    ['tree_node', closure.treeStableKeys],
    ['blob', closure.blobIds],
  ]
}

/** 擦除目标的运行时守卫。 */
export function isMemoryErasureTargetV2(value: unknown): value is MemoryErasureTargetV2 {
  return (
    isPlainObject(value) &&
    isString(value['id']) &&
    isString(value['type']) &&
    (MemoryErasureTargetTypesV2 as readonly string[]).includes(value['type'])
  )
}

/** 判断是不是字符串数组。 */
export function isStringArrayV2(value: unknown): value is readonly string[] {
  return isArray(value) && value.every(isString)
}

/** 擦除闭包的运行时守卫：格式身份、目标与八组 id 都要对。 */
export function isMemoryErasureClosureV2(value: unknown): value is MemoryErasureClosureV2 {
  return (
    isPlainObject(value) &&
    value['format'] === MemoryErasureClosureFormatV2 &&
    isMemoryErasureTargetV2(value['target']) &&
    isStringArrayV2(value['evidenceIds']) &&
    isStringArrayV2(value['conceptIds']) &&
    isStringArrayV2(value['episodeIds']) &&
    isStringArrayV2(value['claimIds']) &&
    isStringArrayV2(value['relationIds']) &&
    isStringArrayV2(value['identityEpochIds']) &&
    isStringArrayV2(value['treeStableKeys']) &&
    isStringArrayV2(value['blobIds'])
  )
}

/** 严格解析落库的闭包：格式与 canonical 字节都要对得上。 */
export function parseClosureV2(raw: string): MemoryErasureClosureV2 {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new AppError('INVARIANT', 'Erasure closure JSON 损坏。', error)
  }
  if (!isMemoryErasureClosureV2(parsed)) {
    throw new AppError('INVARIANT', 'Erasure closure 格式非法。')
  }
  if (raw !== canonicalStringifyV2(parsed)) {
    throw new AppError('INVARIANT', 'Erasure closure 不是 canonical 字节。')
  }
  return parsed
}

/** 把一行擦除请求映射成对外状态。 */
export function mapErasureStatusV2(row: MemoryErasureRequestRowV2): MemoryErasureStatusV2 {
  return {
    requestId: row.id,
    state: row.state,
    redactVersion: row.redact_version,
    privacyGeneration: row.privacy_generation,
    verifiedAt: row.verified_at,
  }
}

/** 跑一条只返回 id 的查询，把结果收进集合；没有参数就直接返回。 */
export function addColumnValuesV2(
  database: MemorySqliteDatabaseV2,
  target: Set<string>,
  sql: string,
  params: readonly string[]
): void {
  if (params.length === 0) return
  for (const row of database.prepare(sql).all(...params) as MemoryIdRowV2[]) {
    target.add(row.id)
  }
}

/** 给一段 `... WHERE x IN` 的 SQL 补上占位符并对这批 id 执行；空列表直接返回。 */
export function runForIdsV2(
  database: MemorySqliteDatabaseV2,
  sqlPrefix: string,
  ids: readonly string[]
): void {
  if (ids.length === 0) return
  database.prepare(`${sqlPrefix} (${placeholdersV2(ids)})`).run(...ids)
}

/** 按个数拼出 `?, ?, ?` 形式的占位符。 */
export function placeholdersV2(values: ReadonlySet<string> | readonly string[]): string {
  return [...values].map(() => '?').join(', ')
}

/** 判断一列 JSON id 数组与给定集合有没有交集；JSON 坏了或不是字符串数组抛 INVARIANT。 */
export function intersectsJsonIdsV2(raw: string, values: ReadonlySet<string>): boolean {
  if (values.size === 0) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new AppError('INVARIANT', 'Identity support ids JSON 损坏。', error)
  }
  if (!isStringArrayV2(parsed)) {
    throw new AppError('INVARIANT', 'Identity support ids 必须是字符串数组。')
  }
  return parsed.some((item) => values.has(item))
}

/** 把集合摊成排好序的数组（闭包必须是确定序，摘要才稳定）。 */
export function sortedV2(values: ReadonlySet<string>): readonly string[] {
  return [...values].sort()
}
