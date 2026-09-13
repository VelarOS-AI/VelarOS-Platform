import { isNull, isPresent, isString, isUndefined } from '@velaros-ai/core'

import { replaceSnapshotLineRanges } from '../edits/strategies/line-edit.js'
import { createTextPatch } from '../edits/strategies/prepared-patch.js'
import { ProjectError } from '../errors.js'
import type { FileAdapter } from '../types/adapter.js'
import type { RiskLevel } from '../types/common.js'
import type { ReplaceLinesOperation } from '../types/edit.js'
import type {
  EditIntent,
  EditOperation,
  PreparedPatch,
  PreparedTransaction,
  PrepareEditInput,
} from '../types/edit.js'
import type { ProjectFileAccess } from '../types/file-access.js'
import type { PatchStrategy } from '../types/patch.js'
import type { PatchStrategyInput } from '../types/patch.js'
import type { CorePolicy } from '../types/policy.js'
import type { FileAttributes, FileSnapshot } from '../types/snapshot.js'
import type { ResolvedTarget } from '../types/target.js'
import { combineDiffs, unifiedDiff } from '../utils/diff.js'
import { matchesAny } from '../utils/glob.js'
import { id } from '../utils/id.js'
import { toAbs, toRel } from '../utils/path.js'
import { assertWellFormedProjectText, countChangedLines } from '../utils/text.js'

import { patchFileAttributes, withPatchFileAttributes } from './patch-attributes.js'
import { assertEditsReadOriginal, canRevertToOriginal } from './patch-ownership.js'
import { revisionMismatch } from './transaction-errors.js'
import {
  stagedContentAfter,
  type StagedFileContent,
  withoutStagedOffsets,
} from './transaction-overlay.js'
interface TransactionPlannerDependencies {
  readonly root: string
  readonly policy: CorePolicy
  readonly store: Pick<ProjectFileAccess, 'snapshot'>
  readonly enrichSnapshot: (snapshot: FileSnapshot) => Promise<FileSnapshot>
  readonly getTarget: (targetId?: string) => ResolvedTarget | undefined
  readonly transform: (input: PrepareEditInput) => Promise<PrepareEditInput>
  readonly createAdapters: (snapshot: FileSnapshot) => Promise<FileAdapter[]>
  readonly selectStrategy: (input: PatchStrategyInput) => PatchStrategy
}

/**
 * 取出编辑原语作用的文件路径。`rename_file` 用 `from`/`to` 而非 `path`；符号类与 `custom`
 * 原语本身不带路径，靠 `targetId` 反查——所以这里返回缺席是正常路径，不是错误。
 */
function operationPath(operation: EditOperation): string | undefined {
  if (operation.type === 'rename_file') return operation.from
  return 'path' in operation ? operation.path : undefined
}

const QueueRebaseFriendlyOperations = new Set<string>([
  'replace_text',
  'delete_text',
  'replace_symbol',
  'insert_before_symbol',
  'insert_after_symbol',
  'insert_around_symbol',
  'add_import',
  'remove_import',
  'append_text',
  'prepend_text',
  'insert_text_at_anchor',
])
/** 根据版本化快照生成补丁；不持有事务仓储，不写文件。 */
export class TransactionPlanner {
  constructor(private readonly dependencies: TransactionPlannerDependencies) {}

  /**
   * 事务视角下某路径的当前快照：本事务已暂存的内容优先（`null` 读成不存在），首次触碰才读磁盘。
   */
  private async transactionSnapshot(
    pathValue: string,
    stagedByPath: ReadonlyMap<string, StagedFileContent>,
    attributesByPath: ReadonlyMap<string, FileAttributes>,
  ): Promise<FileSnapshot> {
    const staged = stagedByPath.get(pathValue)
    if (isString(staged))
      return this.snapshotWithContent(pathValue, staged, attributesByPath.get(pathValue))
    if (isUndefined(staged))
      return this.dependencies.enrichSnapshot(
        await this.dependencies.store.snapshot(pathValue, true),
      )
    const disk = await this.dependencies.store.snapshot(pathValue, false)
    return {
      path: disk.path,
      absPath: disk.absPath,
      exists: false,
      isDirectory: false,
      isBinary: false,
      size: 0,
      sha256: disk.sha256,
      revision: `staged:${disk.revision}`,
      mtimeMs: disk.mtimeMs,
      adapterIds: [],
    }
  }

