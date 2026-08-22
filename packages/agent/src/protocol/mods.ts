// 域：Agent 领域 Mod Manifest（两级注册机的第二级数据契约）。
//
// 第一级 = Kernel Module Host：只解析窄 `KernelModuleDescriptor`（id/version/apiVersion/
// provides/requires/permissions/isolation），永不解析本文件的任何贡献轴。
// 第二级 = Agent 领域 Loader（`@velaros-ai/agent` 的 `mods/`）：owner module 激活后
// 加载本 manifest，把贡献轴分发进各自的注册面。
//
// 铁律：**validate 先于任何归一化**——冲突、非法、缺绑定一律拒载并给可读
// 诊断，绝不静默降级、绝不静默丢弃。本文件的宽容只发生在**形态**层（标量→单元素数组、
// 首尾空白），语义层零宽容。
import { z } from 'zod'

import { isCanonicalToolId } from '@velaros-ai/agent/tool-contract'
import {
  isArray,
  isBlank,
  isEmpty,
  isNotNull,
  isPlainObject,
  isString,
  isUndefined,
} from '@velaros-ai/core'
import { VelarosModManifestFileName } from '@velaros-ai/kernel/contracts/protocol'

// ─── semver：manifest 兼容轴的最小判定器（单源，Loader 复用） ──────────────────

interface SemverVersion {
  major: number
  minor: number
  patch: number
}

type SemverComparator =
  | { kind: 'any' }
  | { kind: '=' | '>' | '>=' | '<' | '<='; version: SemverVersion }
  | { kind: '^' | '~'; version: SemverVersion }

const SemverVersionPattern = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u
const SemverComparatorPattern = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/u

