/**
 * 紧凑工具行的「作用对象」摘要（纯函数）：通用摘要只认路径、命令、查询词这类字段，计划、目标、
 * 浏览器检查、调度、工作台……很多工具的参数里没有这些，行上就只剩工具名。这里按工具名登记读取器，
 * 从参数（参数里没有时再看结果）里点出这次调用作用在什么上、改成了什么：行内一句短话，悬停详情另给
 * 更完整的几行。
 *
 * 规矩：只读参数与结果里真有的字段，读不出就返回 null，调用方回落到通用摘要；长文本一律折成单行并截断，
 * 不把整段载荷搬进界面。状态、动作之类的标识原样展示，与悬停详情里的操作标签一致，不逐项翻译。
 */
import { getPlanToolBlockExplanation, getPlanToolBlockSteps } from './plan/planToolBlock'
import { getToolOperations } from './toolOperationSummary'

import type { ToolCallBlock } from '#contracts'
import {
  isArray,
  isBoolean,
  isEmpty,
  isFiniteNumber,
  isNonBlankString,
  isPresent,
  isTrue,
  toNullable,
  truncate,
} from '#internal/runtime'
import {
  asRecord,
  readBoolean,
  readFirstString,
  readNumber,
  readRecordsArray,
  readString,
  readStringArray,
  readStringScalar,
} from '#internal/unknownJsonRecord'

/** 一次工具调用的作用对象摘要。 */
export interface ToolTargetSummary {
  /** 行内的一句话；缺省时行内交给通用摘要或结果计数。 */
  target?: string
  /** 悬停详情里比行内更完整的补充行，按顺序展示。 */
  details?: string[]
}

type RecordValue = Record<string, unknown>

interface TargetReadContext {
  args: RecordValue
  /** 结果是对象时才有；纯文本结果（子 Agent 汇报、后台任务输出）不读。 */
  result: Nullable<RecordValue>
  formatPath: (path: string) => string
}

type ToolTargetReader = (context: TargetReadContext) => Nullable<ToolTargetSummary>

interface StepPreview {
  title: string
  status: string
  objective: Nullable<string>
}

// 行内一句话的上限：CSS 还会按行宽加省略号，这里只防整段载荷进 DOM。
const MaxTargetChars = 120
// 悬停详情里单行的上限。
const MaxDetailChars = 400
// 列表类详情最多列出的项数（计划、目标步骤最多 12 步）。
const MaxListedItems = 12
const PartSeparator = ' · '
const ListSeparator = ', '
const TerminalStepStatuses = new Set(['completed', 'skipped', 'failed'])
const ActiveStepStatuses = new Set(['in_progress', 'running', 'delegated'])

function clipText(value: unknown, maxChars = MaxTargetChars): Nullable<string> {
  const text = readStringScalar(value)
  if (!text) return null

  return truncate(text.replaceAll(/\s+/gu, ' '), maxChars)
}

function clipDetail(value: unknown): Nullable<string> {
  return clipText(value, MaxDetailChars)
}

function joinParts(parts: ReadonlyArray<LooseOptional<string>>): Nullable<string> {
  const present = parts.filter((part): part is string => isNonBlankString(part))
  return isEmpty(present) ? null : present.join(PartSeparator)
}

/** 多个对象只点名第一个，其余用 `+N` 计数，与紧凑行的文件列表写法一致。 */
function describeFirstOfList(values: readonly string[]): Nullable<string> {
  const [firstValue] = values
  if (!firstValue) return null

  return values.length > 1 ? `${firstValue} +${values.length - 1}` : firstValue
}

function toSummary(
  target: LooseOptional<string>,
  details: ReadonlyArray<LooseOptional<string>> = []
): Nullable<ToolTargetSummary> {
  const presentDetails = details.filter((detail): detail is string => isNonBlankString(detail))
  if (!isNonBlankString(target) && isEmpty(presentDetails)) return null

  const summary: ToolTargetSummary = {}
  if (isNonBlankString(target)) summary.target = target
  if (!isEmpty(presentDetails)) summary.details = [...new Set(presentDetails)]
  return summary
}

function readPath(record: Nullable<RecordValue>, key: string, context: TargetReadContext): Nullable<string> {
  const path = readString(record, key)
  return path ? context.formatPath(path) : null
}

function readPathList(record: Nullable<RecordValue>, key: string, context: TargetReadContext): string[] {
  return readStringArray(record, key).map(context.formatPath)
}

