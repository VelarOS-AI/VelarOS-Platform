import type {
  ContextCompletionApplicability,
  ContextContent,
  ContextFeedback,
  ContextRef,
  ContextState,
  ContextVerificationReport,
} from '@velaros-ai/context'
import type { ContextRecord } from '@velaros-ai/context'
import { isArray, isEmpty, isPlainObject, isString, isTrue, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelHistoryMessage } from '@velaros-ai/kernel'
import type { ScriptOutputFormat } from '@velaros-ai/script'
import { scriptOutputs } from '@velaros-ai/script'
import type { WorkspaceEntry } from '@velaros-ai/velaros/act/system'

import type {
  ContextMemoryPolicy,
  MemoryFrameDisplay,
  MemoryFrameResult,
  WorkspaceNote,
} from '../types/memory.js'
import type { SegmentFeedback, SegmentHistory, SegmentOutputProof } from '../types/segment.js'

import { decisionStateProjection } from './decision-state.js'
import { ActRuntimeTuning } from './tuning.js'

/** 核查细节优先展示失败和未知；原索引绑定适用性与归档，长项不阻断后续诊断。 */
export function memoryVerificationProjection(
  identity: Readonly<Record<string, unknown>>,
  report: ContextVerificationReport,
  applicability: Optional<Nullable<ContextCompletionApplicability>>,
  maxChars: number
): Record<string, unknown> {
  const ordered = report.checks
    .map((check, index) => ({ check, index }))
    .sort(
      (left, right) =>
        ['failed', 'unknown', 'passed'].indexOf(left.check.status) -
          ['failed', 'unknown', 'passed'].indexOf(right.check.status) || left.index - right.index
    )
  const checks: Array<Record<string, unknown>> = []
  const header = { ...identity }
  const omissions = (selected: ReadonlyArray<Record<string, unknown>>) => {
    const shown = new Set(selected.map((check) => check.index))
    return Object.fromEntries(
      ['passed', 'failed', 'unknown'].map((status) => [
        status,
        report.checks.filter((check, index) => check.status === status && !shown.has(index)).length,
      ])
    )
  }
  const summary = (selected: ReadonlyArray<Record<string, unknown>>) => {
    const projected: Record<string, unknown> = {
      ...header,
      checks: selected,
      omittedChecks: report.checks.length - selected.length,
    }
    if (header.omittedByStatus) projected.omittedByStatus = omissions(selected)
    return projected
  }
  if (JSON.stringify({ ...summary([]), omittedByStatus: omissions([]) }).length <= maxChars)
    header.omittedByStatus = omissions([])
  const read = { ref: identity.ref, offset: 0, limit: ActRuntimeTuning.readChars }
  if (JSON.stringify({ ...summary([]), read }).length <= maxChars) header.read = read
  const fits = (selected: ReadonlyArray<Record<string, unknown>>) =>
    JSON.stringify(summary(selected)).length <= maxChars
  for (const { check, index } of ordered) {
    const candidate = {
      index,
      id: check.id,
      label: check.label,
      status: check.status,
      artifact: check.artifact,
      checkedAt: check.checkedAt ?? report.checkedAt,
      applicability: applicability?.checks[index]?.status ?? 'unknown',
      reusedFrom: check.reusedFrom,
    }
    if (
      JSON.stringify(candidate).length <= ActRuntimeTuning.verificationCheckChars &&
      fits([...checks, candidate])
    ) {
      checks.push(candidate)
      continue
    }
    let labelChars = Math.min(check.label.length, ActRuntimeTuning.verificationLabelChars)
    while (true) {
      const compact = {
        index,
        status: candidate.status,
        applicability: candidate.applicability,
        detailsInReport: true,
        ...(labelChars
          ? {
              label: check.label.slice(0, labelChars),
              ...(labelChars < check.label.length
                ? { labelChars: check.label.length, labelTruncated: true }
                : {}),
            }
          : { labelInReport: true }),
      }
      if (
        JSON.stringify(compact).length <= ActRuntimeTuning.verificationCheckChars &&
        fits([...checks, compact])
      ) {
        checks.push(compact)
        break
      }
      if (!labelChars) break
      labelChars = Math.floor(labelChars / 2)
    }
  }
  const projected: Record<string, unknown> = summary(checks)
  if (JSON.stringify({ ...projected, scope: report.scope }).length <= maxChars)
    projected.scope = report.scope
  return projected
}

