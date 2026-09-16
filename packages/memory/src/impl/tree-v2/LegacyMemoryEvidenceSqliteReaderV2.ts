import { existsSync } from 'node:fs'

import BetterSqlite3 from 'better-sqlite3'

import { AppError, isString } from '@velaros-ai/core'

import type { MemorySqliteDatabaseV2 } from '../../types/tree-v2/authority'
import type {
  LegacyGovernanceQueryRowV2,
  LegacyMemoryEvidenceReaderV2,
  LegacyMemoryEvidenceRowV2,
  LegacyMemoryGovernanceRowV2,
} from '../../types/tree-v2/evidence'
import {
  assertLegacyEvidenceSchemaV2,
  assertSourceDatabaseIdV2,
  hasLegacyTableV2,
  mapLegacyEvidenceRowV2,
} from '../../utils/tree-v2/evidence-replay'

/**
 * 旧共享库的只读 reader：构造即以 SQLite `readonly` + `query_only` 双锁打开那个文件。
 *
 * 迁移代码对旧库没有写权，这是构造性保证，不是靠调用方自律。
 * 实例归发起重灌的调用方（或探针）所有，用完要 `close()`。
 */
export interface LegacyMemoryEvidenceSqliteReaderV2Api extends LegacyMemoryEvidenceReaderV2 {
  /** 关闭对旧库的只读连接。 */
  close(): void
}

export class LegacyMemoryEvidenceSqliteReaderV2 implements LegacyMemoryEvidenceSqliteReaderV2Api {
  private readonly database: MemorySqliteDatabaseV2

  constructor(
    databasePath: string,
    public readonly sourceDatabaseId: string
  ) {
    if (!existsSync(databasePath)) {
      throw new AppError('NOT_FOUND', '旧记忆 authority 数据库不存在。', undefined, {
        sourceDatabaseId,
      })
    }
    assertSourceDatabaseIdV2(sourceDatabaseId)
    const database = new BetterSqlite3(databasePath, {
      readonly: true,
      fileMustExist: true,
    })
    database.pragma('query_only = ON')
    assertLegacyEvidenceSchemaV2(database)
    this.database = database
  }

  public listEvidence(): readonly LegacyMemoryEvidenceRowV2[] {
    return (
      this.database
        .prepare(
          `SELECT id, source_type, trust_level, source_id, session_id, execution_id,
                  workspace_root, scope_type, scope_id, occurred_at, title, content,
                  category, privacy_class, eligibility_state, metadata_json,
                  ingest_sequence, created_at
           FROM memory_evidence
           ORDER BY ingest_sequence`
        )
        .all() as Array<Record<string, unknown>>
    ).map(mapLegacyEvidenceRowV2)
  }

  public listGovernance(): readonly LegacyMemoryGovernanceRowV2[] {
    if (
      !hasLegacyTableV2(this.database, 'memory_claims') ||
      !hasLegacyTableV2(this.database, 'memory_claim_evidence') ||
      !hasLegacyTableV2(this.database, 'memory_concepts')
    ) return []
    return (
      this.database
        .prepare(
          `SELECT claim.id AS legacy_target_id,
                  claim.lifecycle_reason AS governance_type,
                  link.evidence_id AS legacy_evidence_id,
                  claim.predicate,
                  claim.value_json,
                  concept.concept_type,
                  concept.canonical_name,
                  concept.scope_type,
                  concept.scope_id
           FROM memory_claims claim
           LEFT JOIN memory_claim_evidence link ON link.claim_id = claim.id
           LEFT JOIN memory_concepts concept ON concept.id = claim.subject_concept_id
           WHERE claim.lifecycle_reason IN ('forgotten', 'superseded', 'erased')
           ORDER BY claim.id, link.evidence_id`
        )
        .all() as LegacyGovernanceQueryRowV2[]
    ).map((row) => ({
      governanceType: row.governance_type,
      legacyTargetId: row.legacy_target_id,
      legacyEvidenceId: row.legacy_evidence_id,
      target:
        isString(row.predicate) &&
        isString(row.value_json) &&
        isString(row.concept_type) &&
        isString(row.canonical_name) &&
        isString(row.scope_type) &&
        isString(row.scope_id)
          ? {
              kind: 'claim',
              conceptType: row.concept_type,
              conceptName: row.canonical_name,
              conceptScopeType: row.scope_type,
              conceptScopeId: row.scope_id,
              predicate: row.predicate,
              valueJson: row.value_json,
            }
          : null,
    }))
  }

  public close(): void {
    this.database.close()
  }
}
