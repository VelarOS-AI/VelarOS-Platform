/**
 * 推导一次工具调用实际执行了哪些操作、分别作用在什么对象上（纯函数）。
 *
 * 不少工具在一个名字下藏着多种操作：编辑工具的操作列表、代码查询的动作、浏览器动作的子动作……
 * 紧凑行只显示工具名，悬停详情靠这里把操作标识和作用对象拆出来。已知形态按工具名登记读取器；
 * 其余工具走通用兜底：先读几个常见的选择字段，再读类型字段，并逐项扫描操作、步骤类数组。
 *
 * 操作标识原样保留，界面用等宽标签直接展示，不逐项翻译。
 */
import type { ToolCallBlock } from '#contracts'
import {
  isEmpty,
  isFiniteNumber,
  isNonBlankString,
  isPresent,
  isTrue,
  truncate,
} from '#internal/runtime'
import {
  asRecord,
  readNumber,
  readRecordsArray,
  readString,
  readStringArray,
  readStringScalar,
} from '#internal/unknownJsonRecord'

/** 一次工具调用里实际执行的一项操作。 */
export interface ToolOperationSummary {
  /** 原始操作标识，如 `replace_text`、`find_references`、`target.click`，界面原样展示。 */
  id: string
  /** 操作的作用对象（路径、符号、查询词、URL 等）；参数里推不出时省略。 */
  target?: string
}

type RecordValue = Record<string, unknown>

interface OperationReadContext {
  args: RecordValue
  formatPath: (path: string) => string
}

type ToolOperationReader = (context: OperationReadContext) => ToolOperationSummary[]

// 标识必须像一个标识符：挡住把一段自然语言（如 type 字段里的描述）误当成操作名。
const OperationIdPattern = /^[A-Za-z][\w.:-]{0,63}$/u
const MaxTargetLength = 160
const TargetSeparator = ' · '
const PrimarySelectorKeys = ['operation', 'action', 'op', 'mode'] as const
const SecondarySelectorKeys = ['kind', 'type'] as const
const OperationArrayKeys = ['operations', 'steps', 'edits'] as const
const GenericPathKeys = ['path', 'targetPath', 'filePath', 'file', 'rootPath'] as const
const GenericTextKeys = [
  'url',
  'query',
  'symbol',
  'selector',
  'name',
  'title',
  'command',
  'application',
  'key',
] as const
const DefaultProcessSections = ['processes', 'ports', 'tasks'] as const

function readOperationId(value: unknown): Nullable<string> {
  const text = readStringScalar(value)
  return text && OperationIdPattern.test(text) ? text : null
}

function createOperation(id: string, target: Optional<string>): ToolOperationSummary {
  if (isPresent(target)) return { id, target }

  return { id }
}

function toTargetText(value: LooseOptional<string>): Optional<string> {
  if (!isNonBlankString(value)) return undefined

  return truncate(value.replaceAll(/\s+/gu, ' ').trim(), MaxTargetLength)
}

function joinTargetParts(parts: ReadonlyArray<LooseOptional<string>>): Optional<string> {
  const present = parts.filter((part): part is string => isNonBlankString(part))
  return isEmpty(present) ? undefined : toTargetText(present.join(TargetSeparator))
}

/** 多个对象只点名第一个，其余用 `+N` 计数，与紧凑行的文件列表写法一致。 */
function describeFirstOfList(values: readonly string[]): Nullable<string> {
  const [first] = values
  if (!first) return null

  return values.length > 1 ? `${first} +${values.length - 1}` : first
}

function readFormattedPath(
  record: RecordValue,
  key: string,
  context: OperationReadContext
): Nullable<string> {
  const path = readString(record, key)
  if (path) return context.formatPath(path)

  return describeFirstOfList(readStringArray(record, key).map(context.formatPath))
}

function readPathMove(record: RecordValue, context: OperationReadContext): Nullable<string> {
  const pairs = [
    ['from', 'to'],
    ['fromPath', 'toPath'],
  ] as const
  for (const [fromKey, toKey] of pairs) {
    const from = readString(record, fromKey)
    const to = readString(record, toKey)
    if (from && to) return `${context.formatPath(from)} → ${context.formatPath(to)}`
  }

  return null
}