/** 解析 `x.y.z`（预发布/构建元数据被忽略）；非法返回 null。 */
function parseSemverVersion(text: string): Nullable<SemverVersion> {
  const match = SemverVersionPattern.exec(text.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function compareSemver(left: SemverVersion, right: SemverVersion): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  return left.patch - right.patch
}

function parseSemverComparator(text: string): Nullable<SemverComparator> {
  const trimmed = text.trim()
  if (isEmpty(trimmed) || trimmed === '*' || trimmed === 'x') return { kind: 'any' }
  const match = SemverComparatorPattern.exec(trimmed)
  if (!match) return null
  const version = parseSemverVersion(match[2] ?? '')
  if (!version) return null
  const kind = (match[1] ?? '=') as Exclude<SemverComparator, { kind: 'any' }>['kind']
  return { kind, version }
}

function satisfiesComparator(version: SemverVersion, comparator: SemverComparator): boolean {
  if (comparator.kind === 'any') return true
  const delta = compareSemver(version, comparator.version)
  switch (comparator.kind) {
    case '=':
      return delta === 0
    case '>':
      return delta > 0
    case '>=':
      return delta >= 0
    case '<':
      return delta < 0
    case '<=':
      return delta <= 0
    case '^': {
      if (delta < 0) return false
      // 0.x 系列的 caret 收紧到 minor（npm 语义）。
      if (comparator.version.major === 0) return (
          version.major === 0 && version.minor === comparator.version.minor
        )
      return version.major === comparator.version.major
    }
    case '~':
      return (
        delta >= 0 &&
        version.major === comparator.version.major &&
        version.minor === comparator.version.minor
      )
  }
}

/**
 * 判定 range 是否可解析。
 *
 * 支持形态：`*` / `x` / `1.2.3` / `=1.2.3` / `^1.2.3` / `~1.2.3` / `>=1.2.3` / `<2.0.0`，
 * 空白分隔 = 合取，`||` = 析取。刻意不实现 hyphen range 与预发布优先级——manifest 兼容轴
 * 只做兼容范围判定；复杂依赖求解属于包管理器职责，本协议不实现依赖求解器。
 */
function isSemverRangeParsable(range: string): boolean {
  const clauses = range.split('||')
  if (isEmpty(clauses)) return false
  return clauses.every((clause) => {
    const comparators = clause.trim().split(/\s+/u).filter((part) => !isEmpty(part))
    if (isEmpty(comparators)) return false
    return comparators.every((part) => isNotNull(parseSemverComparator(part)))
  })
}

/** 判定 version 是否满足 range；range 或 version 非法一律返回 false（fail-closed）。 */
function satisfiesSemverRange(version: string, range: string): boolean {
  const parsedVersion = parseSemverVersion(version)
  if (!parsedVersion) return false
  return range.split('||').some((clause) => {
    const comparators = clause.trim().split(/\s+/u).filter((part) => !isEmpty(part))
    if (isEmpty(comparators)) return false
    return comparators.every((part) => {
      const comparator = parseSemverComparator(part)
      return isNotNull(comparator) && satisfiesComparator(parsedVersion, comparator)
    })
  })
}

// ─── 贡献轴闭集 ──────────────────────────────────────────────────────────────

/**
 * Agent 领域贡献轴闭集。
 *
 * 贡献点由官方演进，mod 不能发明新轴。壳级 UI 轴（pages/settingsRenderers/
 * surfaces/tours）不在 Agent 主干——它们是产品壳的不透明信封，由壳自己的 manifest 面拥有。
 */
const AgentModContributionAxisNames = [
  'tools',
  'toolCategories',
  'promptSegments',
  'skills',
  'spaces',
  'subAgentTypes',
  'turnContextSources',
  'executionModes',
  'hooks',
] as const

type AgentModContributionAxisName = (typeof AgentModContributionAxisNames)[number]

const AgentModContributionAxisNameSchema = z.enum(AgentModContributionAxisNames)

/**
 * Hook 生命周期事件闭集。
 *
 * mod 只能挂接，不能发明新事件。**哪些事件今天真有派发点**由实现侧的
 * `WiredSeamKindsByDispatcher`（`../mods/AgentModSeams`）逐条登记，本闭集不复述第二份；
 * 未接线者只有注册面与类型，注册即收 `mod.seam-not-wired` 诊断，dispatch 恒无调用点。
 *
 * 新 manifest 一律使用 `event`。`seam` 只是 v1 编译期 Mod 的过渡输入别名，解析后不再存在；
 * 外部 `.velarmod` 与编译期 Mod 因此消费同一份规范化声明。
 */
const AgentModHookEvents = [
  'session:start',
  'session:end',
  'turn:start',
  'turn:end',
  'turn-context:assemble',
  'prompt:compose',
  'tool-call:before',
  'tool-call:after',
  'tool-result:after',
  'model-request:before',
  'model-response:after',
  'sub-agent:dispatch',
  'compaction:before',
  'skill:select',
  'diagnostic:publish',
] as const

type AgentModHookEvent = (typeof AgentModHookEvents)[number]

const AgentModHookEventSchema = z.enum(AgentModHookEvents)

/** @deprecated 只为现有调用方保留；新代码使用 HookEvent 命名。 */
const AgentModSeamKinds = AgentModHookEvents
/** @deprecated 只为现有调用方保留；新代码使用 HookEvent 命名。 */
type AgentModSeamKind = AgentModHookEvent
/** @deprecated 只为现有调用方保留；新代码使用 HookEvent 命名。 */
const AgentModSeamKindSchema = AgentModHookEventSchema

// ─── 形态层宽容原语 ──────────────────────────────────────────────────────────

/** 标量→单元素数组；其余原样交给下游 schema 报错（不吞毁）。 */
function tolerantArray<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return z.preprocess(
    (value) => (isString(value) ? [value] : value),
    z.array(schema)
  )
}

function tolerantNonEmptyArray<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return tolerantArray(schema).refine((value) => !isEmpty(value), {
    message: '匹配列表不能为空',
  })
}

const TrimmedIdSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => !isEmpty(value), { message: '不能为空' })

const CanonicalToolIdSchema = TrimmedIdSchema.refine(isCanonicalToolId, {
  message: '必须使用 namespace:tool canonical id',
})

const SemverRangeSchema = TrimmedIdSchema.refine(isSemverRangeParsable, {
  message: '不是可解析的 semver range（支持 * / 1.2.3 / ^1.2.3 / ~1.2.3 / >=1.2.3，空白=合取，||=析取）',
})

const SemverVersionSchema = TrimmedIdSchema.refine(
  (value) => isNotNull(parseSemverVersion(value)),
  { message: '不是合法的 x.y.z 版本号' }
)