/** `true` / `false` 原样写成 `key: value`，不替参数编一个动词。 */
function describeFlag(record: Nullable<RecordValue>, key: string): Nullable<string> {
  const value = readBoolean(record, key)
  return isBoolean(value) ? `${key}: ${String(value)}` : null
}

function describeCoordinates(record: Nullable<RecordValue>): Nullable<string> {
  const x = readNumber(record, 'x')
  const y = readNumber(record, 'y')
  return isPresent(x) && isPresent(y) ? `${x}, ${y}` : null
}

function describeSize(record: Nullable<RecordValue>): Nullable<string> {
  const width = readNumber(record, 'width')
  const height = readNumber(record, 'height')
  return isPresent(width) && isPresent(height) ? `${width}×${height}` : null
}

/** 路径带行号：`src/a.ts:12`、`src/a.ts:12-30`。 */
function describeLocation(
  path: Nullable<string>,
  startLine: Nullable<number>,
  endLine: Nullable<number>
): Nullable<string> {
  if (!path) return null
  if (!isPresent(startLine)) return path

  return isPresent(endLine) && endLine !== startLine
    ? `${path}:${startLine}-${endLine}`
    : `${path}:${startLine}`
}

// ---- 步骤（计划 / 目标） ----

/**
 * 步骤目标只是「写到 system / session 工作区」这类落点说明时不值得展示（与计划卡的取舍一致）。
 * 英文短语按 ASCII 词边界匹配，免得 `nonsystem workspacey` 这种词中子串误判。
 */
function isWorkspaceTargetText(text: string): boolean {
  const normalized = text.replaceAll(/\s+/gu, ' ').trim().toLowerCase()
  if (!normalized) return false

  const chineseAction = ['写入', '保存', '输出', '生成到'].find((value) => normalized.startsWith(value))
  if (chineseAction)
    return (
      ['system', '系统', 'session', '会话'].some((value) => normalized.includes(value, chineseAction.length)) &&
      (normalized.endsWith('工区') || normalized.endsWith('工作区'))
    )

  const englishAction = ['write', 'save', 'output', 'export'].some((value) => normalized.startsWith(value))
  return (
    englishAction &&
    (includesAsciiWordPhrase(normalized, 'system workspace') ||
      includesAsciiWordPhrase(normalized, 'system work area'))
  )
}

function includesAsciiWordPhrase(value: string, phrase: string): boolean {
  let cursor = 0
  while (cursor <= value.length - phrase.length) {
    const index = value.indexOf(phrase, cursor)
    if (index < 0) return false
    if (!isAsciiWordCharacter(value[index - 1]) && !isAsciiWordCharacter(value[index + phrase.length]))
      return true
    cursor = index + 1
  }
  return false
}

function isAsciiWordCharacter(value: LooseOptional<string>): boolean {
  return !!value && /^\w$/u.test(value)
}

function readStepRecords(value: unknown): StepPreview[] {
  if (!isArray(value)) return []

  return value.flatMap((item): StepPreview[] => {
    const record = asRecord(item)
    const title = readFirstString(record?.title, record?.step)
    if (!title) return []

    return [{ title, status: readString(record, 'status') ?? 'pending', objective: readString(record, 'objective') }]
  })
}

/** 已完成 / 总数：跳过与失败也算走完了这一步。 */
function describeProgress(steps: readonly StepPreview[]): Nullable<string> {
  if (isEmpty(steps)) return null

  const done = steps.filter((step) => TerminalStepStatuses.has(step.status)).length
  return `${done}/${steps.length}`
}

/** 正在做的一步；都没开始时是第一个待办。 */
function findCurrentStep(steps: readonly StepPreview[]): Nullable<StepPreview> {
  return toNullable(
    steps.find((step) => ActiveStepStatuses.has(step.status)) ??
      steps.find((step) => step.status === 'pending')
  )
}

function formatStepLines(steps: readonly StepPreview[]): string[] {
  return steps.slice(0, MaxListedItems).map((step, index) => {
    const objective =
      step.objective && step.objective !== step.title && !isWorkspaceTargetText(step.objective)
        ? step.objective
        : null
    return clipDetail(joinParts([`${index + 1}. [${step.status}] ${step.title}`, objective])) ?? ''
  })
}

/**
 * `complete_step` 点名的步骤：结果里回带了被完成的步骤就用它的标题；还没有结果时按引用解析——
 * 数字是 1 起的序号，文字就是标题本身；解析不了的序号原样写成 `#n`。
 */
