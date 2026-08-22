import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'

import { AppError, isNotNull } from '@velaros-ai/core'

import { MemoryBlobStoreV2 } from './storage/BlobStore'
import { ContentKeyServiceV2 } from './storage/ContentKeyService'
import {
  MemoryIndexStoragePolicyV2,
  openCurrentMemoryIndexGenerationV2,
  sealMemoryIndexGenerationV2,
} from './storage/IndexGenerationStore'
import { MemoryKeyringStoreV2 } from './storage/Keyring'
import type { MemoryWrappingRootV2 } from './storage/WrappingRoot'
import { assertMemoryAuthoritySchemaV2, openMemoryAuthorityV2 } from './AuthorityDatabase'
import {
  MemoryAuthorityApplicationIdV2,
  MemoryAuthorityBlindIndexColumnsV2,
  MemoryAuthorityForbiddenPlaintextColumnsV2,
  MemoryAuthoritySchemaVersionV2,
} from './AuthoritySchema'

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

function expectAppError(run: () => unknown, message: string): AppError {
  let observed: unknown
  try {
    run()
  } catch (error) {
    // arch-guard:silent-catch-ok 探针在下方断言捕获到的 AppError。
    observed = error
  }
  check(observed instanceof AppError, `${message}: 应抛 AppError`)
  return observed as AppError
}