/** 固定宿主分区配置并验证所有配额，防止 NaN 或超额正文绕过预算。 */
export function memoryPolicy(input: ContextMemoryPolicy = {}): Required<ContextMemoryPolicy> {
  const result = {
    recentRecords: 8,
    workspaceShare: 0.2,
    recentShare: 0.2,
    stateDetails: 'budgeted' as const,
    ...input,
  }
  if (
    !Number.isSafeInteger(result.recentRecords) ||
    result.recentRecords < 0 ||
    result.recentRecords > 64 ||
    !Number.isFinite(result.workspaceShare) ||
    result.workspaceShare < 0.05 ||
    result.workspaceShare > 0.5 ||
    !Number.isFinite(result.recentShare) ||
    result.recentShare < 0 ||
    result.recentShare > 0.5 ||
    result.workspaceShare + result.recentShare > 0.8 ||
    !['budgeted', 'full'].includes(result.stateDetails)
  )
    throw new AppError('VALIDATION', '上下文分区配置无效')
  return Object.freeze(result)
}

/**
 * 封段时按上一段的缺页调整笔记份额：笔记缺页多就提高，执行结果缺页多而笔记没有就降低，
 * 两边都没有缺页就向宿主配置回落一步；始终在分区配置的合法范围内。
 */
export function adjustedWorkspaceShare(
  share: number,
  faults: { readonly workspace: number; readonly results: number },
  policy: Required<ContextMemoryPolicy>
): number {
  const step = ActRuntimeTuning.shareStep
  const next =
    faults.workspace >= ActRuntimeTuning.shareFaults && faults.workspace >= faults.results
      ? share + step
      : faults.results >= ActRuntimeTuning.shareFaults && faults.workspace === 0
        ? share - step
        : faults.workspace + faults.results === 0
          ? share +
            Math.sign(policy.workspaceShare - share) *
              Math.min(step, Math.abs(policy.workspaceShare - share))
          : share
  const ceiling = Math.min(0.5, 0.8 - policy.recentShare)
  return Math.round(Math.min(ceiling, Math.max(0.05, next)) * 100) / 100
}

/** 目录仅携带稳定键、版本与原文位置，正文按引用独立召回。 */
export function noteEntry(note: WorkspaceNote, record: ContextRecord): WorkspaceEntry {
  return {
    key: note.key,
    revision: note.revision,
    title: note.title,
    ref: record.ref,
    resident: note.resident,
    chars: note.body.length,
  }
}

/** 新文本投影按计量结果直接交付；旧 JSON 材料继续展开原来的块正文。 */
export function memoryOutput(text: string, format: ScriptOutputFormat = 'json'): string {
  if (format === 'text') return text
  const { blocks, ...metadata } = JSON.parse(text)
  return [
    JSON.stringify(metadata),
    ...blocks.flatMap((block: { text?: string }) => {
      const { text, ...metadata } = block
      return [JSON.stringify(metadata), ...(text ? [text] : [])]
    }),
  ].join('\n')
}