  public async snapshotWithContent(
    pathValue: string,
    content: string,
    attributes?: FileAttributes,
  ): Promise<FileSnapshot> {
    const snapshot = await this.dependencies.store.snapshot(pathValue, true)
    return this.dependencies.enrichSnapshot({
      ...snapshot,
      ...attributes,
      exists: true,
      isDirectory: false,
      isBinary: false,
      content,
      size: content.length,
      encoding: 'utf8',
      revision: `staged:${snapshot.revision}`,
    })
  }

  /**
   * 事务内衔接补丁、按路径分组预检、加锁都以路径字符串为 key，所以路径进事务前统一规范成
   * FileStore 快照用的根相对形式：`./x`、绝对路径与 `x` 若各成一组，同一文件的补丁不衔接，
   * 顺序整文件写入会让后写覆盖先写。越出根目录的路径在这里按原拼写显式拒绝。
   */
  private canonicalPath(pathValue: string): string {
    return toRel(this.dependencies.root, toAbs(this.dependencies.root, pathValue))
  }

  /** 编辑原语里的文件路径（`path` / `from` / `to`）换成规范形式；`json_patch` 内层的 JSON Pointer 不是文件路径。 */
  private withCanonicalPaths(intent: EditIntent): EditIntent {
    const { operation } = intent
    if (operation.type === 'rename_file')
      return {
        ...intent,
        operation: {
          ...operation,
          from: this.canonicalPath(operation.from),
          to: this.canonicalPath(operation.to),
        },
      }
    if (!('path' in operation) || !isString(operation.path)) return intent
    return { ...intent, operation: { ...operation, path: this.canonicalPath(operation.path) } }
  }