function readGenericTarget(record: RecordValue, context: OperationReadContext): Optional<string> {
  const move = readPathMove(record, context)
  if (move) return toTargetText(move)

  for (const key of GenericPathKeys) {
    const path = readFormattedPath(record, key, context)
    if (path) return toTargetText(path)
  }

  for (const key of GenericTextKeys) {
    const text = readString(record, key)
    if (text) return toTargetText(text)
  }

  return undefined
}

function readSelector(record: RecordValue): Nullable<string> {
  for (const key of [...PrimarySelectorKeys, ...SecondarySelectorKeys]) {
    const id = readOperationId(record[key])
    if (id) return id
  }

  return null
}

/** 一条操作记录：可能是 `{ type, … }` 平铺，也可能是 `{ operation: { type, … }, reason }` 包装。 */
function readRecordOperation(
  record: RecordValue,
  context: OperationReadContext
): Nullable<ToolOperationSummary> {
  const wrapped = asRecord(record.operation)
  if (wrapped) {
    const wrappedId = readSelector(wrapped)
    if (wrappedId) return createOperation(wrappedId, readGenericTarget(wrapped, context) ?? readGenericTarget(record, context))
  }

  const id = readSelector(record)
  return id ? createOperation(id, readGenericTarget(record, context)) : null
}

function readGenericOperations(context: OperationReadContext): ToolOperationSummary[] {
  const topLevel = readRecordOperation(context.args, context)
  const itemOperations = OperationArrayKeys.flatMap((key) =>
    readRecordsArray(context.args, key).flatMap((item) => {
      const itemOperation = readRecordOperation(item, context)
      return itemOperation ? [itemOperation] : []
    })
  )

  return topLevel ? [topLevel, ...itemOperations] : itemOperations
}

/** project:edit 每项操作的补充限定：符号名、导入模块、JSON Patch 的 op 与指针。 */
function describeProjectEditQualifier(edit: RecordValue): Array<Nullable<string>> {
  const symbolName = readString(asRecord(edit.symbol), 'name')
  const patches = readRecordsArray(edit, 'patches')
    .map((patch) =>
      [readOperationId(patch.op), readStringScalar(patch.path)]
        .filter((part): part is string => isNonBlankString(part))
        .join(' ')
    )
    .filter((patch) => isNonBlankString(patch))

  return [
    symbolName,
    symbolName ? (readOperationId(edit.mode) ?? readOperationId(edit.position)) : null,
    readString(edit, 'module') ?? readString(edit, 'moduleSpecifier'),
    readString(edit, 'name'),
    readString(edit, 'module') ? null : readString(edit, 'importStatement'),
    describeFirstOfList(patches),
  ]
}

function readProjectEditOperations(context: OperationReadContext): ToolOperationSummary[] {
  return readRecordsArray(context.args, 'operations').flatMap((entry) => {
    // 模型偶尔把 operation 平铺在数组项上而不是包进 `operation`，两种写法都认。
    const edit = asRecord(entry.operation) ?? entry
    const id = readOperationId(edit.type)
    if (!id) return []

    const move = readPathMove(edit, context)
    const path = readString(edit, 'path')
    const target = move
      ? toTargetText(move)
      : joinTargetParts([path ? context.formatPath(path) : null, ...describeProjectEditQualifier(edit)])
    return [createOperation(id, target)]
  })
}

function readProjectWriteOperation(context: OperationReadContext): ToolOperationSummary[] {
  const id = readOperationId(context.args.mode)
  return id ? [createOperation(id, toTargetText(readFormattedPath(context.args, 'path', context)))] : []
}

function describeCodeQuerySubject(args: RecordValue, context: OperationReadContext): Nullable<string> {
  const fromSymbol = readString(args, 'fromSymbol')
  const toSymbol = readString(args, 'toSymbol')

  return (
    readString(args, 'symbol') ??
    readString(args, 'query') ??
    (fromSymbol && toSymbol ? `${fromSymbol} → ${toSymbol}` : null) ??
    readString(args, 'nodeId') ??
    describeFirstOfList(readStringArray(args, 'nodeIds')) ??
    readString(args, 'task') ??
    readFormattedPath(args, 'targetPath', context) ??
    readString(args, 'specifier') ??
    readString(args, 'framework')
  )
}

function readProjectCodeQueryOperation(context: OperationReadContext): ToolOperationSummary[] {
  const id = readOperationId(context.args.action)
  if (!id) return []

  return [
    createOperation(
      id,
      joinTargetParts([
        describeCodeQuerySubject(context.args, context),
        readFormattedPath(context.args, 'path', context),
      ])
    ),
  ]
}