/** 同类已确认操作按次数和首尾回执展示，完整决策数据仍保留在调用日志。 */
export function memoryReadGroups(
  items: ReadonlyArray<Record<string, unknown>>,
  keys: readonly string[],
  id: string,
  minCount: number = ActRuntimeTuning.receiptGroupCount
): ReadonlyArray<Record<string, unknown>> {
  const fields = new Set([...keys, id, 'executionId'])
  const eligible = (item: Record<string, unknown>) =>
    item.outcome === 'succeeded' &&
    (item.effect === 'none' || item.effect === 'committed') &&
    isString(item[id]) &&
    Object.keys(item).every((key) => fields.has(key))
  const groups = new Map<string, Array<Record<string, unknown>>>()
  for (const item of items) {
    if (!eligible(item)) continue
    const key = JSON.stringify(keys.map((key) => item[key]))
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  const summaries = new Map<string, Record<string, unknown>>()
  for (const [key, group] of groups) {
    if (group.length < minCount || new Set(group.map((item) => item[id])).size !== group.length)
      continue
    const summary = {
      ...Object.fromEntries(keys.map((key) => [key, group[0][key]])),
      representation: 'grouped-receipts',
      count: group.length,
      firstId: group[0][id],
      lastId: group.at(-1)![id],
    }
    if (JSON.stringify(summary).length < JSON.stringify(group).length) summaries.set(key, summary)
  }
  const emitted = new Set<string>()
  return items.flatMap((item) => {
    if (!eligible(item)) return [item]
    const key = JSON.stringify(keys.map((key) => item[key]))
    const summary = summaries.get(key)
    if (!summary) return [item]
    if (emitted.has(key)) return []
    emitted.add(key)
    return [summary]
  })
}

const completedJobsExplanation =
  'completed-jobs 的 results 按 executionId → resultRef 列出每个成功作业，结果正文仍在历史中。'

/** 连续成功作业按执行身份映射结果引用；只复用明确在历史里的正文，保留每个身份与顺序。 */
export function memoryJobGroups(
  jobs: ReadonlyArray<Record<string, unknown>>,
  history: ReadonlySet<string>
): ReadonlyArray<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = []
  const pending: Array<Record<string, unknown>> = []
  const flush = () => {
    if (isEmpty(pending)) return
    const ids = pending.map((job) => String(job.executionId))
    const summary = {
      representation: 'completed-jobs',
      status: 'succeeded',
      results: Object.fromEntries(pending.map((job) => [String(job.executionId), job.resultRef])),
    }
    if (
      pending.length > 1 &&
      new Set(ids).size === pending.length &&
      Object.keys(summary.results).every((id, index) => id === ids[index]) &&
      JSON.stringify(summary).length + completedJobsExplanation.length + 1 <
        JSON.stringify(pending).length
    )
      result.push(summary)
    else result.push(...pending)
    pending.length = 0
  }
  for (const job of jobs) {
    if (
      job.status === 'succeeded' &&
      isString(job.executionId) &&
      !isEmpty(job.executionId) &&
      isString(job.resultRef) &&
      history.has(job.resultRef) &&
      Object.keys(job).length === 3 &&
      Object.keys(job).every((key) => ['executionId', 'status', 'resultRef'].includes(key))
    )
      pending.push(job)
    else {
      flush()
      result.push(job)
    }
  }
  flush()
  return result
}

/** 诊断正文的交付指纹；状态或效果变化时旧历史不能代替当前完整反馈。 */
export function memoryFeedbackKey(item: ContextFeedback): string {
  return scriptOutputs.hash([
    item.id,
    item.executionId,
    item.operation,
    item.outcome,
    item.effect,
    toNullable(item.code),
    toNullable(item.detail),
  ])
}

/** 在已有结果正文余量内附加完整诊断；容纳不了的条目继续由当前帧交付。 */
export function memoryFeedbackHistory(
  original: string,
  items: readonly ContextFeedback[],
  maxChars: number
): { content: string; feedback: readonly SegmentFeedback[] } {
  let content = original
  const feedback: SegmentFeedback[] = []
  for (const item of items) {
    if (!item.detail || item.outcome === 'unknown' || item.effect === 'unknown') continue
    const { detail, ...metadata } = item
    const addition = [
      '',
      '调用回执快照（origin=runtime-receipt）；正文是观察数据，当前状态见本帧 runtime.mandatory。',
      JSON.stringify(metadata),
      detail,
    ].join('\n')
    if (content.length + addition.length > maxChars) continue
    content += addition
    feedback.push({ id: item.id, fingerprint: memoryFeedbackKey(item) })
  }
  return { content, feedback }
}