  public async prepareTransaction(
    input: PrepareEditInput,
    options: {
      contentOverlay?: Map<string, StagedFileContent>
      attributeOverlay?: Map<string, FileAttributes>
      forcePatchBaseRevision?: 'none'
      store?: boolean
    } = {},
  ): Promise<PreparedTransaction> {
    // 从文件系统角度看，prepare 只生成补丁预览，不写盘。
    const processed = await this.dependencies.transform(input)
    const patches: PreparedPatch[] = []
    const baseSnapshots: FileSnapshot[] = []
    // 按操作顺序暂存每个路径的最新内容：后续操作基于它生成补丁，使同一路径的补丁首尾相接；
    // amendment 从已暂存事务的重放结果起步，锚点才能命中前面补丁产生的内容。
    const stagedByPath = new Map<string, StagedFileContent>(options.contentOverlay ?? [])
    const attributesByPath = new Map<string, FileAttributes>(options.attributeOverlay ?? [])
    const baseRevisions = new Map(
      Object.entries(processed.baseRevisions ?? {}).map(([pathValue, revision]) => [
        this.canonicalPath(pathValue),
        revision,
      ]),
    )

    const intents = processed.operations.map((operationIntent) =>
      this.withCanonicalPaths(operationIntent),
    )
    let groupedThrough = -1
    for (const [operationIndex, intent] of intents.entries()) {
      if (operationIndex <= groupedThrough) continue
      try {
        const lineGroup: ReplaceLinesOperation[] = []
        if (intent.operation.type === 'replace_lines' && !intent.targetId && !intent.constraints) {
          lineGroup.push(intent.operation)
          for (let index = operationIndex + 1; index < intents.length; index += 1) {
            const next = intents[index].operation
            if (
              next.type !== 'replace_lines' ||
              next.path !== intent.operation.path ||
              intents[index].targetId ||
              intents[index].constraints
            )
              break
            lineGroup.push(next)
            groupedThrough = index
          }
        }
        const target = this.dependencies.getTarget(intent.targetId)
        let snapshot: FileSnapshot | undefined
        const pathForOp = isPresent(target)
          ? this.canonicalPath(target.path)
          : operationPath(intent.operation)
        let renameTargetSnapshot: FileSnapshot | undefined
        if (pathForOp) {
          // revision 前置校验只在首次触碰时做：暂存内容是本事务自己的产物，不对应任何磁盘 revision。
          const isStaged = stagedByPath.has(pathForOp)
          // 本事务已删掉的文件只能重新 create_file；其它操作放行的话，prepare 给出的 diff 会描述一份
          // 衔接规则永远写不下去的内容，直到 apply 才以校验失败收场。
          if (isNull(stagedByPath.get(pathForOp)) && intent.operation.type !== 'create_file') {
            throw new ProjectError(
              'TARGET_NOT_FOUND',
              `${pathForOp} 已被本事务前面的操作删除，不能再执行 ${intent.operation.type}`,
              { path: pathForOp, operation: intent.operation.type },
              '如需重建该文件请用 create_file；否则去掉这条操作，或拆成单独事务。',
            )
          }
          if (target && isStaged) {
            throw new ProjectError(
              'INVALID_INPUT',
              `${pathForOp} 已被本事务前面的操作修改，targetId 基于磁盘 revision 的定位已失效`,
              { path: pathForOp, targetId: target.targetId, expected: target.baseRevision },
              '同一文件的后续操作请改用 path 加 oldText / anchorText / symbol 定位，或拆成单独事务。',
            )
          }
          snapshot = await this.transactionSnapshot(pathForOp, stagedByPath, attributesByPath)
          if (
            target &&
            this.dependencies.policy.requireBaseRevision &&
            snapshot.revision !== target.baseRevision
          ) {
            throw revisionMismatch(`${target.path} 的目标 revision 已变化`, {
              expected: target.baseRevision,
              actual: snapshot.revision,
            })
          }
          const requestedBaseRevision = baseRevisions.get(pathForOp) ?? processed.baseRevision
          if (
            !target &&
            this.dependencies.policy.requireBaseRevision &&
            !isStaged &&
            requestedBaseRevision &&
            snapshot.revision !== requestedBaseRevision
          ) {
            throw revisionMismatch(`${pathForOp} 的文件 revision 已变化`, {
              path: pathForOp,
              expected: requestedBaseRevision,
              actual: snapshot.exists ? snapshot.revision : 'deleted',
            })
          }
          if (intent.operation.type === 'rename_file') {
            const renameTargetIsStaged = stagedByPath.has(intent.operation.to)
            renameTargetSnapshot = await this.transactionSnapshot(intent.operation.to, stagedByPath, attributesByPath)
            if (renameTargetSnapshot.exists) {
              throw new ProjectError(
                'CONFLICT_WITH_EXTERNAL_EDIT',
                `重命名目标已存在，拒绝覆盖：${intent.operation.to}`,
                { path: intent.operation.to, actual: renameTargetSnapshot.revision },
                '请选择一个不存在的目标路径，或先单独处理现有目标文件。',
              )
            }
            const requestedTargetRevision = baseRevisions.get(intent.operation.to)
            if (
              !renameTargetIsStaged &&
              requestedTargetRevision &&
              renameTargetSnapshot.revision !== requestedTargetRevision
            ) {
              throw revisionMismatch(`${intent.operation.to} 的目标 revision 已变化`, {
                path: intent.operation.to,
                expected: requestedTargetRevision,
                actual: 'deleted',
              })
            }
            if (!renameTargetIsStaged) baseSnapshots.push(renameTargetSnapshot)
          }
          if (!isStaged) baseSnapshots.push(snapshot)
        }

        const adapters = snapshot ? await this.dependencies.createAdapters(snapshot) : []
        let adapterPrepared: PreparedPatch[] | undefined
        if (lineGroup.length > 1 && snapshot) {
          adapterPrepared = [
            createTextPatch(
              snapshot.path,
              snapshot.revision,
              snapshot.content,
              replaceSnapshotLineRanges(snapshot, lineGroup),
              'core.text-patch',
              { op: 'replace_lines', ranges: lineGroup.length },
            ),
          ]
        }
        // 文件 adapter 优先处理，以便生成更懂语言结构的补丁。
        for (const adapter of adapters) {
          if (adapterPrepared?.length) break
          if (adapter.prepareEdit && snapshot) {
            adapterPrepared = await adapter.prepareEdit({
              ...processed,
              operations: [intent],
              snapshot,
            })
            if (adapterPrepared?.length) break
          }
        }
        let intentPatches: PreparedPatch[]
        if (adapterPrepared?.length) intentPatches = adapterPrepared
        else {
          const strategy = this.dependencies.selectStrategy({
            intent,
            target,
            snapshot,
            policy: this.dependencies.policy,
          })
          intentPatches = await strategy.prepare({
            intent,
            target,
            snapshot,
            policy: this.dependencies.policy,
          })
        }
        if (snapshot) {
          assertEditsReadOriginal(intentPatches, snapshot)
          intentPatches = intentPatches.map((patch) =>
            patch.path === snapshot.path || patch.metadata?.op === 'rename_file_create'
              ? withPatchFileAttributes(patch, snapshot)
              : patch,
          )
        }
        for (const patch of intentPatches) {
          if (typeof patch.newContent === 'string') assertWellFormedProjectText(patch.newContent)
        }
        if (renameTargetSnapshot) {
          intentPatches = intentPatches.map((patchValue) =>
            patchValue.metadata?.op === 'rename_file_create'
              ? { ...patchValue, baseRevision: renameTargetSnapshot.revision }
              : patchValue,
          )
        }
        const chainedPatches: PreparedPatch[] = []
        for (const patchValue of intentPatches) {
          chainedPatches.push(
            stagedByPath.has(patchValue.path) ? withoutStagedOffsets(patchValue) : patchValue,
          )
          stagedByPath.set(patchValue.path, stagedContentAfter(patchValue))
          attributesByPath.set(patchValue.path, patchFileAttributes(patchValue))
        }
        patches.push(...this.withIntentMetadata(chainedPatches, intent))
      } catch (error) {
        if (!(error instanceof ProjectError)) throw error
        const path = operationPath(intent.operation)
        const details: Record<string, unknown> = error.details ?? {}
        const line = typeof details.candidateLine === 'number' ? details.candidateLine : undefined
        const failedIndex =
          operationIndex + (typeof details.rangeIndex === 'number' ? details.rangeIndex : 0)
        throw new ProjectError(
          error.reason,
          `第 ${failedIndex + 1} 个编辑操作失败：${error.message}`,
          {
            ...details,
            operationIndex: failedIndex,
            operationType: intent.operation.type,
            path: details.path ?? path,
            operationPath: path,
            stage: 'prepare',
            written: false,
            ...(path
              ? {
                  recovery: {
                    tool: 'project:read',
                    input: {
                      path,
                      ...(line
                        ? { range: { startLine: Math.max(1, line - 3), endLine: line + 6 } }
                        : {}),
                      maxChars: 12000,
                    },
                  },
                }
              : {}),
          },
          error.suggestedNextAction,
        )
      }
    }

    const preparedPatches =
      options.forcePatchBaseRevision === 'none'
        ? patches.map((patchValue) => ({ ...patchValue, baseRevision: undefined }))
        : patches

    const summary = this.summarizePatches(preparedPatches)
    this.assertScopeWithinPolicy(summary.changedFiles, summary.changedLines)

    const tx: PreparedTransaction = {
      transactionId: id('tx'),
      status: 'prepared',
      patches: preparedPatches,
      ...summary,
      createdAt: Date.now(),
      baseSnapshots,
      metadata: processed.metadata,
    }
    return tx
  }