function describeCompletedSteps(
  stepRefs: unknown,
  completedRecords: readonly unknown[],
  steps: readonly StepPreview[]
): Nullable<string> {
  const completedTitles = completedRecords.flatMap((record) => {
    const title = readFirstString(asRecord(record)?.step, asRecord(record)?.title)
    return title ? [title] : []
  })
  if (!isEmpty(completedTitles)) return describeFirstOfList(completedTitles)

  const refs = isArray(stepRefs) ? stepRefs : [stepRefs]
  const titles = refs.flatMap((ref) => {
    if (isFiniteNumber(ref)) return [steps[ref - 1]?.title ?? `#${ref}`]
    const title = readStringScalar(ref)
    return title ? [title] : []
  })
  return describeFirstOfList(titles)
}

function describeCompletion(completed: Nullable<string>): Nullable<string> {
  return completed ? `${clipText(completed)} → completed` : null
}

function readRecordList(value: unknown): RecordValue[] {
  if (!isArray(value)) return []

  return value.flatMap((item) => {
    const record = asRecord(item)
    return record ? [record] : []
  })
}

/** 目标约束：`[类型] 标题`。 */
function formatConstraintLines(value: unknown): string[] {
  return readRecordList(value)
    .slice(0, MaxListedItems)
    .map((record) => {
      const title = readString(record, 'title')
      const type = readString(record, 'directiveType')
      return clipDetail(type && title ? `[${type}] ${title}` : title) ?? ''
    })
}

// ---- 规划：计划、目标、方案、指令 ----

function readPlanUpdate({ args, result }: TargetReadContext): Nullable<ToolTargetSummary> {
  const steps = getPlanToolBlockSteps({ args, result })
  const completed = describeCompletedSteps(args.complete_step, readRecordsArray(result, 'completedSteps'), steps)
  const hasCompletion = isPresent(args.complete_step) && !(isArray(args.complete_step) && isEmpty(args.complete_step))
  const explanation = getPlanToolBlockExplanation({ args, result })
  const target = joinParts([
    readStringScalar(args.lifecycle),
    describeProgress(steps),
    hasCompletion ? describeCompletion(completed) : clipText(findCurrentStep(steps)?.title),
  ])

  return toSummary(target ?? clipText(explanation), [clipDetail(explanation), ...formatStepLines(steps)])
}

function readPlanGet({ args, result }: TargetReadContext): Nullable<ToolTargetSummary> {
  const steps = getPlanToolBlockSteps({ args, result })
  const lifecycle = readString(result, 'lifecycle')

  return toSummary(
    joinParts([
      lifecycle === 'active' ? null : lifecycle,
      describeProgress(steps),
      clipText(findCurrentStep(steps)?.title),
    ]),
    formatStepLines(steps)
  )
}

function readGoalSteps(args: RecordValue, goal: Nullable<RecordValue>): StepPreview[] {
  const resultSteps = readStepRecords(goal?.steps)
  return isEmpty(resultSteps) ? readStepRecords(args.steps) : resultSteps
}

function readGoalCreate({ args, result }: TargetReadContext): Nullable<ToolTargetSummary> {
  const goal = asRecord(result?.goal)
  const objective = readFirstString(goal?.objective, args.objective)

  return toSummary(clipText(objective), [
    clipDetail(objective),
    ...formatStepLines(readGoalSteps(args, goal)),
    ...formatConstraintLines(args.constraints ?? goal?.constraints),
  ])
}

function readGoalUpdate({ args, result }: TargetReadContext): Nullable<ToolTargetSummary> {
  const goal = asRecord(result?.goal)
  const steps = readGoalSteps(args, goal)
  const status = readStringScalar(args.status)
  const completion = isPresent(args.complete_step)
    ? describeCompletion(describeCompletedSteps(args.complete_step, [result?.completedStep], steps))
    : null
  const progress =
    !status && !completion && isArray(args.steps)
      ? joinParts([describeProgress(steps), clipText(findCurrentStep(steps)?.title)])
      : null
  // 状态变化要说明是哪个目标，目标内容取结果里的；只改了约束时点名第一条约束。
  const objective = readFirstString(args.objective, status ? goal?.objective : null)
  const constraint =
    !status && !completion && !progress && !objective
      ? describeFirstOfList(readRecordList(args.constraints).flatMap((record) => readString(record, 'title') ?? []))
      : null

  return toSummary(joinParts([status, completion, progress, clipText(objective), constraint]), [
    clipDetail(readFirstString(goal?.objective, args.objective)),
    ...formatStepLines(steps),
    ...formatConstraintLines(args.constraints ?? goal?.constraints),
  ])
}