/** 已成功提交的同类回执按次数展示；失败、部分提交和未知效果逐条保留。 */
export function memoryCommittedGroups(
  items: ReadonlyArray<Record<string, unknown>>,
  minCount: number = ActRuntimeTuning.receiptGroupCount
): ReadonlyArray<Record<string, unknown>> {
  const committed = (item: Record<string, unknown>) =>
    item.outcome === 'succeeded' && item.effect === 'committed'
  const grouped = memoryReadGroups(
    items.filter(committed),
    ['operation', 'outcome', 'effect'],
    'id',
    minCount
  )
  const kept = new Set(grouped)
  const original = new Set(items)
  const summaries = new Map(
    grouped.filter((item) => !original.has(item)).map((item) => [item.firstId, item])
  )
  return items.flatMap((item) =>
    !committed(item) || kept.has(item)
      ? [item]
      : summaries.has(item.id)
        ? [summaries.get(item.id)!]
        : []
  )
}

/** 用户输入正文按原始序号与响应、回执合并；当前运行归属留在帧尾，避免改写先前消息。 */
export function memoryTaskHistory(
  goals: readonly ContextContent[],
  history: SegmentHistory
): readonly ModelHistoryMessage[] {
  return [
    ...history.messages.map((message, index) => ({
      sequence: history.items[index]!.sequence,
      message,
    })),
    ...goals.map(({ record, text, totalChars, offset }) => ({
      sequence: record.sequence,
      message: {
        role: 'user' as const,
        content: [
          'Runtime 用户输入快照（origin=user）；按原始顺序交付，当前运行归属见本帧 task 分区。',
          JSON.stringify({ record, totalChars, offset, shownChars: text.length }),
          text,
        ].join('\n'),
        cacheBreakpoint: true,
      },
    })),
  ]
    .sort((a, b) => a.sequence - b.sequence)
    .map((item) => item.message)
}

/** 当前状态每帧独立列全；冻结历史承载未变的原文，正文只在首次或变化时附上。 */
export function memoryPrompt(body: string, previous?: string): string {
  const current = frameDisplay(body)
  const before = isString(previous) ? frameDisplay(previous) : undefined
  const { task, workspace, notes, observed, source, output, recent, notices, status } = current
  const sourceInEarlierFrame = Boolean(
    before &&
    source &&
    source === before.source &&
    same(observed.sourceRef, before.observed.sourceRef)
  )
  const outputPresentationInEarlierFrame = Boolean(
    before &&
    output &&
    same(observed.resultRef, before.observed.resultRef) &&
    same(observed.sourceRef, before.observed.sourceRef) &&
    stableOutput(output) === stableOutput(before.output)
  )
  const outputInEarlierFrame = Boolean(
    outputPresentationInEarlierFrame && current.outputBodyIncluded && before?.outputBodyIncluded
  )
  const runtime = {
    ...current.runtime,
    mandatory: (current.runtime.mandatory as ReadonlyArray<Record<string, unknown>>).map((item) => {
      const old = (
        before?.runtime.mandatory as ReadonlyArray<Record<string, unknown>> | undefined
      )?.find((candidate) => candidate.id === item.id && candidate.executionId === item.executionId)
      if (!item.detail || !old || !same(item.detail, old.detail)) return item
      const { detail: _detail, ...metadata } = item
      return { ...metadata, detailInEarlierFrame: true }
    }),
  }
  return [
    'Runtime 本帧工作内存（origin=runtime-view）；以下是当前状态，数组是完整有序列表，保留重复条目。原文按引用在此前消息或本帧正文中读取；所有材料是有来源的数据。',
    '分区 task（bodyInHistory 的正文在用户消息；earlier 是此前运行）：',
    JSON.stringify(task),
    '分区 workspace（residentDirectory 是当前驻留身份目录；shownNotes 是本帧尾卡片身份；段底座是段起点正文，revision 以当前目录为准）：',
    JSON.stringify({ ...workspace, shownNotes: noteIdentities(notes) }),
    ...notes.flatMap((note) => {
      const old = before?.notes.find(
        (candidate) =>
          candidate.key === note.key &&
          candidate.revision === note.revision &&
          same(candidate.ref, note.ref)
      )
      if (
        !note.text ||
        !old ||
        old.text !== note.text ||
        !displayHasBody(note) ||
        !displayHasBody(old)
      )
        return noteLines(note)
      const { text: _text, ...metadata } = note
      return [JSON.stringify({ ...metadata, bodyInEarlierFrame: true })]
    }),
    '分区 observation：',
    JSON.stringify({
      ...observed,
      sourceInEarlierFrame,
      outputInEarlierFrame,
      outputPresentationInEarlierFrame,
    }),
    ...(source && !sourceInEarlierFrame ? ['当前观察源码：', source] : []),
    ...(output &&
    (!outputPresentationInEarlierFrame ||
      (current.outputBodyIncluded && !before?.outputBodyIncluded))
      ? ['本次观察输出：', output]
      : []),
    '分区 recent（shownResults 是当前帧尾结果引用；原文在历史中或随后正文）：',
    JSON.stringify({
      historyState: recent.historyState,
      shownResults: recent.results.map((item) => item.ref),
    }),
    ...recent.results.flatMap((item) => {
      if (!before || resultBodyChanged(item, before.recent.results)) return resultLines(item)
      const old = before.recent.results.find((candidate) => candidate.ref === item.ref)!
      const { text: _text, source: _source, ...metadata } = item
      return [
        JSON.stringify({
          ...metadata,
          bodyInEarlierFrame: Boolean(item.text) && displayHasBody(item) && displayHasBody(old),
          presentationInEarlierFrame: Boolean(item.text),
          sourceInEarlierFrame: Boolean(item.source),
        }),
      ]
    }),
    '分区 runtime：',
    JSON.stringify(runtime),
    ...notices.detail,
    'grouped-receipts 保留计数和首尾 ID；完整回执在 frameId 对应的运行记录。',
    ...notices.jobs,
    '内存状态：',
    JSON.stringify(status),
  ].join('\n')
}

