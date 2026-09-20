/**
 * 事务规划：`TransactionPlanner`。接口 `TransactionPlannerApi`、注入回调 `TransactionPlannerDependencies` 与准备选项 `TransactionPlannerPrepareOptions` 在本文件的类上方。
 * 把编辑意图按版本化快照变成补丁，汇总事务的净变化与风险，守住事务规模；不写盘、不持有事务仓库。
 */

import { resolve } from 'node:path'

import { isNull, isNumber, isPresent, isString, isUndefined, numberOrNull, toOptional } from '@velaros-ai/core'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'

import type { FileAdapter, PatchStrategy } from '../../contract/requires.js'
import type { RiskLevel } from '../../types/common.js'
import type {
  EditIntent,
  PreparedPatch,
  PreparedTransaction,
  PrepareEditInput,
  ReplaceLinesOperation,
} from '../../types/edit.js'
import type { ProjectFileAccess } from '../../types/file-access.js'
import type { PatchStrategyInput } from '../../types/patch.js'
import type { CorePolicy } from '../../types/policy.js'
import type { FileAttributes, FileSnapshot } from '../../types/snapshot.js'
import type { ResolvedTarget } from '../../types/target.js'
import type { StagedFileContent } from '../../types/transaction.js'
import { combineDiffs, unifiedDiff } from '../../utils/diff.js'
import { replaceSnapshotLineRanges } from '../../utils/editing/line-edit.js'
import { createTextPatch } from '../../utils/editing/prepared-patch.js'
import { ProjectError } from '../../utils/errors.js'
import { id } from '../../utils/id.js'
import { toAbs, toRel } from '../../utils/path.js'
import { assertWellFormedProjectText, countChangedLines } from '../../utils/text.js'
import { operationFilePaths, operationPath, withIntentMetadata } from '../../utils/transactions/edit-intents.js'
import { patchFileAttributes, withPatchFileAttributes } from '../../utils/transactions/patch-attributes.js'
import { stagedContentAfter, withoutStagedOffsets } from '../../utils/transactions/patch-chain.js'
import { assertEditsReadOriginal, canRevertToOriginal } from '../../utils/transactions/patch-ownership.js'
import { recoveryRead, revisionMismatch } from '../../utils/transactions/transaction-errors.js'

/** 规划要内核注入的东西：根目录、策略、读快照的文件端口，以及补全快照、查目标、跑输入管线、造 adapter、选补丁策略的回调。 */
export interface TransactionPlannerDependencies {
  /** 项目根目录的绝对路径；路径进事务前按它规范成根相对形式。 */
  readonly root: string
  /** 内核策略：revision 检查、事务规模上限都从这里读。 */
  readonly policy: CorePolicy
  /** 读文件快照的端口（带不带正文由第二个参数决定）。 */
  readonly store: Pick<ProjectFileAccess, 'snapshot'>
  /** 给快照补上 adapter 等信息后返回。 */
  readonly enrichSnapshot: (snapshot: FileSnapshot) => Promise<FileSnapshot>
  /** 按 targetId 取之前解析好的目标；没给或找不到返回 undefined。 */
  readonly getTarget: (targetId?: string) => ResolvedTarget | undefined
  /** 让 prepare 输入先过插件登记的 prepare.input 管线。 */
  readonly transform: (input: PrepareEditInput) => Promise<PrepareEditInput>
  /** 为一个文件快照创建能处理它的 adapter，按优先级排好。 */
  readonly createAdapters: (snapshot: FileSnapshot) => Promise<FileAdapter[]>
  /** 选第一个能处理这条意图的补丁策略；没有能处理的抛 NOT_SUPPORTED。 */
  readonly selectStrategy: (input: PatchStrategyInput) => PatchStrategy
}

/** 准备事务时的选项：amend 用它从已暂存事务的重放结果起步。 */
export interface TransactionPlannerPrepareOptions {
  /** 已暂存的路径正文（null 表示已删除）；后续操作基于它生成补丁，同一路径的补丁首尾相接。 */
  contentOverlay?: Map<string, StagedFileContent>
  /** 已暂存路径的文件属性（权限、编码），与 contentOverlay 配套。 */
  attributeOverlay?: Map<string, FileAttributes>
  /** 为 'none' 时去掉每个补丁的 baseRevision：应用时不再按磁盘 revision 核对这些补丁。 */
  forcePatchBaseRevision?: 'none'
}

/**
 * 根据版本化快照把编辑意图变成补丁；不持有事务仓库，不写文件。实例由内核持有，一个内核一份。
 *
 * 预期内的失败都抛 ProjectError：revision 已变化抛 BASE_REVISION_MISMATCH，超出事务规模抛 SCOPE_VIOLATION；
 * 单个操作失败时消息前缀「第 N 个编辑操作失败」，
 * details 带操作序号、路径、stage: 'prepare'、written: false 与回读建议 recovery。adapter、补丁策略抛出的其他错误原样抛出。
 */