// ─── 各轴贡献条目 ────────────────────────────────────────────────────────────

/**
 * 磁盘 Mod 的受控命令 handler。
 *
 * 编译期 Mod 仍以同 id 的函数 binding 作为载体；外部 Mod 不允许 import 进宿主进程，
 * 因此用 command 载体经 stdin/stdout JSON 协议执行。handler 只是可移植声明，具体
 * sandbox / permission broker 由宿主在进入 Loader 前适配；module.isolation 不表达本 handler 的执行方式。
 */
const AgentModCommandHandlerSchema = z.strictObject({
  type: z.literal('command'),
  entry: TrimmedIdSchema,
  permissions: tolerantNonEmptyArray(TrimmedIdSchema).optional(),
})
type AgentModCommandHandler = z.infer<typeof AgentModCommandHandlerSchema>

/** 工具贡献：`name` 是全宿主唯一键，冲突时拒载。 */
const AgentModToolContributionSchema = z.strictObject({
  name: CanonicalToolIdSchema,
  categoryId: TrimmedIdSchema.optional(),
  summary: z.string().optional(),
  readOnly: z.boolean().optional(),
  /** 工具行为本身的权限上界；运行态 VelaTool.permissions 必须保留。 */
  permissions: tolerantArray(TrimmedIdSchema).optional(),
  /** 外部 command 工具的标准 JSON Schema；编译期 binding 可继续只提供 Zod schema。 */
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  /** 缺席表示由编译期 Mod 提供同名 VelaTool binding。 */
  handler: AgentModCommandHandlerSchema.optional(),
  /** 声明本工具在哪些 space 可用；只绑定类别，不把完整 schema 钉死在常驻集。 */
  availableInSpaces: tolerantArray(TrimmedIdSchema).optional(),
  /** 声明本工具在哪些 space 常驻（数据条目，由宿主常驻集算法消费）。 */
  residentInSpaces: tolerantArray(TrimmedIdSchema).optional(),
}).superRefine((value, context) => {
  if (!value.handler) return
  if (!value.inputSchema) {
    context.addIssue({
      code: 'custom',
      path: ['inputSchema'],
      message: 'command 工具必须声明标准 JSON inputSchema',
    })
  } else if (value.inputSchema.type !== 'object') {
    context.addIssue({
      code: 'custom',
      path: ['inputSchema', 'type'],
      message: 'command 工具 inputSchema 根类型必须是 object',
    })
  }
  if (!value.categoryId) {
    context.addIssue({
      code: 'custom',
      path: ['categoryId'],
      message: 'command 工具必须声明职责类别 categoryId',
    })
  }
})
type AgentModToolContribution = z.infer<typeof AgentModToolContributionSchema>

const AgentModToolCategoryContributionSchema = z.strictObject({
  id: TrimmedIdSchema,
  label: z.string(),
  description: z.string().optional(),
  order: z.number().int().optional(),
})
type AgentModToolCategoryContribution = z.infer<
  typeof AgentModToolCategoryContributionSchema
>

/**
 * 提示词段贡献。
 *
 * `text` 缺省表示该段正文由 mod 的运行态绑定提供（宿主装载时给出 PromptSegmentDefinition）；
 * 两者都缺席 = 缺绑定，Loader 拒载。
 */
const AgentModPromptSegmentContributionSchema = z.strictObject({
  id: TrimmedIdSchema,
  label: z.string().optional(),
  stability: z.enum(['stable', 'dynamic']),
  priority: z.number().int(),
  retention: z.enum(['normal', 'protected']).optional(),
  text: z.string().optional(),
})
type AgentModPromptSegmentContribution = z.infer<
  typeof AgentModPromptSegmentContributionSchema
>

const AgentModSkillContributionSchema = z.strictObject({
  id: TrimmedIdSchema,
  name: z.string(),
  description: z.string().optional(),
  skillKind: z.enum(['role', 'capability']).optional(),
  spaces: tolerantArray(TrimmedIdSchema).refine((spaces) => !isEmpty(spaces), {
    message: 'Skill 必须显式声明至少一个 spaces',
  }),
  priority: z.number().int().optional(),
})
type AgentModSkillContribution = z.infer<typeof AgentModSkillContributionSchema>