/** 消息正文身份忽略缓存标记，仍绑定角色、原样内容与延续状态。 */
export function memoryMessageKey(message: ModelHistoryMessage): string {
  const { cacheBreakpoint: _cacheBreakpoint, ...identity } = message
  return scriptOutputs.hash(identity)
}

/** 与正文渲染共用变化判据；只返回本次确实输出正文的结果引用。 */
export function memoryOutputRefs(body: string, previous?: string): readonly string[] {
  const current = frameDisplay(body)
  const before = isString(previous) ? frameDisplay(previous) : undefined
  return current.recent.results
    .filter(
      (item) =>
        item.text &&
        displayHasBody(item) &&
        (!before || resultBodyChanged(item, before.recent.results))
    )
    .map((item) => item.ref)
}

/** 同一来源、块和表示的无孔页覆盖；初始摘录及另一种表示不能补齐范围。 */
export function memoryDeliveredOutputs(proofs: readonly SegmentOutputProof[]): Set<string> {
  const delivered = new Set(
    proofs
      .filter((proof) => !proof.range)
      .map((proof) => JSON.stringify([proof.ref, proof.key, proof.contentHash]))
  )
  const ranges = new Map<string, SegmentOutputProof[]>()
  for (const proof of proofs) {
    if (!proof.range) continue
    const key = JSON.stringify([
      proof.ref,
      proof.key,
      proof.contentHash,
      proof.range.pointer,
      proof.range.totalChars,
    ])
    const group = ranges.get(key)
    if (group) group.push(proof)
    else ranges.set(key, [proof])
  }
  for (const group of ranges.values()) {
    let through = 0
    for (const proof of group.sort((left, right) => left.range!.offset - right.range!.offset)) {
      if (proof.range!.offset > through) break
      through = Math.max(through, proof.range!.offset + proof.range!.chars)
    }
    if (through === group[0]!.range!.totalChars) {
      const first = group[0]!
      delivered.add(JSON.stringify([first.ref, first.key, first.contentHash]))
    }
  }
  return delivered
}