/** 只有正则模式值得单独点名；字面搜索没有额外操作，查询词由详情行展示。 */
function readProjectSearchOperation(context: OperationReadContext): ToolOperationSummary[] {
  if (!isTrue(context.args.regex)) return []

  return [
    createOperation(
      'regex',
      joinTargetParts([readString(context.args, 'query'), readFormattedPath(context.args, 'path', context)])
    ),
  ]
}

/** project:run 本身只有一种操作；后台 / 并行这类执行方式才需要点名，命令由详情行展示。 */
function readProjectRunOperations(context: OperationReadContext): ToolOperationSummary[] {
  return (['background', 'parallel'] as const)
    .filter((flag) => isTrue(context.args[flag]))
    .map((flag) => createOperation(flag, undefined))
}

function describeBrowserTargetHint(hint: Nullable<RecordValue>): Nullable<string> {
  if (!hint) return null

  const label = readString(hint, 'name') ?? readString(hint, 'text')
  const role = readString(hint, 'role')
  if (label) return role ? `${role} ${label}` : label

  return readString(hint, 'ref') ?? readString(hint, 'css')
}

function describeBrowserElement(
  args: RecordValue,
  prefix: 'target' | 'source'
): Nullable<string> {
  return (
    describeBrowserTargetHint(asRecord(args[prefix])) ??
    readString(args, `${prefix}Ref`) ??
    readString(args, `${prefix}Css`)
  )
}

function describeCoordinates(args: RecordValue): Nullable<string> {
  const x = readNumber(args, 'x')
  const y = readNumber(args, 'y')
  return isPresent(x) && isPresent(y) ? `${x}, ${y}` : null
}

function describeBrowserActTarget(action: string, args: RecordValue): Nullable<string> {
  switch (action) {
    case 'target': {
      return describeBrowserElement(args, 'target')
    }
    case 'drag': {
      const source = describeBrowserElement(args, 'source')
      const target = describeBrowserElement(args, 'target')
      return source && target ? `${source} → ${target}` : (source ?? target)
    }
    case 'navigate':
    case 'wait_for_url': {
      return readString(args, 'url') ?? readString(args, 'urlPattern')
    }
    case 'type':
    case 'wait_for_text': {
      return readString(args, 'text')
    }
    case 'press_key': {
      const key = readString(args, 'key')
      const modifiers = readStringArray(args, 'modifiers')
      return key ? [...modifiers, key].join('+') : null
    }
    case 'scroll': {
      return readString(args, 'direction') ?? describeCoordinates(args)
    }
    case 'move_mouse':
    case 'click_coordinates': {
      return describeCoordinates(args)
    }
    case 'wait_for_selector': {
      return readString(args, 'selector')
    }
    case 'wait_for_function': {
      return readString(args, 'expression')
    }
    case 'set_viewport': {
      const width = readNumber(args, 'width')
      const height = readNumber(args, 'height')
      return isPresent(width) && isPresent(height) ? `${width}×${height}` : null
    }
    case 'set_page_zoom': {
      const zoomFactor = readNumber(args, 'zoomFactor')
      return isPresent(zoomFactor) ? String(zoomFactor) : null
    }
    default: {
      return null
    }
  }
}

/** browser:act 的 action 之下还有子动作（targetAction / navigationAction / zoomAction），合写成 `action.sub`。 */
function readBrowserActOperation(context: OperationReadContext): ToolOperationSummary[] {
  const action = readOperationId(context.args.action)
  if (!action) return []

  const subAction =
    readOperationId(context.args.targetAction) ??
    readOperationId(context.args.navigationAction) ??
    readOperationId(context.args.zoomAction)
  const target = describeBrowserActTarget(action, context.args) ?? readGenericTarget(context.args, context)
  return [createOperation(subAction ? `${action}.${subAction}` : action, toTargetText(target))]
}

/** action=application 时路径只是交给应用打开的对象，应用名才是主语。 */
function readSystemOpenOperation(context: OperationReadContext): ToolOperationSummary[] {
  const id = readOperationId(context.args.action)
  if (!id) return []

  const path = readFormattedPath(context.args, 'path', context)
  const target = path
    ? toTargetText(path)
    : joinTargetParts([
        readString(context.args, 'application'),
        readFormattedPath(context.args, 'targetPath', context),
      ])
  return [createOperation(id, target)]
}