  /**
   * 事务摘要描述每个文件的**净变化**（事务前 → 最终内容）。同一文件的多个补丁首尾相接，逐补丁
   * diff 的拼接会把中间态 hunk 叠在一起，行数也被重复计算；模型与审批看到的必须就是将要写下的。
   * 单补丁文件直接沿用补丁自带的 diff，保留策略/插件自己的 diff 表达。
   */
  public summarizePatches(
    patches: readonly PreparedPatch[],
  ): Pick<PreparedTransaction, 'changedFiles' | 'diff' | 'changedLines' | 'risk'> {
    const patchesByPath = new Map<string, PreparedPatch[]>()
    for (const patchValue of patches) {
      patchesByPath.set(patchValue.path, [
        ...(patchesByPath.get(patchValue.path) ?? []),
        patchValue,
      ])
    }
    const fileDiffs = [...patchesByPath.entries()].map(([pathValue, pathPatches]) => {
      const [first] = pathPatches
      const diff =
        pathPatches.length === 1
          ? first.diff
          : unifiedDiff(
              pathValue,
              first.oldContent ?? '',
              stagedContentAfter(pathPatches[pathPatches.length - 1]) ?? '',
            )
      const changedLines = countChangedLines(diff)
      if (changedLines > this.dependencies.policy.maxChangedLinesPerFile) {
        throw new ProjectError(
          'SCOPE_VIOLATION',
          `文件变更行数超过宿主限制：${pathValue}`,
          {
            path: pathValue,
            actual: changedLines,
            maximum: this.dependencies.policy.maxChangedLinesPerFile,
            stage: 'prepare',
            written: false,
          },
          '请缩小该文件的变更范围，或由宿主调整事务规模策略。',
        )
      }
      return { diff, changedLines }
    })
    const changedFiles = [...patchesByPath.keys()]
    const changedLines = fileDiffs.reduce((sum, fileDiff) => sum + fileDiff.changedLines, 0)
    return {
      changedFiles,
      diff: combineDiffs(fileDiffs.map((fileDiff) => fileDiff.diff)),
      changedLines,
      risk: this.resolveTransactionRisk(patches, changedFiles, changedLines),
    }
  }