function readGoalGet({ result }: TargetReadContext): Nullable<ToolTargetSummary> {
  const goal = asRecord(result?.goal)
  const objective = readString(goal, 'objective')

  return toSummary(joinParts([readString(result, 'status'), clipText(objective)]), [
    clipDetail(objective),
    ...formatStepLines(readStepRecords(goal?.steps)),
  ])
}

function readProposalGet(context: TargetReadContext): Nullable<ToolTargetSummary> {
  const proposal = asRecord(context.result?.proposal)

  return toSummary(joinParts([readString(context.result, 'status'), clipText(proposal?.title)]), [
    clipDetail(proposal?.summary),
    readPath(proposal, 'documentPath', context),
    clipDetail(proposal?.feedback),
  ])
}

function readProposalReview(context: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(context.args.title), [
    clipDetail(context.args.summary),
    readPath(context.args, 'document_path', context),
    clipDetail(context.result?.feedback),
  ])
}

function readDirectiveList({ result }: TargetReadContext): Nullable<ToolTargetSummary> {
  // 行内交给结果计数；详情列出每条指令的标题。
  return toSummary(
    null,
    readRecordsArray(result, 'directives')
      .slice(0, MaxListedItems)
      .map((directive) => clipDetail(directive.title) ?? '')
  )
}

function readDirectiveUpsert({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(args.title), [clipDetail(args.content)])
}