/** include 缺省时工具同时返回三类运行态，按实际执行把默认值展开。 */
function readSystemProcessesOperations(context: OperationReadContext): ToolOperationSummary[] {
  const sections = readStringArray(context.args, 'include')
    .map(readOperationId)
    .filter((section): section is string => isPresent(section))
  const port = readNumber(context.args, 'port')
  const pid = readNumber(context.args, 'pid')
  const target = toTargetText(
    readString(context.args, 'filter') ??
      readString(context.args, 'processName') ??
      (isPresent(port) ? `:${port}` : null) ??
      (isPresent(pid) ? `pid ${pid}` : null)
  )

  return (isEmpty(sections) ? DefaultProcessSections : sections).map((section) =>
    createOperation(section, target)
  )
}

function readGoalUpdateOperations(context: OperationReadContext): ToolOperationSummary[] {
  const operations: ToolOperationSummary[] = []
  const status = readOperationId(context.args.status)
  if (status) operations.push(createOperation(status, toTargetText(readString(context.args, 'objective'))))

  const completeStep = context.args.complete_step
  const stepRef = isFiniteNumber(completeStep) ? String(completeStep) : readStringScalar(completeStep)
  if (stepRef) operations.push(createOperation('complete_step', toTargetText(stepRef)))

  return operations
}

function readWorkflowOperations(context: OperationReadContext): ToolOperationSummary[] {
  return readRecordsArray(context.args, 'steps').flatMap((step) => {
    const id = readOperationId(step.operation)
    return id ? [createOperation(id, toTargetText(readString(step, 'id') ?? readString(step, 'name')))] : []
  })
}

/** agent:dispatch 的 mode 缺省即 sync；带 interrupt 时实际执行的是中断续跑中的 worker。 */
function readDispatchOperation(context: OperationReadContext): ToolOperationSummary[] {
  const { args } = context
  const id = isTrue(args.interrupt) ? 'interrupt' : (readOperationId(args.mode) ?? 'sync')
  const target =
    joinTargetParts([readString(args, 'agent_name'), readString(args, 'description')]) ??
    toTargetText(readString(args, 'thread_id'))
  return [createOperation(id, target)]
}

function readMemorySearchOperation(context: OperationReadContext): ToolOperationSummary[] {
  return [
    createOperation(
      readOperationId(context.args.mode) ?? 'search',
      toTargetText(readString(context.args, 'query'))
    ),
  ]
}

function readToolingMapOperation(context: OperationReadContext): ToolOperationSummary[] {
  const { args } = context
  const target =
    readString(args, 'query') ??
    describeFirstOfList(readStringArray(args, 'categoryIds')) ??
    describeFirstOfList(readStringArray(args, 'domainIds')) ??
    readString(args, 'kind')
  return [createOperation(readOperationId(args.op) ?? 'map', toTargetText(target))]
}

const ToolOperationReaders: Readonly<Record<string, ToolOperationReader>> = {
  'project:edit': readProjectEditOperations,
  'project:write': readProjectWriteOperation,
  'project:query-code': readProjectCodeQueryOperation,
  'project:search': readProjectSearchOperation,
  'project:run': readProjectRunOperations,
  'browser:act': readBrowserActOperation,
  'system:open': readSystemOpenOperation,
  'system:processes': readSystemProcessesOperations,
  'goal:update': readGoalUpdateOperations,
  'agent:run_workflow': readWorkflowOperations,
  'agent:dispatch': readDispatchOperation,
  'memory:search': readMemorySearchOperation,
  'tooling:map': readToolingMapOperation,
}

/**
 * 推导一次工具调用实际执行的操作列表（按参数里的顺序，不去重、不截断——展示层自己决定折叠与上限）。
 * 参数缺失或推不出任何操作时返回空数组，调用方回落到普通的参数摘要。
 */
export function getToolOperations(
  block: Pick<ToolCallBlock, 'toolName' | 'args'>,
  formatPathForDisplay?: (path: string) => string
): ToolOperationSummary[] {
  const args = asRecord(block.args)
  if (!args) return []

  const context: OperationReadContext = {
    args,
    formatPath: (path) => (formatPathForDisplay ? formatPathForDisplay(path) : path),
  }
  const reader = ToolOperationReaders[block.toolName.trim().toLowerCase()] ?? readGenericOperations
  return reader(context)
}