  /**
   * 事务风险按「能否恢复」划线：只要有一个补丁回滚后恢复不了原文（`canRevertToOriginal` 为假）
   * 就是 high，交给 `decide` 请人审。能完整回滚的覆盖、删除、重命名是日常写入，与普通编辑一样只按
   * 新建与规模分 medium/low——宿主按路径记忆审批，把它们划成 high 会让每个不同文件都打断一次用户。
   */
  private resolveTransactionRisk(
    patches: readonly PreparedPatch[],
    changedFiles: readonly string[],
    changedLines: number,
  ): RiskLevel {
    if (patches.some((patchValue) => !canRevertToOriginal(patchValue))) return 'high'

    const createsFile = patches.some((patchValue) => patchValue.metadata?.op === 'create_file')
    const broadChange =
      changedFiles.length > this.dependencies.policy.maxChangedFilesPerTransaction / 2 ||
      changedLines > this.dependencies.policy.maxChangedLinesPerTransaction / 2
    return createsFile || broadChange ? 'medium' : 'low'
  }

  /**
   * 事务规模与受保护文件的**唯一**判定点：prepare（首次成型）与 amend（追加后重算）都走它。
   * 判据：两条路径此前各写了一份完全相同的三项检查，任何一侧改阈值/加规则都会留下另一侧的
   * 缺口——而缺口只在「amend 把事务撑过阈值」这种少见路径上暴露。
   */
  public assertScopeWithinPolicy(changedFiles: readonly string[], changedLines: number): void {
    if (changedFiles.length > this.dependencies.policy.maxChangedFilesPerTransaction) {
      throw new ProjectError(
        'SCOPE_VIOLATION',
        `变更文件过多：${changedFiles.length}`,
        {
          actual: changedFiles.length,
          maximum: this.dependencies.policy.maxChangedFilesPerTransaction,
        },
        `请按独立意图拆成每批最多 ${this.dependencies.policy.maxChangedFilesPerTransaction} 个文件的多个原子事务。`,
      )
    }
    if (changedLines > this.dependencies.policy.maxChangedLinesPerTransaction) {
      throw new ProjectError(
        'SCOPE_VIOLATION',
        `变更行数过多：${changedLines}`,
        { actual: changedLines, maximum: this.dependencies.policy.maxChangedLinesPerTransaction },
        `请按独立意图拆成每批最多 ${this.dependencies.policy.maxChangedLinesPerTransaction} 行的多个原子事务。`,
      )
    }
    for (const file of changedFiles) {
      if (matchesAny(file, this.dependencies.policy.protectedFiles))
        throw new ProjectError('PROTECTED_FILE', `受保护文件被修改：${file}`)
    }
  }

  private withIntentMetadata(patches: PreparedPatch[], intent: EditIntent): PreparedPatch[] {
    return patches.map((patchValue) => ({
      ...patchValue,
      metadata: {
        ...(patchValue.metadata ?? {}),
        intentOperation: intent.operation,
        intentConstraints: intent.constraints,
        intentReason: intent.reason,
        intentTargetId: intent.targetId,
      },
    }))
  }

  public async tryRebasePatch(
    patchValue: PreparedPatch,
    currentSnapshot: FileSnapshot,
  ): Promise<Nullable<PreparedPatch>> {
    // rebase 会用最新快照重新执行原始 intent，同时保留补丁 id。
    const metadata = patchValue.metadata as
      | {
          intentOperation?: EditIntent['operation']
          intentConstraints?: EditIntent['constraints']
          intentReason?: EditIntent['reason']
        }
      | undefined
    const operation = metadata?.intentOperation
    if (!operation || !QueueRebaseFriendlyOperations.has(operation.type)) return null
    if (!currentSnapshot.exists || currentSnapshot.isDirectory || currentSnapshot.isBinary)
      return null

    const intent: EditIntent = {
      operation,
      constraints: metadata?.intentConstraints,
      reason: metadata?.intentReason,
      targetId: undefined,
    }

    try {
      const strategy = this.dependencies.selectStrategy({
        intent,
        snapshot: currentSnapshot,
        policy: this.dependencies.policy,
      })
      const prepared = await strategy.prepare({
        intent,
        snapshot: currentSnapshot,
        policy: this.dependencies.policy,
      })
      if (prepared.length !== 1 || prepared[0].path !== patchValue.path) return null
      assertEditsReadOriginal(prepared, currentSnapshot)
      return {
        ...prepared[0],
        patchId: patchValue.patchId,
        metadata: {
          ...(patchValue.metadata ?? {}),
          ...(prepared[0].metadata ?? {}),
          rebasedFromRevision: patchValue.baseRevision,
          rebasedAt: Date.now(),
        },
      }
    } catch {
      // arch-guard:silent-catch-ok rebase 失败表示该 patch 不可安全重放，调用方会按 null 处理。
      return null
    }
  }
}