/**
 * space 贡献只包含数据：图标使用语义标识符，manifest 不接受组件或函数引用。
 *
 * ## 今天真被消费的只有「工具配方」那几格
 *
 * `id` / `identityStrategy` / `boundCapabilityIds` / `inheritsSpaceIds` / `toolCategoryIds` /
 * `residentToolNames` 有真实读者（宿主的工具注册表、常驻集与能力门）。其余几格
 * （`descriptor` / `iconId` / `surfaceProfileId` / `turnContextSourceIds` / `promptSegmentIds`）
 * 必须由产品宿主显式投影。Platform 保留这些可选字段，避免不同宿主另造 manifest 形状。
 *
 * 宿主必须公开自己消费哪些字段；不支持的字段经 partial activation 报告，不能伪装成已生效。
 */
const AgentModSpaceContributionSchema = z.strictObject({
  id: TrimmedIdSchema,
  /** 可选展示元数据；是否展示以及展示位置由产品宿主决定。 */
  descriptor: z
    .strictObject({
      label: z.string(),
      hint: z.string().optional(),
      startTitle: z.string().optional(),
      order: z.number().int().optional(),
      localeKey: TrimmedIdSchema.optional(),
    })
    .optional(),
  /** 由产品宿主解析的语义图标标识符。 */
  iconId: TrimmedIdSchema.optional(),
  identityStrategy: z.enum(['ordinal', 'path', 'origin']),
  /** 由宿主选择的可选产品界面档案。 */
  surfaceProfileId: TrimmedIdSchema.optional(),
  boundCapabilityIds: tolerantArray(TrimmedIdSchema).optional(),
  /** 复用另一个空间已经拼装好的职责包；例如项目型空间继承 Project 配方。 */
  inheritsSpaceIds: tolerantArray(TrimmedIdSchema).optional(),
  toolCategoryIds: tolerantArray(TrimmedIdSchema).optional(),
  residentToolNames: tolerantArray(TrimmedIdSchema).optional(),
  /** 宿主可为此空间启用的上下文源标识符。 */
  turnContextSourceIds: tolerantArray(TrimmedIdSchema).optional(),
  /** 宿主可为此空间投影的提示词段标识符。 */
  promptSegmentIds: tolerantArray(TrimmedIdSchema).optional(),
})
type AgentModSpaceContribution = z.infer<typeof AgentModSpaceContributionSchema>

const AgentModSubAgentTypeContributionSchema = z.strictObject({
  id: TrimmedIdSchema,
  label: z.string().optional(),
  description: z.string().optional(),
  toolCategoryIds: tolerantArray(TrimmedIdSchema).optional(),
  toolNames: tolerantArray(TrimmedIdSchema).optional(),
  readonlyDefault: z.boolean().optional(),
})
type AgentModSubAgentTypeContribution = z.infer<
  typeof AgentModSubAgentTypeContributionSchema
>

/** per-turn 上下文源声明；`spaces` 为空数组表示不限 space。 */
const AgentModTurnContextSourceContributionSchema = z.strictObject({
  id: TrimmedIdSchema,
  label: z.string().optional(),
  spaces: tolerantArray(TrimmedIdSchema).optional(),
  rendererVisible: z.boolean().optional(),
  priority: z.number().int().optional(),
})
type AgentModTurnContextSourceContribution = z.infer<
  typeof AgentModTurnContextSourceContributionSchema
>

const AgentModExecutionModeContributionSchema = z.strictObject({
  id: TrimmedIdSchema,
  label: z.string(),
  promptFeatureId: TrimmedIdSchema.nullable().optional(),
  sessionSticky: z.boolean().optional(),
})
type AgentModExecutionModeContribution = z.infer<
  typeof AgentModExecutionModeContributionSchema
>

/**
 * Hook 匹配器。字段之间是 AND，字段内列表是 OR；事件不具备声明字段时匹配失败。
 * 闭合形状是刻意的：新匹配维度必须经过协议版本演进，外部 Mod 不能自定义解释器。
 */
