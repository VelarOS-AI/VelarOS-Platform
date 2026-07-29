// 域：Agent 领域 Mod Manifest（两级注册机的第二级数据契约）。
//
// 第一级 = Kernel Module Host：只解析窄 `KernelModuleDescriptor`（id/version/apiVersion/
// provides/requires/permissions/isolation），永不解析本文件的任何贡献轴。
// 第二级 = Agent 领域 Loader（`@velaros-ai/agent-runtime` 的 `mods/`）：owner module 激活后
// 加载本 manifest，把贡献轴分发进各自的注册面。
//
// 铁律（蓝图 §3.4 C26）：**validate 先于任何归一化**——冲突、非法、缺绑定一律拒载并给可读
// 诊断，绝不静默降级、绝不静默丢弃。本文件的宽容只发生在**形态**层（标量→单元素数组、
// 首尾空白），语义层零宽容。
import { z } from 'zod'

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
function parseSemverVersion(text: string): SemverVersion | null {
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

function parseSemverComparator(text: string): SemverComparator | null {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === '*' || trimmed === 'x') return { kind: 'any' }
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
 * 只做大版本判定（蓝图 §3.2），复杂 range 属 npm 求解器职责（裁决 4：不写依赖求解器）。
 */
function isSemverRangeParsable(range: string): boolean {
  const clauses = range.split('||')
  if (clauses.length === 0) return false
  return clauses.every((clause) => {
    const comparators = clause.trim().split(/\s+/u).filter((part) => part !== '')
    if (comparators.length === 0) return false
    return comparators.every((part) => parseSemverComparator(part) !== null)
  })
}

/** 判定 version 是否满足 range；range 或 version 非法一律返回 false（fail-closed）。 */
function satisfiesSemverRange(version: string, range: string): boolean {
  const parsedVersion = parseSemverVersion(version)
  if (!parsedVersion) return false
  return range.split('||').some((clause) => {
    const comparators = clause.trim().split(/\s+/u).filter((part) => part !== '')
    if (comparators.length === 0) return false
    return comparators.every((part) => {
      const comparator = parseSemverComparator(part)
      return comparator !== null && satisfiesComparator(parsedVersion, comparator)
    })
  })
}

// ─── 贡献轴闭集 ──────────────────────────────────────────────────────────────

/**
 * Agent 领域贡献轴闭集。
 *
 * 贡献点由官方演进，mod 不能发明新轴（蓝图 §3.2）。壳级 UI 轴（pages/settingsRenderers/
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
 * 拦截 seam 闭集（裁决 9 机制②）。
 *
 * mod 只能挂接，不能发明新钩子。首批**真接线**的钩子见 agent-runtime 的 `mods/AgentModSeams.ts`
 * 与 docs/agent-mod-trunk.md 的残余清单；未接线者只有注册面与类型，dispatch 恒无调用点。
 */
const AgentModSeamKinds = [
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

type AgentModSeamKind = (typeof AgentModSeamKinds)[number]

const AgentModSeamKindSchema = z.enum(AgentModSeamKinds)

// ─── 形态层宽容原语 ──────────────────────────────────────────────────────────

/** 标量→单元素数组；其余原样交给下游 schema 报错（不吞毁）。 */
function tolerantArray<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return z.preprocess(
    (value) => (typeof value === 'string' ? [value] : value),
    z.array(schema)
  )
}

const TrimmedIdSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, { message: '不能为空' })

const SemverRangeSchema = TrimmedIdSchema.refine(isSemverRangeParsable, {
  message: '不是可解析的 semver range（支持 * / 1.2.3 / ^1.2.3 / ~1.2.3 / >=1.2.3，空白=合取，||=析取）',
})

const SemverVersionSchema = TrimmedIdSchema.refine(
  (value) => parseSemverVersion(value) !== null,
  { message: '不是合法的 x.y.z 版本号' }
)

// ─── 各轴贡献条目 ────────────────────────────────────────────────────────────

/** 工具贡献：`name` 是全宿主唯一键（裁决 5 工具名唯一性，冲突拒载）。 */
const AgentModToolContributionSchema = z.strictObject({
  name: TrimmedIdSchema,
  categoryId: TrimmedIdSchema.optional(),
  summary: z.string().optional(),
  readOnly: z.boolean().optional(),
  /** 声明本工具在哪些 space 常驻（数据条目，由宿主常驻集算法消费）。 */
  residentInSpaces: tolerantArray(TrimmedIdSchema).optional(),
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
  spaces: tolerantArray(TrimmedIdSchema).optional(),
  priority: z.number().int().optional(),
})
type AgentModSkillContribution = z.infer<typeof AgentModSkillContributionSchema>