/** 同一实际消息内合并相同证明，不同载体或页范围仍分别保留。 */
export function memoryProofCarriers(
  carriers: ReadonlyArray<{ message: string; proofs: readonly SegmentOutputProof[] }>
) {
  const messages = new Map<string, Map<string, SegmentOutputProof>>()
  for (const carrier of carriers) {
    const proofs = messages.get(carrier.message) ?? new Map<string, SegmentOutputProof>()
    messages.set(carrier.message, proofs)
    for (const proof of carrier.proofs)
      proofs.set(
        JSON.stringify([
          proof.ref,
          proof.key,
          proof.contentHash,
          proof.carrierRef,
          proof.range?.pointer,
          proof.range?.offset,
          proof.range?.chars,
          proof.range?.totalChars,
        ]),
        proof
      )
  }
  return [...messages].map(([message, proofs]) => ({ message, proofs: [...proofs.values()] }))
}

/** 一帧按展示口径整理好的当前状态与正文身份。 */
function frameDisplay(body: string): MemoryFrameDisplay {
  const frame = JSON.parse(body)
  const { task, workspace, observation, recent, runtime } = frame.partitions
  const { source, text, blocks: _blocks, ...observed } = observation
  const { notes, ...workspaceState } = workspace
  const taskDisplay = {
    ...task,
    goals: task.goals.map(
      (goal: ContextContent & { bodyInHistory?: boolean; earlier?: boolean }) =>
        goal.bodyInHistory
          ? {
              ref: goal.record.ref,
              sequence: goal.record.sequence,
              earlier: Boolean(goal.earlier),
              bodyInHistory: true,
              offset: goal.offset,
              shownChars: goal.text.length,
              totalChars: goal.totalChars,
            }
          : goal
    ),
  }
  const mandatory = memoryReadGroups(
    runtime.mandatory.map((item: ContextFeedback & { detailInHistory?: string }) => {
      if (!item.detailInHistory) return item
      const { detail: _detail, ...metadata } = item
      return metadata
    }),
    ['operation', 'outcome', 'effect'],
    'id',
    2
  )
  let runtimeDisplay: Record<string, unknown> = { ...runtime, mandatory }
  if (
    isPlainObject(frame.memoryStatus.decisionState) &&
    isPlainObject(frame.memoryStatus.decisionState.ref)
  ) {
    const state = frame.memoryStatus.decisionState
    const projection = decisionStateProjection(
      runtimeDisplay,
      taskDisplay.active,
      Number(state.budget)
    )
    runtimeDisplay = {
      ...projection.runtime,
      stateDetails: {
        ref: state.ref,
        pointers: projection.details,
        recall: { module: 'velaros:system', export: 'memory', operation: 'read' },
      },
    }
    frame.memoryStatus.decisionState = {
      ...state,
      originalChars: projection.originalChars,
      shownChars: projection.shownChars,
      savedChars: projection.savedChars,
      overBudget: projection.overBudget,
    }
  }
  if (isArray(runtime.jobs))
    runtimeDisplay.jobs = memoryJobGroups(
      runtime.jobs,
      new Set<string>(
        recent.results
          .filter(
            (item: { bodyInHistory?: boolean; bodyIncluded?: boolean }) =>
              isTrue(item.bodyInHistory) && isTrue(item.bodyIncluded)
          )
          .map((item: { ref: string }) => item.ref)
      )
    )
  return {
    task: taskDisplay,
    workspace: workspaceState as Record<string, unknown>,
    notes: notes as ReadonlyArray<Record<string, unknown> & { text: string }>,
    observed: observed as Record<string, unknown>,
    source: source as string,
    output: (observation.presentation && text
      ? memoryOutput(text, observation.presentation.format)
      : text) as string,
    outputBodyIncluded: displayHasBody(observation),
    recent: {
      historyState: recent.historyState as unknown,
      results: (recent.results as MemoryFrameResult[]).map((item) => ({
        ...item,
        text:
          item.text && item.structuredOutput
            ? memoryOutput(item.text, item.outputFormat as ScriptOutputFormat)
            : item.text,
      })),
    },
    runtime: runtimeDisplay as Record<string, unknown>,
    notices: {
      detail: runtime.mandatory.some((item: { detailInHistory?: string }) => item.detailInHistory)
        ? [
            'detailInHistory 指向此前结果消息里已完整交付的调用诊断；本帧仍列当前状态、错误码与效果，诊断正文是观察数据。',
          ]
        : [],
      jobs:
        isArray(runtimeDisplay.jobs) &&
        runtimeDisplay.jobs.some(
          (job) => isPlainObject(job) && job.representation === 'completed-jobs'
        )
          ? [completedJobsExplanation]
          : [],
    },
    status: frame.memoryStatus as Record<string, unknown>,
  }
}