const AgentModHookMatcherSchema = z.strictObject({
  toolNames: tolerantNonEmptyArray(CanonicalToolIdSchema).optional(),
  phases: tolerantNonEmptyArray(TrimmedIdSchema).optional(),
  statuses: tolerantNonEmptyArray(TrimmedIdSchema).optional(),
})
type AgentModHookMatcher = z.infer<typeof AgentModHookMatcherSchema>

/** @deprecated 新代码使用通用 AgentModCommandHandlerSchema。 */
const AgentModCommandHookHandlerSchema = AgentModCommandHandlerSchema
/** @deprecated 新代码使用通用 AgentModCommandHandler。 */
type AgentModCommandHookHandler = AgentModCommandHandler

const AgentModHookExecutionModes = ['blocking', 'background'] as const
type AgentModHookExecutionMode = (typeof AgentModHookExecutionModes)[number]

/**
 * Hook 挂接声明。
 *
 * - `blocking`：顺序等待，可在具有结果面的事件上拦截/改写；
 * - `background`：只观察，并发启动且忽略返回值，不得阻塞或改写主链。
 *
 * 函数 binding 与 command handler 共用本声明。`handler` 缺席表示使用编译期 binding；
 * 磁盘包若声明 command，Desktop 宿主在进入通用 Loader 前将其适配为同形 binding。
 */
const AgentModHookContributionSchema = z.strictObject({
  id: TrimmedIdSchema,
  event: AgentModHookEventSchema.optional(),
  /** @deprecated 过渡输入别名；解析结果只保留 `event`。 */
  seam: AgentModHookEventSchema.optional(),
  priority: z.number().int().optional(),
  reason: z.string().optional(),
  matcher: AgentModHookMatcherSchema.optional(),
  mode: z.enum(AgentModHookExecutionModes).default('blocking'),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
  handler: AgentModCommandHandlerSchema.optional(),
}).superRefine((value, context) => {
  if (!value.event && !value.seam) {
    context.addIssue({
      code: 'custom',
      path: ['event'],
      message: '必须声明 Hook event',
    })
  }
  if (value.event && value.seam && value.event !== value.seam) {
    context.addIssue({
      code: 'custom',
      path: ['seam'],
      message: '`event` 与过渡别名 `seam` 不得冲突',
    })
  }
}).transform(({ seam, ...value }) => ({
  ...value,
  event: value.event ?? seam!,
}))
type AgentModHookContribution = z.infer<typeof AgentModHookContributionSchema>

const AgentModContributesSchema = z.strictObject({
  tools: tolerantArray(AgentModToolContributionSchema).optional(),
  toolCategories: tolerantArray(AgentModToolCategoryContributionSchema).optional(),
  promptSegments: tolerantArray(AgentModPromptSegmentContributionSchema).optional(),
  skills: tolerantArray(AgentModSkillContributionSchema).optional(),
  spaces: tolerantArray(AgentModSpaceContributionSchema).optional(),
  subAgentTypes: tolerantArray(AgentModSubAgentTypeContributionSchema).optional(),
  turnContextSources: tolerantArray(
    AgentModTurnContextSourceContributionSchema
  ).optional(),
  executionModes: tolerantArray(AgentModExecutionModeContributionSchema).optional(),
  hooks: tolerantArray(AgentModHookContributionSchema).optional(),
})
type AgentModContributes = z.infer<typeof AgentModContributesSchema>

// ─── manifest 龙骨 ───────────────────────────────────────────────────────────

/** manifest 自身 schema 版本：新增字段和兼容迁移必须通过此版本演进。 */
const AgentModManifestSchemaVersion = 1 as const

const AgentModTrustLevels = [
  'bundled-official',
  'marketplace-signed',
  'local-dev',
] as const
type AgentModTrustLevel = (typeof AgentModTrustLevels)[number]

/**
 * 兼容双轴 + 领域轴。
 *
 * - `velaros`：mod ↔ Kernel module API 兼容范围（必填）。
 * - `agent`：mod ↔ Agent capability API 兼容范围（领域轴；不把所有兼容性挤进 `velaros` 一根轴）。
 * - `shell`：mod ↔ 产品壳兼容第二轴，只由壳检查；Agent Loader 只在宿主声明了 shellId 时校验。
 */