/** space descriptor 的纯数据面（蓝图 §3.3：icon 降格为 icon-id，不接受组件/函数引用）。 */
const AgentModSpaceContributionSchema = z.strictObject({
  id: TrimmedIdSchema,
  descriptor: z.strictObject({
    label: z.string(),
    hint: z.string().optional(),
    startTitle: z.string().optional(),
    order: z.number().int().optional(),
    localeKey: TrimmedIdSchema.optional(),
  }),
  iconId: TrimmedIdSchema.optional(),
  identityStrategy: z.enum(['ordinal', 'path', 'origin']),
  surfaceProfileId: TrimmedIdSchema.optional(),
  boundCapabilityIds: tolerantArray(TrimmedIdSchema).optional(),
  toolCategoryIds: tolerantArray(TrimmedIdSchema).optional(),
  residentToolNames: tolerantArray(TrimmedIdSchema).optional(),
  /** 本 space 允许的 per-turn 上下文源白名单（mod 进入每回合上下文的唯一通道）。 */
  turnContextSourceIds: tolerantArray(TrimmedIdSchema).optional(),
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

/** 钩子挂接声明（裁决 9 机制②）；handler 由运行态绑定提供，缺绑定拒载。 */
const AgentModHookContributionSchema = z.strictObject({
  id: TrimmedIdSchema,
  seam: AgentModSeamKindSchema,
  priority: z.number().int().optional(),
  reason: z.string().optional(),
})
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

/** manifest 自身 schema 版本：演进通道，加字段靠它平滑（蓝图 §3.2）。 */
const AgentModManifestSchemaVersion = 1 as const

/** pack 目录内的 Agent 轴 manifest 文件名（宿主组装入口按此名读取）。 */
const AgentModPackManifestFileName = 'velaros.agent.mod.json'

/**
 * Kernel pack descriptor 的 `provides` 里代表「本 pack 含 Agent 轴贡献」的能力 id。
 *
 * 与 `AgentCapability` 令牌 id 同值——宿主据此从 kernel 的 pack 清单里筛出该喂给 Agent Loader
 * 的那批 pack，其余 pack 归各自 owner module。
 */
const AgentModPackProvidesId = 'velaros.agent'

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
   * v1 只是声明与审计元数据——真正的能力 enforcement 是尚未建成的层（蓝图 §3.2 注）；
   * 既有工具类别可见性门不消费本字段，manifest 不得声称「走七门」。
   */
  permissions: tolerantArray(TrimmedIdSchema).optional(),
  /** 硬需求轴：宿主不支持其中任一轴 → 拒载（不做残废激活，蓝图 §3.4 partial-activation 第 3 条）。 */
  requiredAxes: tolerantArray(AgentModContributionAxisNameSchema).optional(),
  /** 付费资格声明（蓝图 §3.9 占位）：纯数据，不含价格、不做判定；核验住在 Cloud + 市场。 */
  entitlements: tolerantArray(TrimmedIdSchema).optional(),
  budget: z
    .strictObject({ residentPromptTokens: z.number().int().nonnegative().optional() })
    .optional(),
  /** i18n 文案包（蓝图 §3.8）：v1 只定死字段形状，运行时合并链随市场链路。 */
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

function readOptionalModId(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const id = Reflect.get(input, 'id')
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined
}

/** 列出 manifest 实际声明了条目的贡献轴。 */
function listAgentModDeclaredAxes(
  manifest: AgentModManifest
): readonly AgentModContributionAxisName[] {
  return AgentModContributionAxisNames.filter((axis) => {
    const entries = Reflect.get(manifest.contributes, axis)
    return Array.isArray(entries) && entries.length > 0
  })
}

/** 取某轴条目的稳定主键（工具用 name，其余用 id）。 */
function readAgentModContributionKey(
  axis: AgentModContributionAxisName,
  entry: unknown
): string {
  const key = axis === 'tools' ? 'name' : 'id'
  const value = Reflect.get(entry as object, key)
  return typeof value === 'string' ? value : ''
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
    if (!Array.isArray(entries)) continue
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

  if (diagnostics.length > 0) return { ok: false, diagnostics }
  return { ok: true, manifest }
}

export {
  AgentModContributesSchema,
  AgentModContributionAxisNames,
  AgentModContributionAxisNameSchema,
  AgentModEnginesSchema,
  AgentModExecutionModeContributionSchema,
  AgentModHookContributionSchema,
  AgentModManifestSchema,
  AgentModManifestSchemaVersion,
  AgentModPackManifestFileName,
  AgentModPackProvidesId,
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
  AgentModContributes,
  AgentModContributionAxisName,
  AgentModDiagnostic,
  AgentModEngines,
  AgentModExecutionModeContribution,
  AgentModHookContribution,
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