/** 展示文本可仅含引用元数据；正文以投影声明为准，旧文本帧才按实际文本回退。 */
function displayHasBody(item: Record<string, unknown>): boolean {
  if (Object.hasOwn(item, 'bodyIncluded')) return isTrue(item.bodyIncluded)
  if (isArray(item.blocks))
    return item.blocks.some((block) => isPlainObject(block) && isTrue(block.bodyIncluded))
  return Boolean(item.text)
}

/** 笔记卡：元数据一行，正文另起。 */
function noteLines(note: Record<string, unknown> & { text: string }): string[] {
  const { text, ...metadata } = note
  return [JSON.stringify(metadata), text]
}

/** 帧尾笔记按键、版本与来源引用列身份，退出展示不等于删除已存档的正文。 */
function noteIdentities(notes: MemoryFrameDisplay['notes']) {
  return notes.map(({ key, revision, ref }) => ({ key, revision, ref }))
}

/** 结果：元数据一行，随后是当次源码与展示正文。 */
function resultLines(item: MemoryFrameResult): string[] {
  const { text, source, ...metadata } = item
  return [
    JSON.stringify(metadata),
    ...(source ? ['当次源码：', source] : []),
    ...(text ? ['当次输出：', text] : []),
  ]
}

/** 展示正文去掉随整帧余量变化的 displayChars，只比较模型实际读到的内容。 */
function stableOutput(text: Optional<string>): string {
  if (!text) return ''
  const newline = text.indexOf('\n')
  const head = newline < 0 ? text : text.slice(0, newline)
  if (!head.startsWith('{"omittedBlocks":')) return text
  return head.replace(/,"displayChars":\d+/u, '') + (newline < 0 ? '' : text.slice(newline))
}

/** 同一结果的源码或展示正文改变时才再次输出正文。 */
function resultBodyChanged(
  item: MemoryFrameResult,
  previous: readonly MemoryFrameResult[]
): boolean {
  const old = previous.find((candidate) => candidate.ref === item.ref)
  return (
    !old ||
    item.source !== old.source ||
    stableOutput(item.text) !== stableOutput(old.text) ||
    (displayHasBody(item) && !displayHasBody(old))
  )
}

/** 两个 JSON 值的序列化结果相同。 */
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** 授权当前代次的原文，以及用户在当前代次明确重新附上的材料。 */
export function memoryReference(state: Nullable<ContextState>, ref: ContextRef) {
  const reset = Math.max(
    state?.task?.startedSequence ?? 0,
    state?.records.findLast((record) => record.title === 'search:history-reset')?.sequence ?? 0
  )
  const record = state?.records.find(
    (item) => item.ref.sessionId === ref.sessionId && item.ref.id === ref.id
  )
  if (!record) return undefined
  if (
    record.sequence > reset &&
    (!record.title.startsWith('context:decision-state:') ||
      record.title === `context:decision-state:${state?.task?.id ?? 'none'}:${reset}`)
  )
    return record
  return state!.records.some(
    (item) =>
      item.sequence > reset &&
      item.kind === 'user' &&
      item.sources.some((source) => source.sessionId === ref.sessionId && source.id === ref.id)
  )
    ? record
    : undefined
}