const AgentModEnginesSchema = z.strictObject({
  velaros: SemverRangeSchema,
  agent: SemverRangeSchema.optional(),
  shell: z.record(TrimmedIdSchema, SemverRangeSchema).optional(),
})
type AgentModEngines = z.infer<typeof AgentModEnginesSchema>

const AgentModManifestSchema = z.strictObject({
  id: TrimmedIdSchema,
  version: SemverVersionSchema,
  publisher: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  manifestSchemaVersion: z.literal(AgentModManifestSchemaVersion),
  engines: AgentModEnginesSchema,
  trust: z.enum(AgentModTrustLevels),
  /**
   * 声明的能力 scope。
   *
   * v1 只是声明与审计元数据；运行时能力 enforcement 由 capability broker 负责；
   * 既有工具类别可见性门不消费本字段，manifest 不得声称「走七门」。
   */
  permissions: tolerantArray(TrimmedIdSchema).optional(),
  /** 硬需求轴：宿主不支持其中任一轴时拒载，不做残缺激活。 */
  requiredAxes: tolerantArray(AgentModContributionAxisNameSchema).optional(),
  /** 付费资格声明：纯数据，不含价格、不做判定；核验由分发服务和产品宿主负责。 */
  entitlements: tolerantArray(TrimmedIdSchema).optional(),
  budget: z
    .strictObject({ residentPromptTokens: z.number().int().nonnegative().optional() })
    .optional(),
  /** i18n 文案包：v1 固定字段形状，是否合并及回退顺序由产品宿主公开。 */
  locale: z.record(TrimmedIdSchema, z.record(TrimmedIdSchema, z.string())).optional(),
  contributes: AgentModContributesSchema.default({}),
})
type AgentModManifest = z.infer<typeof AgentModManifestSchema>

// ─── 诊断与解析 ──────────────────────────────────────────────────────────────

/** 可读诊断：拒载/缺席/跳过一律经此上报，绝不静默。 */
interface AgentModDiagnostic {
  code: string
  message: string
  path?: string
  modId?: string
  origin?: string
}

type AgentModManifestParseResult =
  | { ok: true; manifest: AgentModManifest }
  | { ok: false; diagnostics: readonly AgentModDiagnostic[] }

interface ParseAgentModManifestOptions {
  /** 诊断里回显的来源（pack 目录 / bundled id）。 */
  origin?: string
}

function readOptionalModId(input: unknown) {
  if (!isPlainObject(input)) return undefined
  const id = Reflect.get(input, 'id')
  return isString(id) && !isBlank(id) ? id.trim() : undefined
}

/** 形态判定：有 `module` 节且没有九轴 manifest 必填字段 = 这是信封不是 agent 节。 */
function looksLikeVelarosModEnvelope(input: unknown): boolean {
  if (!isPlainObject(input)) return false
  return (
    isPlainObject(Reflect.get(input, 'module')) &&
    isUndefined(Reflect.get(input, 'manifestSchemaVersion'))
  )
}

/** 列出 manifest 实际声明了条目的贡献轴。 */
function listAgentModDeclaredAxes(
  manifest: AgentModManifest
): readonly AgentModContributionAxisName[] {
  return AgentModContributionAxisNames.filter((axis) => {
    const entries = Reflect.get(manifest.contributes, axis)
    return isArray(entries) && !isEmpty(entries)
  })
}

/** 取某轴条目的稳定主键（工具用 name，其余用 id）。 */
function readAgentModContributionKey(
  axis: AgentModContributionAxisName,
  entry: unknown
): string {
  const key = axis === 'tools' ? 'name' : 'id'
  const value = Reflect.get(entry as object, key)
  return isString(value) ? value : ''
}

/**
 * 解析并校验一份 Agent mod manifest。
 *
 * 宽容只在形态层（标量→数组、首尾空白）；未知字段、非法枚举、重复主键、requiredAxes 越界
 * 一律给可读诊断并拒载。
 */