export interface TransactionPlannerApi {
  /** 用给定正文（和文件属性）造该路径的暂存快照：revision 带 staged: 前缀，编码按 UTF-8 记。 */
  snapshotWithContent(pathValue: string, content: string, attributes?: FileAttributes): Promise<FileSnapshot>
  /**
   * 准备一个事务：输入先过 prepare.input 管线；每条操作按顺序生成补丁（文件 adapter 优先，其次补丁策略），
   * 同一路径的补丁首尾相接；首次触碰的路径核对 base revision；最后汇总净变化并核对事务规模。
   * 返回 status 为 prepared 的事务（带新事务号和基准快照），不写盘、不入库。
   */
  prepareTransaction(input: PrepareEditInput, options?: TransactionPlannerPrepareOptions): Promise<PreparedTransaction>
  /**
   * 汇总补丁的净变化：同一文件的多个补丁按「事务前 → 最终内容」重算一份 diff（单补丁文件沿用补丁自带的 diff），
   * 算出改动文件、改动行数与风险；单个文件改动行数超过策略上限抛 SCOPE_VIOLATION。
   */
  summarizePatches(patches: readonly PreparedPatch[]): Pick<PreparedTransaction, 'changedFiles' | 'diff' | 'changedLines' | 'risk'>
  /** 事务规模的唯一判定点：prepare 与 amend 都走它，超出文件数或行数上限就抛出。 */
  assertScopeWithinPolicy(changedFiles: readonly string[], changedLines: number): void
  /**
   * 用最新快照重放补丁记下的原始意图，得到接在新内容上的补丁（保留补丁号，metadata 记下 rebase 来源）。
   * 只有文本定位类操作能重放；目标不是可读文本文件、重放出多个补丁或换了路径、重放失败都返回 null，不抛出。
   */
  tryRebasePatch(patchValue: PreparedPatch, currentSnapshot: FileSnapshot): Promise<Nullable<PreparedPatch>>
}

export class TransactionPlanner implements TransactionPlannerApi {
  /** 能在 apply 队列里对最新内容重放的操作：都靠文本、锚点或符号定位，不依赖事务前的行号坐标。 */
  private static readonly QueueRebaseFriendlyOperations: ReadonlySet<string> = new Set([
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

  public constructor(private readonly dependencies: TransactionPlannerDependencies) {}

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

  /**
   * 一次事务里两个入参指向同一个物理文件（项目内的符号链接、大小写别名）时，在写任何东西之前拒绝。
   * 事务按路径字符串分组、衔接补丁、加锁，同一个文件被当成两个就各写各的：先写的那份被后写的整篇覆盖，
   * 或者后一处在冲突检查上失败而磁盘已经改了一半——那正是 INV-4「全成或全不成」破掉的样子。
   */
  private async assertNoAliasedFiles(intents: readonly EditIntent[]): Promise<void> {
    const paths = [...new Set(intents.flatMap((intent) => operationFilePaths(intent.operation)))]
    if (paths.length < 2) return
    const byRealPath = new Map<string, string>()
    for (const pathValue of paths) {
      const realPath = await resolveRealPath(resolve(this.dependencies.root, pathValue))
      const first = byRealPath.get(realPath)
      if (isUndefined(first)) {
        byRealPath.set(realPath, pathValue)
        continue
      }
      throw new ProjectError(
        'INVALID_INPUT',
        `${first} 和 ${pathValue} 是同一个文件（项目内的符号链接或大小写别名指向同一份内容），一次事务里不能各改各的`,
        { paths: [first, pathValue] },
        `把这两处改动合并成对 ${first} 一个路径的一组编辑，再提交；确实要分开改就拆成两次事务。`,
      )
    }
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
    options: TransactionPlannerPrepareOptions = {},
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
    await this.assertNoAliasedFiles(intents)
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
          if (isString(patch.newContent)) assertWellFormedProjectText(patch.newContent)
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
        patches.push(...withIntentMetadata(chainedPatches, intent))
      } catch (error) {
        if (!(error instanceof ProjectError)) throw error
        const path = operationPath(intent.operation)
        const details: Record<string, unknown> = error.details ?? {}
        const line = toOptional(numberOrNull(details.candidateLine))
        const failedIndex =
          operationIndex + (isNumber(details.rangeIndex) ? details.rangeIndex : 0)
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
            recovery: path ? recoveryRead(path, line) : details.recovery,
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
   * diff 的拼接会把中间态 hunk 叠在一起，行数也被重复计算；模型与界面看到的必须就是将要写下的。
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
          `这个文件改的行数超过项目策略上限（单文件 ${this.dependencies.policy.maxChangedLinesPerFile} 行）：${pathValue}`,
          {
            path: pathValue,
            actual: changedLines,
            maximum: this.dependencies.policy.maxChangedLinesPerFile,
            stage: 'prepare',
            written: false,
          },
          '把这个文件的改动缩小到上限之内；确实要一次改这么多，请用户调整项目策略。',
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
   * 就是 high。能完整回滚的覆盖、删除、重命名是日常写入，与普通编辑一样只按新建与规模分 medium/low。
   * 风险只记进事务与变更记录给界面、审计看，不拦写入、不问人。
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
   * 事务规模的**唯一**判定点：prepare（首次成型）与 amend（追加后重算）都走它。
   * 判据：两条路径此前各写了一份完全相同的检查，任何一侧改阈值/加规则都会留下另一侧的
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
    if (!operation || !TransactionPlanner.QueueRebaseFriendlyOperations.has(operation.type)) return null
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