function expectThrows(run: () => unknown, message: string): unknown {
  let observed: unknown
  try {
    run()
  } catch (error) {
    // arch-guard:silent-catch-ok 探针在下方断言确实捕获到了错误。
    observed = error
  }
  check(observed instanceof Error, `${message}: 应抛错误`)
  return observed
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

function runAuthorityProbeV2(): void {
  const probeRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-authority-v2-'))
  try {
    runOpenAndSchemaProbeV2(join(probeRoot, 'open'))
    runMigrationRecoveryProbeV2(join(probeRoot, 'migration-recovery'))
    runV1UpgradeProbeV2(join(probeRoot, 'v1-upgrade'))
    runForeignDatabaseRefusalProbeV2(join(probeRoot, 'foreign'))
    runFutureVersionRefusalProbeV2(join(probeRoot, 'future'))
    runEncryptedPayloadProbeV2(join(probeRoot, 'encrypted'))
    runIndexGenerationEncryptionProbeV2(join(probeRoot, 'index'))
    runStaticSqlBoundaryProbeV2()
  } finally {
    rmSync(probeRoot, { recursive: true, force: true })
  }
}

function runV1UpgradeProbeV2(dataRoot: string): void {
  const created = openMemoryAuthorityV2(dataRoot)
  const databasePath = created.store.roots.authorityDatabasePath
  created.store.close()
  const v1 = new BetterSqlite3(databasePath)
  v1.exec(`
    DROP TABLE memory_replay_governance;
    DROP TABLE memory_evidence_replay_ledger;
    DROP TABLE memory_episode_evidence;
    DROP TABLE memory_concept_evidence;
    DELETE FROM memory_schema_migrations WHERE version >= 2;
    PRAGMA user_version = 1;
  `)
  v1.close()

  const upgraded = openMemoryAuthorityV2(dataRoot)
  equal(upgraded.report.previousSchemaVersion, 1, 'v1 库应识别为追加迁移起点')
  equal(upgraded.report.appliedMigrations.length, 2, 'v1 库只应用 migration 2/3')
  check(
    upgraded.store.database
      .prepare(
        `SELECT 1 FROM sqlite_master
         WHERE type = 'table' AND name = 'memory_concept_evidence'`
      )
      .get(),
    'v1 升级后 concept evidence 表存在'
  )
  check(
    upgraded.store.database
      .prepare(
        `SELECT 1 FROM sqlite_master
         WHERE type = 'table' AND name = 'memory_episode_evidence'`
      )
      .get(),
    'v1 升级后 episode evidence 表存在'
  )
  equal(
    upgraded.store.database.pragma('user_version', { simple: true }),
    MemoryAuthoritySchemaVersionV2,
    'v1 升级后 user_version 应到当前版本'
  )
  upgraded.store.close()
}

function runOpenAndSchemaProbeV2(dataRoot: string): void {
  const first = openMemoryAuthorityV2(dataRoot, {
    now: () => 1_753_500_000_000,
  })
  equal(first.report.databaseCreated, true, '首次 open 应创建独立 authority 数据库')
  equal(first.report.previousSchemaVersion, 0, '首次 open 的前版本应为 0')
  equal(first.report.schemaVersion, MemoryAuthoritySchemaVersionV2, 'schema 版本')
  equal(first.report.appliedMigrations.length, 3, '首次 open 应顺序应用三条 migration')
  equal(
    first.store.database.pragma('application_id', { simple: true }),
    MemoryAuthorityApplicationIdV2,
    'application_id 应锁定 Memory Tree v2 数据库身份'
  )
  equal(
    first.store.database.pragma('user_version', { simple: true }),
    MemoryAuthoritySchemaVersionV2,
    'user_version 应与 migration 账本一致'
  )
  equal(first.store.database.pragma('foreign_keys', { simple: true }), 1, '外键必须启用')
  equal(first.store.database.pragma('journal_mode', { simple: true }), 'wal', 'authority 使用 WAL')
  equal(first.store.database.pragma('synchronous', { simple: true }), 2, 'authority 使用 FULL 同步')
  equal(first.store.database.pragma('secure_delete', { simple: true }), 1, 'secure_delete 必须启用')

  const tables = (
    first.store.database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
  for (const required of [
    'memory_content_blobs',
    'memory_evidence',
    'memory_concepts',
    'memory_episodes',
    'memory_claims',
    'memory_relations',
    'memory_identity_epochs',
    'memory_tree_snapshots',
    'memory_tree_diffs',
    'memory_tree_bases',
    'memory_tree_compactions',
    'memory_erasure_requests',
    'memory_erasure_targets',
    'memory_outbound_disclosures',
    'memory_dream_runs',
  ]) {
    check(tables.includes(required), `authority baseline 缺表：${required}`)
  }
  check(!tables.includes('memory_tree_nodes'), '树明文投影视图不得进入 authority 根')
  check(!tables.includes('memory_recall_fts'), 'FTS 不得进入 authority 根')

  const forbidden = new Set<string>(MemoryAuthorityForbiddenPlaintextColumnsV2)
  for (const table of tables) {
    const columns = first.store.database.pragma(`table_info("${table}")`) as Array<{
      name: string
    }>
    for (const column of columns) {
      check(!forbidden.has(column.name), `authority 不得出现明文语义列：${table}.${column.name}`)
    }
  }
  assertMemoryAuthoritySchemaV2(first.store.database)

  expectThrows(
    () =>
      first.store.database
        .prepare(
          `INSERT INTO memory_concepts(
             id, stable_key, concept_type, scope_type, privacy_class, lifecycle_state,
             first_seen_at, last_active_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'concept-invalid',
          'concept:plaintext-prefix',
          'project',
          'workspace',
          'standard',
          'erased',
          1,
          1,
          1,
          1
        ),
    'stable_key 必须是不透明 k2 token'
  )
  expectThrows(
    () =>
      first.store.database
        .prepare(
          `INSERT INTO memory_evidence(
             id, source_type, trust_level, scope_type, scope_match_key, occurred_at,
             privacy_class, eligibility_state, ingest_sequence, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'evidence-invalid',
          'chat',
          'direct',
          'workspace',
          '/Users/plaintext',
          1,
          'standard',
          'active',
          1,
          1
        ),
    'scope_match_key 不得回退为明文影子列'
  )
  expectThrows(
    () =>
      first.store.database
        .prepare(
          `INSERT INTO memory_episodes(
             id, stable_key, episode_type, state, started_at, scope_type,
             primary_concept_id, created_by_run_id, last_reinforced_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'episode-orphan',
          `k2:${'1'.repeat(32)}`,
          'task',
          'active',
          1,
          'workspace',
          'missing-concept',
          'run-1',
          1,
          1,
          1
        ),
    'authority 外键必须真实生效'
  )

  first.store.close()
  const reopened = openMemoryAuthorityV2(dataRoot)
  equal(reopened.report.databaseCreated, false, '重复 open 不应重建数据库')
  equal(
    reopened.report.previousSchemaVersion,
    MemoryAuthoritySchemaVersionV2,
    '重复 open 应识别现版本'
  )
  equal(reopened.report.appliedMigrations.length, 0, '重复 open 不应重复迁移')
  reopened.store.close()
}

function runMigrationRecoveryProbeV2(dataRoot: string): void {
  expectAppError(
    () =>
      openMemoryAuthorityV2(dataRoot, {
        migrationHooks: {
          afterApplyBeforeCommit() {
            throw new AppError('INVARIANT', 'probe crash before migration commit')
          },
        },
      }),
    'migration 中断应向上抛错'
  )

  const databasePath = join(dataRoot, 'memory', 'authority', 'authority.sqlite3')
  const afterCrash = new BetterSqlite3(databasePath)
  equal(afterCrash.pragma('user_version', { simple: true }), 0, '失败迁移不得推进版本')
  const tableCount = (
    afterCrash
      .prepare(
        `SELECT count(*) AS count
         FROM sqlite_schema
         WHERE type = 'table' AND name LIKE 'memory_%'`
      )
      .get() as { count: number }
  ).count
  equal(tableCount, 0, '失败迁移不得留下半套 authority 表')
  afterCrash.close()

  const recovered = openMemoryAuthorityV2(dataRoot)
  equal(recovered.report.appliedMigrations.length, 3, '崩溃后重开应完整重跑 migration')
  recovered.store.close()
}

function runForeignDatabaseRefusalProbeV2(dataRoot: string): void {
  const authorityDir = join(dataRoot, 'memory', 'authority')
  const layout = openMemoryAuthorityV2(dataRoot)
  layout.store.close()
  const databasePath = join(authorityDir, 'authority.sqlite3')
  const database = new BetterSqlite3(databasePath)
  database.exec('DROP TABLE memory_schema_migrations; CREATE TABLE foreign_table(id TEXT);')
  database.pragma('application_id = 0')
  database.pragma('user_version = 0')
  database.close()
  expectAppError(
    () => openMemoryAuthorityV2(dataRoot),
    '未知数据库不得被 destructive reset 或猜测接管'
  )
}

function runFutureVersionRefusalProbeV2(dataRoot: string): void {
  const opened = openMemoryAuthorityV2(dataRoot)
  const path = opened.store.roots.authorityDatabasePath
  opened.store.close()
  const database = new BetterSqlite3(path)
  database.pragma(`user_version = ${MemoryAuthoritySchemaVersionV2 + 1}`)
  database.close()
  expectAppError(() => openMemoryAuthorityV2(dataRoot), '未来 authority schema 必须 fail closed')
}

function runEncryptedPayloadProbeV2(dataRoot: string): void {
  const opened = openMemoryAuthorityV2(dataRoot)
  const root = createProbeWrappingRootV2()
  const keyring = MemoryKeyringStoreV2.open(opened.store.roots.keyringDir, root).store
  const blobs = new MemoryBlobStoreV2(opened.store.roots.blobsDir)
  const contentKeys = new ContentKeyServiceV2(keyring, blobs)
  const secret = 'S2-PROBE-用户语义正文-不许进入-authority/WAL'
  const sealed = contentKeys.sealContent(secret)

  opened.store.database
    .prepare(
      `INSERT INTO memory_content_blobs(blob_id, byte_length, state, created_at)
       VALUES (?, ?, 'active', ?)`
    )
    .run(sealed.blobId, sealed.byteLength, 1)
  opened.store.database
    .prepare(
      `INSERT INTO memory_evidence(
         id, source_type, trust_level, source_id, scope_type, occurred_at,
         payload_blob_ref, payload_commitment, privacy_class, eligibility_state,
         ingest_sequence, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'evidence-encrypted',
      'chat',
      'direct',
      'internal-message-id',
      'system',
      1,
      sealed.blobId,
      sealed.commitment,
      'sensitive',
      'active',
      1,
      1
    )
  equal(
    contentKeys.openContent(sealed.blobId, sealed.commitment).toString('utf8'),
    secret,
    '正文应可经 keyring + blob 正确恢复'
  )
  opened.store.close()

  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${opened.store.roots.authorityDatabasePath}${suffix}`
    if (!existsSync(file)) continue
    check(!readFileSync(file).includes(secret), `authority${suffix || '.sqlite3'} 不得含正文`)
  }
  const blobPath = join(
    opened.store.roots.blobsDir,
    sealed.blobId.slice(0, 2),
    `${sealed.blobId}.blob`
  )
  check(!readFileSync(blobPath).includes(secret), 'blob 文件落盘必须只有密文信封')
}

function runIndexGenerationEncryptionProbeV2(dataRoot: string): void {
  const opened = openMemoryAuthorityV2(dataRoot)
  const root = createProbeWrappingRootV2()
  const keyring = MemoryKeyringStoreV2.open(opened.store.roots.keyringDir, root).store
  const secret = Buffer.from('S2-PROBE-index-generation-明文投影', 'utf8')
  const sealed = sealMemoryIndexGenerationV2(opened.store.roots.indexDir, 1, secret, keyring)
  equal(sealed.generation, 1, '首个 index generation 代号')
  equal(sealed.replacedGeneration, null, '首代不替换旧代')
  equal(MemoryIndexStoragePolicyV2.buildMode, 'memory-only', 'index 必须只在内存构建')
  equal(MemoryIndexStoragePolicyV2.plaintextWalAllowed, false, 'index 不允许明文 WAL')

  const sealedPath = join(opened.store.roots.indexDir, 'generation-1', 'index-generation.sealed')
  const onDisk = readFileSync(sealedPath)
  check(!onDisk.includes(secret), 'index generation 磁盘产物不得含明文投影')
  const restored = openCurrentMemoryIndexGenerationV2(opened.store.roots.indexDir, keyring)
  check(isNotNull(restored), 'CURRENT index generation 应可打开')
  equal(restored.generation, 1, '打开的 index generation 代号')
  equal(restored.plaintextArtifact.toString('utf8'), secret.toString('utf8'), 'index 解封')
  restored.plaintextArtifact.fill(0)

  const envelope = JSON.parse(onDisk.toString('utf8')) as {
    ciphertext: string
  }
  envelope.ciphertext =
    envelope.ciphertext.slice(0, -2) + (envelope.ciphertext.endsWith('AA') ? 'AQ' : 'AA')
  writeFileSync(sealedPath, JSON.stringify(envelope))
  expectAppError(
    () => openCurrentMemoryIndexGenerationV2(opened.store.roots.indexDir, keyring),
    'index generation 篡改必须被 GCM 拒绝'
  )
  opened.store.close()
}

function runStaticSqlBoundaryProbeV2(): void {
  const sourceRoot = join(process.cwd(), 'packages', 'memory', 'src', 'memory-tree', 'v2')
  const sources = collectTypeScriptSourcesV2(sourceRoot).filter(
    (path) => !path.endsWith('authority-v2-probe.ts')
  )
  const violations = sources.flatMap((path) =>
    auditForbiddenQuerySemanticsV2(readFileSync(path, 'utf8')).map((rule) => `${path}: ${rule}`)
  )
  equal(violations.length, 0, `v2 SQL 查询边界违规：${violations.join('; ')}`)

  const matchColumn = MemoryAuthorityBlindIndexColumnsV2[0]
  equal(
    auditForbiddenQuerySemanticsV2(
      `SELECT id FROM memory_evidence WHERE ${matchColumn} ${['LI', 'KE'].join('')} ?`
    ).length,
    1,
    '静态门必须能抓到盲索引模糊查询负控'
  )
  equal(
    auditForbiddenQuerySemanticsV2(
      `SELECT id FROM memory_concepts WHERE substr(stable_key, 1, 3) = ?`
    ).length,
    1,
    '静态门必须能抓到 stable_key 前缀语义负控'
  )
  equal(
    auditForbiddenQuerySemanticsV2(
      `SELECT id FROM memory_claims WHERE claim_group_key = ? OR claim_group_key IN (?, ?)`
    ).length,
    0,
    '盲索引等值与 IN 查询必须允许'
  )
}

function auditForbiddenQuerySemanticsV2(source: string): string[] {
  const blind = '(?:[a-z_]+_match_key|claim_group_key)'
  const stable = 'stable_key'
  const rules: Array<[string, RegExp]> = [
    [
      'blind index supports equality/IN only',
      new RegExp(
        `\\b${blind}\\b\\s*(?:LIKE|GLOB|BETWEEN|<=|>=|<|>)|` +
          `\\b(?:ORDER\\s+BY|GROUP\\s+BY)\\s+${blind}\\b`,
        'iu'
      ),
    ],
    [
      'stable_key is opaque',
      new RegExp(
        `\\b${stable}\\b\\s*(?:LIKE|GLOB|BETWEEN|<=|>=|<|>)|` +
          `\\b(?:substr|substring|instr)\\s*\\(\\s*${stable}\\b`,
        'iu'
      ),
    ],
    [
      'blind index cannot be sliced',
      new RegExp(`\\b(?:substr|substring|instr)\\s*\\(\\s*${blind}\\b`, 'iu'),
    ],
  ]
  return rules.filter(([, pattern]) => pattern.test(source)).map(([rule]) => rule)
}

function collectTypeScriptSourcesV2(directory: string): string[] {
  const sources: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      sources.push(...collectTypeScriptSourcesV2(path))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      sources.push(path)
    }
  }
  return sources
}

runAuthorityProbeV2()
check(
  assertionCount >= ExpectedMinimumAssertionsV2,
  `authority v2 断言计数不足：${assertionCount}/${ExpectedMinimumAssertionsV2}`
)
process.stdout.write(`Memory authority v2 probe: ${assertionCount} assertions passed.\n`)