function readDirectiveArchive({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(
    clipText(args.title) ?? readStringScalar(args.directiveType) ?? describeFirstOfList(readStringArray(args, 'ids'))
  )
}

// ---- 工具空间、上下文、子 Agent、后台任务、确认 ----

function readToolingMap({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(
    clipText(args.query) ??
      describeFirstOfList(readStringArray(args, 'categoryIds')) ??
      describeFirstOfList(readStringArray(args, 'domainIds')) ??
      describeFirstOfList(readStringArray(args, 'ids')) ??
      joinParts([readString(args, 'kind'), describeFirstOfList(readStringArray(args, 'toolOsStates'))])
  )
}

function readContextRecall({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(args.query) ?? joinParts([readString(args, 'ref'), readString(args, 'jsonPath')]), [
    clipDetail(args.reason),
  ])
}

function readContextHandoff({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(args.reason), [clipDetail(args.reason)])
}

function readAgentDispatch({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(
    joinParts([readString(args, 'agent_name'), clipText(args.description)]) ??
      readString(args, 'thread_id') ??
      clipText(args.prompt),
    [clipDetail(args.prompt)]
  )
}

function readAgentWorkflow({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(args.name))
}

function readBackgroundJob({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  const jobIds = readStringArray(args, 'job_ids')
  const filter = readString(args, 'filter')

  return toSummary(readString(args, 'job_id') ?? describeFirstOfList(jobIds), [
    ...(jobIds.length > 1 ? jobIds : []),
    filter ? `filter: ${filter}` : null,
  ])
}

function readMessageTarget({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(args.message), [clipDetail(args.message)])
}

// ---- 与用户交互（提问、动作卡、指南、反馈） ----

function readAskUser({ args, result }: TargetReadContext): Nullable<ToolTargetSummary> {
  const questions = readRecordsArray(args, 'questions')
  const answers = readRecordsArray(result, 'answers')
  const labels = questions.flatMap((question) => readFirstString(question.header, question.question) ?? [])

  return toSummary(
    clipText(describeFirstOfList(labels)),
    questions.map((question, index) => {
      const answer = answers[index]
      const selected = joinListValues([...readStringArray(answer, 'selected'), readString(answer, 'freeText')])
      return clipDetail(joinArrow(readFirstString(question.question, question.header), selected)) ?? ''
    })
  )
}

function joinListValues(values: ReadonlyArray<LooseOptional<string>>): Nullable<string> {
  const present = values.filter((value): value is string => isNonBlankString(value))
  return isEmpty(present) ? null : present.join(ListSeparator)
}

function joinArrow(from: Nullable<string>, to: Nullable<string>): Nullable<string> {
  if (from && to) return `${from} → ${to}`
  return from ?? to
}

function readActionCards({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  const cards = readRecordsArray(args, 'cards')
  const titles = cards.flatMap((card) => readString(card, 'title') ?? [])

  return toSummary(
    clipText(describeFirstOfList(titles)),
    cards
      .slice(0, MaxListedItems)
      .map((card) => clipDetail(joinParts([readString(card, 'title'), readString(card, 'description')])) ?? '')
  )
}

/** 标记的待办：标题，详情是一句话摘要与涉及的文件。 */
function readFlaggedTask(context: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(context.args.title), [
    clipDetail(context.args.tldr),
    describeFirstOfList(readPathList(context.args, 'files', context)),
  ])
}

function readGuideModules({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(joinParts(readStringArray(args, 'modules')))
}

// ---- Desktop 协作、定时任务、媒体生成 ----

function readPeerSend({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(joinParts([readString(args, 'to_session_id'), clipText(args.message)]), [clipDetail(args.message)])
}

function readPeerSpawn({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(args.purpose), [clipDetail(args.purpose), clipDetail(args.initial_task)])
}

function readScheduleProposal({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(args.name), [
    clipDetail(readFirstString(args.scheduleText, args.rrule)),
    clipDetail(args.prompt),
  ])
}

function readScheduledTask({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(readFirstString(args.name, args.taskId)))
}

function readPromptTarget({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(args.prompt), [clipDetail(args.prompt)])
}

// ---- 桌面控制、系统 ----

function readCoordinates({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(describeCoordinates(args))
}

function readTypedText({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(args.text), [clipDetail(args.text)])
}

function readKeys({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(readString(args, 'keys'))
}

function readScreenSize({ result }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(describeSize(result))
}

function readSystemProcesses({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  const port = readNumber(args, 'port')
  const pid = readNumber(args, 'pid')

  return toSummary(
    clipText(args.filter) ??
      readString(args, 'processName') ??
      (isPresent(port) ? `:${port}` : null) ??
      (isPresent(pid) ? `pid ${pid}` : null) ??
      joinParts(readStringArray(args, 'include'))
  )
}

function readTaskId({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(readString(args, 'taskId'))
}

/** Office 文档工具：输入 → 输出，只有一端时就是那一端。 */
function readOfficeDocument(context: TargetReadContext): Nullable<ToolTargetSummary> {
  const inputPath = readPath(context.args, 'inputPath', context)
  const outputPath = readPath(context.args, 'outputPath', context)

  return toSummary(joinArrow(inputPath, outputPath), [
    clipDetail(context.args.title),
    readPath(context.args, 'sourcePath', context),
  ])
}

// ---- 记忆与知识库 ----

function readMemoryGet({ args, result }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(readFirstString(asRecord(result?.memory)?.title, args.id)), [clipDetail(args.id)])
}

function readMemoryArchive({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(args.id), [clipDetail(args.reason)])
}

function readKnowledgeSync(context: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(readPath(context.args, 'workspaceRoot', context))
}

// ---- 项目（兼容外部引擎的参数写法） ----

/** 列目录：范围加匹配模式（外部引擎的 Glob 映射过来只带 `pattern`）。 */
function readProjectList(context: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(
    joinParts([
      readPath(context.args, 'path', context),
      readString(context.args, 'pattern') ?? describeFirstOfList(readStringArray(context.args, 'include')),
    ])
  )
}

/** 代码查询：先说查什么（符号、查询词、节点、任务……），都没有时说查的是哪个文件，再不行点名动作。 */
function readProjectQueryCode(context: TargetReadContext): Nullable<ToolTargetSummary> {
  const { args } = context
  const fromSymbol = readString(args, 'fromSymbol')
  const toSymbol = readString(args, 'toSymbol')

  return toSummary(
    clipText(
      readString(args, 'symbol') ??
        readString(args, 'query') ??
        (fromSymbol && toSymbol ? `${fromSymbol} → ${toSymbol}` : null) ??
        readString(args, 'nodeId') ??
        describeFirstOfList(readStringArray(args, 'nodeIds')) ??
        readString(args, 'task') ??
        readPath(args, 'path', context) ??
        readPath(args, 'targetPath', context) ??
        readString(args, 'specifier') ??
        readString(args, 'framework') ??
        readString(args, 'action')
    )
  )
}

// ---- 工作台（Workbench） ----

/** 打开的文件带上跳到的行：显式的 line 优先，否则取第一段高亮的起止行。 */
function describeOpenedFile(entry: RecordValue, context: TargetReadContext): Nullable<string> {
  const path = readPath(entry, 'path', context)
  const line = readNumber(entry, 'line')
  if (isPresent(line)) return describeLocation(path, line, readNumber(entry, 'endLine'))

  const [highlight] = readRecordsArray(entry, 'highlights')
  return describeLocation(path, readNumber(highlight, 'startLine'), readNumber(highlight, 'endLine'))
}

function readWorkbenchOpenFile(context: TargetReadContext): Nullable<ToolTargetSummary> {
  const entries = [context.args, ...readRecordsArray(context.args, 'files')].flatMap((entry) => {
    const location = describeOpenedFile(entry, context)
    return location ? [location] : []
  })

  return toSummary(describeFirstOfList(entries), entries.slice(0, MaxListedItems))
}

function readWorkbenchExplainCode(context: TargetReadContext): Nullable<ToolTargetSummary> {
  const explanations = readRecordsArray(context.args, 'explanations')
  const locations = explanations.flatMap((entry) => {
    const location = describeLocation(
      readPath(entry, 'path', context),
      readNumber(entry, 'startLine'),
      readNumber(entry, 'endLine')
    )
    return location ? [{ location, title: readString(entry, 'title') }] : []
  })

  return toSummary(
    describeFirstOfList(locations.map((entry) => entry.location)),
    locations.slice(0, MaxListedItems).map((entry) => clipDetail(joinParts([entry.location, entry.title])) ?? '')
  )
}

function readWorkbenchEditorState(context: TargetReadContext): Nullable<ToolTargetSummary> {
  const activeFile = asRecord(context.result?.activeFile)
  return toSummary(
    describeLocation(readPath(activeFile, 'path', context), readNumber(activeFile, 'line'), null) ??
      readString(context.result, 'view')
  )
}

function readWorkbenchRun({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(readFirstString(args.waitFor, args.sessionId)))
}

/** 问题面板：查了哪些文件，结果里有多少错误与警告（⊗ 错误、⚠ 警告，与问题面板的图标一致）。 */
function readWorkbenchProblems(context: TargetReadContext): Nullable<ToolTargetSummary> {
  const errors = readNumber(context.result, 'errors')
  const warnings = readNumber(context.result, 'warnings')
  const counts = isPresent(errors) || isPresent(warnings) ? `⊗ ${errors ?? 0} ⚠ ${warnings ?? 0}` : null

  return toSummary(joinParts([describeFirstOfList(readPathList(context.args, 'paths', context)), counts]), [
    readString(context.result, 'shown'),
  ])
}

// ---- 浏览器 ----

/** 页面本身：结果里的标题，没有标题时是地址。 */
function describePage(result: LooseOptional<RecordValue>): Nullable<string> {
  return clipText(readFirstString(result?.title, result?.url))
}

function readPageIdentity({ result }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(describePage(result), [clipDetail(result?.url)])
}

function readSiteContext({ result }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(readFirstString(asRecord(result?.browserContext)?.url, result?.siteUrl)))
}

function readPageTargets({ result }: TargetReadContext): Nullable<ToolTargetSummary> {
  const targets = readRecordsArray(result, 'targets')
  const activeTarget = targets.find((target) => isTrue(target.active))

  return toSummary(
    describePage(activeTarget),
    targets.slice(0, MaxListedItems).map((target) => describePage(target) ?? '')
  )
}

function readSwitchPageTarget(context: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(describePage(context.result) ?? readString(context.args, 'targetId'), [clipDetail(context.result?.url)])
}

function readObserveActions({ args, result }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(
    clipText(args.instruction) ?? describePage(result),
    readRecordsArray(result, 'candidates')
      .slice(0, 5)
      .map((candidate) => clipDetail(candidate.description) ?? '')
  )
}

function readScreenshot(context: TargetReadContext): Nullable<ToolTargetSummary> {
  const { args, result } = context
  return toSummary(
    clipText(readString(args, 'selector')) ?? describeCoordinates(args) ?? clipText(result?.url),
    [readFirstString(result?.relativePath, result?.path), describeSize(result)]
  )
}

function readSelectorTarget({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(args.selector))
}

/** 诊断类列表：按什么过滤（级别、仅错误、状态码、资源类型、仅失败），没过滤时是哪个页面。 */
function readDiagnosticsFilter({ args, result }: TargetReadContext): Nullable<ToolTargetSummary> {
  const status = readNumber(args, 'status')
  return toSummary(
    joinParts([
      readString(args, 'level'),
      isTrue(args.errorsOnly) ? 'errorsOnly' : null,
      isPresent(status) ? String(status) : null,
      readString(args, 'resourceType'),
      isTrue(args.failedOnly) ? 'failedOnly' : null,
    ]) ?? clipText(result?.url)
  )
}

function readNetworkRequest({ args, result }: TargetReadContext): Nullable<ToolTargetSummary> {
  const request = asRecord(result?.request)
  const response = asRecord(result?.response)
  const status = readNumber(response, 'status')

  return toSummary(
    joinParts([readString(request, 'method'), clipText(request?.url)]) ?? readString(args, 'requestId'),
    [
      clipDetail(request?.url),
      joinParts([isPresent(status) ? String(status) : null, readString(response, 'statusText')]),
    ]
  )
}

function readRequestId({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(readString(args, 'requestId'))
}

/** browser:act：与悬停详情的操作标签同一写法——`动作.子动作 · 对象`。 */
function readBrowserAct({ args, formatPath }: TargetReadContext): Nullable<ToolTargetSummary> {
  const [operation] = getToolOperations({ toolName: 'browser:act', args }, formatPath)
  return toSummary(operation ? joinParts([operation.id, clipText(operation.target)]) : null)
}

function readPendingEvents({ args, result }: TargetReadContext): Nullable<ToolTargetSummary> {
  const pendingKinds = readRecordsArray(result, 'pending').flatMap((event) => readString(event, 'kind') ?? [])
  return toSummary(
    readString(args, 'kind') ?? readString(asRecord(result?.event), 'kind') ?? joinParts([...new Set(pendingKinds)])
  )
}

function readDialogHandling({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(joinParts([describeFlag(args, 'accept'), clipText(args.promptText)]))
}

function readDownloadHandling(context: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(joinParts([readString(context.args, 'action'), readPath(context.args, 'savePath', context)]))
}

function readPermissionHandling({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(describeFlag(args, 'grant'))
}

function describeElementHint(hint: Nullable<RecordValue>): Nullable<string> {
  const label = readFirstString(hint?.name, hint?.text)
  const role = readString(hint, 'role')
  if (label) return role ? `${role} ${label}` : label

  return readFirstString(hint?.ref, hint?.css)
}

function readUploadFile(context: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(readPath(context.args, 'filePath', context), [
    clipDetail(describeElementHint(asRecord(context.args.target))),
  ])
}

function readFetchResource(context: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(context.args.url), [clipDetail(context.args.url), readPath(context.args, 'savePath', context)])
}

function readPageUrl({ result }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(clipText(result?.url))
}

function readPageData({ args }: TargetReadContext): Nullable<ToolTargetSummary> {
  return toSummary(joinParts([readString(args, 'preset'), clipText(args.selector), readString(args, 'attribute')]))
}

function readEvaluateScript({ args, result }: TargetReadContext): Nullable<ToolTargetSummary> {
  const error = asRecord(result?.error)
  return toSummary(clipText(args.script), [
    clipDetail(args.script),
    clipDetail(readFirstString(error?.message, result?.resultText)),
  ])
}

/** 带动作选择器的复合浏览器工具：`动作 · 对象`（提取、导出、性能、录屏、文件、配方、用户脚本）。 */
function readActionWithSubject(actionKey: string, subjectKeys: readonly string[]): ToolTargetReader {
  return ({ args, result }) =>
    toSummary(
      joinParts([
        readString(args, actionKey),
        clipText(readFirstString(...subjectKeys.map((key) => args[key]))),
      ]),
      [readFirstString(result?.savedRelativePath, result?.relativePath)]
    )
}

const ToolTargetReaders: Readonly<Record<string, ToolTargetReader>> = {
  // 规划
  'plan:update': readPlanUpdate,
  'plan:get': readPlanGet,
  'goal:create': readGoalCreate,
  'goal:update': readGoalUpdate,
  'goal:get': readGoalGet,
  'proposal:get': readProposalGet,
  'proposal:review': readProposalReview,
  'directive:list': readDirectiveList,
  'directive:upsert': readDirectiveUpsert,
  'directive:archive': readDirectiveArchive,
  // 工具空间、上下文、子 Agent、后台任务
  'tooling:map': readToolingMap,
  'context:recall': readContextRecall,
  'context:handoff': readContextHandoff,
  'agent:dispatch': readAgentDispatch,
  'agent:run_workflow': readAgentWorkflow,
  'job:read_output': readBackgroundJob,
  'job:wait': readBackgroundJob,
  'job:cancel': readBackgroundJob,
  'interaction:confirm': readMessageTarget,
  // 与用户交互
  'interaction:ask_user': readAskUser,
  'interaction:show_action_cards': readActionCards,
  'interaction:read_me': readGuideModules,
  'feedback:submit': readMessageTarget,
  'task:flag': readFlaggedTask,
  // 协作、定时任务、媒体生成
  'peer:send': readPeerSend,
  'peer:spawn': readPeerSpawn,
  'schedule:propose': readScheduleProposal,
  'schedule:list_runs': readTaskId,
  'schedule:update': readScheduledTask,
  'schedule:delete': readTaskId,
  'schedule:run_now': readTaskId,
  'media:generate_image': readPromptTarget,
  'media:generate_video': readPromptTarget,
  // 桌面控制、系统
  'computer:move': readCoordinates,
  'computer:click': readCoordinates,
  'computer:type': readTypedText,
  'computer:key': readKeys,
  'computer:screenshot': readScreenSize,
  'computer:screen_size': readScreenSize,
  'system:processes': readSystemProcesses,
  'system:list-tasks': readTaskId,
  'system:terminate-task': readTaskId,
  // Office
  'office:create_word_document': readOfficeDocument,
  'office:create_presentation': readOfficeDocument,
  'office:create_spreadsheet': readOfficeDocument,
  'office:extract_pdf_text': readOfficeDocument,
  'office:convert_pdf_to_word': readOfficeDocument,
  'office:convert_word_to_pdf': readOfficeDocument,
  'office:create_latex_pdf': readOfficeDocument,
  'office:edit_pdf_document': readOfficeDocument,
  'office:preview_document': readOfficeDocument,
  'office:convert_document_to_markdown': readOfficeDocument,
  // 记忆与知识库
  'memory:get': readMemoryGet,
  'memory:archive': readMemoryArchive,
  'knowledge:sync': readKnowledgeSync,
  // 项目
  'project:list': readProjectList,
  'project:query-code': readProjectQueryCode,
  // 工作台
  'workbench:open_file': readWorkbenchOpenFile,
  'workbench:explain_code': readWorkbenchExplainCode,
  'workbench:get_editor_state': readWorkbenchEditorState,
  'workbench:read_run': readWorkbenchRun,
  'workbench:stop_run': readWorkbenchRun,
  'workbench:get_problems': readWorkbenchProblems,
  // 浏览器
  'browser:show_page': readPageIdentity,
  'browser:get_page_state': readPageIdentity,
  'browser:inspect_page': readPageIdentity,
  'browser:site_context': readSiteContext,
  'browser:space_manifest': readSiteContext,
  'browser:list_page_targets': readPageTargets,
  'browser:switch_page_target': readSwitchPageTarget,
  'browser:observe_actions': readObserveActions,
  'browser:capture_screenshot': readScreenshot,
  'browser:capture_region': readScreenshot,
  'browser:query_elements': readSelectorTarget,
  'browser:get_element_bounds': readSelectorTarget,
  'browser:get_page_diagnostics': readDiagnosticsFilter,
  'browser:list_page_errors': readDiagnosticsFilter,
  'browser:list_console_events': readDiagnosticsFilter,
  'browser:list_network_events': readDiagnosticsFilter,
  'browser:get_network_request': readNetworkRequest,
  'browser:get_network_response_body': readRequestId,
  'browser:act': readBrowserAct,
  'browser:list_pending_events': readPendingEvents,
  'browser:wait_for_pending_event': readPendingEvents,
  'browser:handle_dialog': readDialogHandling,
  'browser:handle_download': readDownloadHandling,
  'browser:handle_permission': readPermissionHandling,
  'browser:upload_file': readUploadFile,
  'browser:fetch_resource': readFetchResource,
  'browser:list_media_sources': readPageUrl,
  'browser:list_page_resources': readPageUrl,
  'browser:read_page_storage': readPageUrl,
  'browser:read_page_data': readPageData,
  'browser:evaluate_script': readEvaluateScript,
  'browser:extract': readActionWithSubject('action', ['selector', 'format']),
  'browser:export_page': readActionWithSubject('kind', ['selector', 'savePath', 'name']),
  'browser:performance': readActionWithSubject('action', ['insightName', 'insightSetId']),
  'browser:screencast': readActionWithSubject('action', ['name']),
  'browser:files': readActionWithSubject('action', ['path', 'name', 'kind']),
  'browser:recipe': readActionWithSubject('action', ['path', 'name', 'template']),
  'browser:user_scripts': readActionWithSubject('action', ['name', 'id']),
}

/**
 * 读出一次调用的作用对象摘要。没有登记读取器、或参数与结果里读不出任何东西时返回 null，
 * 调用方回落到通用摘要。`formatPath` 是宿主的路径显示格式化（已按调用的 cwd 解析相对路径）。
 */
export function getToolTargetSummary(
  block: Pick<ToolCallBlock, 'toolName' | 'args'> & Partial<Pick<ToolCallBlock, 'result'>>,
  formatPath: (path: string) => string = (path) => path
): Nullable<ToolTargetSummary> {
  const reader = ToolTargetReaders[block.toolName.trim().toLowerCase()]
  if (!reader) return null

  return reader({ args: asRecord(block.args) ?? {}, result: asRecord(block.result), formatPath })
}