function parseAgentModManifest(
  input: unknown,
  options: ParseAgentModManifestOptions = {}
): AgentModManifestParseResult {
  const origin = options.origin
  const modId = readOptionalModId(input)
  // 常见误用：把整个信封当成 agent 节喂进来。默认报错会是「未知字段 module」，指不到病因，
  // 所以在这里说清楚该做什么。
  if (looksLikeVelarosModEnvelope(input)) return {
      ok: false,
      diagnostics: [
        {
          code: 'mod.manifest-is-envelope',
          message: `传入的是分节单文件 ${VelarosModManifestFileName} 信封，不是 agent 节；请先取 \`envelope.agent\` 再解析。`,
          path: '<root>',
          origin,
        },
      ],
    }
  const parsed = AgentModManifestSchema.safeParse(input)
  if (!parsed.success) return {
      ok: false,
      diagnostics: parsed.error.issues.map((issue) => ({
        code: 'mod.manifest-invalid',
        message: issue.message,
        path: issue.path.join('.') || '<root>',
        modId,
        origin,
      })),
    }

  const manifest = parsed.data
  const diagnostics: AgentModDiagnostic[] = []

  for (const axis of AgentModContributionAxisNames) {
    const entries = Reflect.get(manifest.contributes, axis)
    if (!isArray(entries)) continue
    const seen = new Set<string>()
    for (const entry of entries) {
      const key = readAgentModContributionKey(axis, entry)
      if (seen.has(key)) {
        diagnostics.push({
          code: 'mod.duplicate-contribution',
          message: `贡献轴 ${axis} 内主键「${key}」重复；同一 mod 内主键必须唯一。`,
          path: `contributes.${axis}`,
          modId: manifest.id,
          origin,
        })
      }
      seen.add(key)
    }
  }

  const declaredAxes = new Set(listAgentModDeclaredAxes(manifest))
  for (const axis of manifest.requiredAxes ?? []) {
    if (declaredAxes.has(axis)) continue
    diagnostics.push({
      code: 'mod.required-axis-not-contributed',
      message: `requiredAxes 声明了 ${axis}，但 contributes 里没有该轴的条目；硬需求轴必须是自己实际贡献的轴。`,
      path: 'requiredAxes',
      modId: manifest.id,
      origin,
    })
  }

  if (!isEmpty(diagnostics)) return { ok: false, diagnostics }
  return { ok: true, manifest }
}

export {
  AgentModCommandHandlerSchema,
  AgentModCommandHookHandlerSchema,
  AgentModContributesSchema,
  AgentModContributionAxisNames,
  AgentModContributionAxisNameSchema,
  AgentModEnginesSchema,
  AgentModExecutionModeContributionSchema,
  AgentModHookContributionSchema,
  AgentModHookEvents,
  AgentModHookEventSchema,
  AgentModHookExecutionModes,
  AgentModHookMatcherSchema,
  AgentModManifestSchema,
  AgentModManifestSchemaVersion,
  AgentModPromptSegmentContributionSchema,
  AgentModSeamKinds,
  AgentModSeamKindSchema,
  AgentModSkillContributionSchema,
  AgentModSpaceContributionSchema,
  AgentModSubAgentTypeContributionSchema,
  AgentModToolCategoryContributionSchema,
  AgentModToolContributionSchema,
  AgentModTrustLevels,
  AgentModTurnContextSourceContributionSchema,
  isSemverRangeParsable,
  listAgentModDeclaredAxes,
  parseAgentModManifest,
  readAgentModContributionKey,
  satisfiesSemverRange,
}
export type {
  AgentModCommandHandler,
  AgentModCommandHookHandler,
  AgentModContributes,
  AgentModContributionAxisName,
  AgentModDiagnostic,
  AgentModEngines,
  AgentModExecutionModeContribution,
  AgentModHookContribution,
  AgentModHookEvent,
  AgentModHookExecutionMode,
  AgentModHookMatcher,
  AgentModManifest,
  AgentModManifestParseResult,
  AgentModPromptSegmentContribution,
  AgentModSeamKind,
  AgentModSkillContribution,
  AgentModSpaceContribution,
  AgentModSubAgentTypeContribution,
  AgentModToolCategoryContribution,
  AgentModToolContribution,
  AgentModTrustLevel,
  AgentModTurnContextSourceContribution,
  ParseAgentModManifestOptions,
}
