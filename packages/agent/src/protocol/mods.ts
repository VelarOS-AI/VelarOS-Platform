// 域：Agent 领域 Mod Manifest（两级注册机的第二级数据契约）。
//
// 第一级 = Kernel Module Host：只解析窄 `KernelModuleDescriptor`（id/version/apiVersion/
// provides/requires/permissions/isolation），永不解析本文件的任何贡献轴。
// 第二级 = Agent 领域 Loader（`@velaros-ai/agent` 的 `mods/`）：owner module 激活后
// 加载本 manifest，把贡献轴分发进各自的注册面。
//
// 铁律（蓝图 §3.4 C26）：**validate 先于任何归一化**——冲突、非法、缺绑定一律拒载并给可读
// 诊断，绝不静默降级、绝不静默丢弃。本文件的宽容只发生在**形态**层（标量→单元素数组、
// 首尾空白），语义层零宽容。
import { z } from 'zod'

import {
  isArray,
  isBlank,
  isEmpty,
  isNotNull,
  isPlainObject,
  isPresent,
  isString,
  isUndefined,
} from '@velaros-ai/core'
import { isCanonicalToolId } from '@velaros-ai/core/tool-contract'

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
 * 只做大版本判定（蓝图 §3.2），复杂 range 属 npm 求解器职责（裁决 4：不写依赖求解器）。
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
    (value) => (isString(value) ? [value] : value),
    z.array(schema)
  )
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

/** 工具贡献：`name` 是全宿主唯一键（裁决 5 工具名唯一性，冲突拒载）。 */
const AgentModToolContributionSchema = z.strictObject({
  name: CanonicalToolIdSchema,
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
  /** 复用另一个空间已经拼装好的职责包；用于 Game 等项目型空间继承 Project 配方。 */
  inheritsSpaceIds: tolerantArray(TrimmedIdSchema).optional(),
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

/**
 * pack 目录内的**分节单文件 manifest** 文件名（宿主组装入口按此名读取）。
 *
 * 蓝图 v6 §8.3：一个 mod = 一个 `velaros.mod.json`，内分 `module` / `agent` / `ui` 三节。
 * 旧的 `velaros.agent.mod.json` 已 clean break 退役，不留文件名兼容。
 */
const VelarosModManifestFileName = 'velaros.mod.json'

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

// ─── 分节单文件信封 velaros.mod.json（蓝图 v6 §8.3） ─────────────────────────
//
// 铁律 —— **各 owner 只读各节**：
//   `module` → Kernel 读（窄 module descriptor：谁、什么版本、提供/依赖什么能力、怎么隔离）
//   `agent`  → Agent 主干读（本文件上半部分的九轴 manifest，原样搬进信封，内容零变化）
//   `ui`     → 产品壳读（Agent 侧**不解析**，这里只留位置与不透明性）
//
// 「不透明信封」在这里比透传更强：不是「读了但不解释」，而是**根本不读别人那一节**。
// 唯一的跨节动作是身份复核（module.id ↔ agent.id），因为一个 mod 不能有两个身份。
//
// 为什么单文件而不是三文件：签名 / 版本 / 回滚要覆盖的产物只有一份，「这个 mod 的完整声明
// 是什么」才有单一答案；读取权按节切就够挡住「加载器重新长成上帝对象」。

/** 标量 id → `{ id }`（形态层宽容；语义零宽容）。 */
function tolerantCapabilityRef<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return z.preprocess(
    (value) => (isString(value) ? { id: value } : value),
    schema
  )
}

/** 能力令牌的 JSON 形态（对齐 core/kernel/abi 的 `CapabilityToken`）。 */
const VelarosModCapabilityTokenSchema = z.strictObject({
  id: TrimmedIdSchema,
  version: TrimmedIdSchema.default('1.0.0'),
})

/** 能力依赖的 JSON 形态（对齐 core/kernel/abi 的 `CapabilityRequirement`）。 */
const VelarosModCapabilityRequirementSchema = z.strictObject({
  id: TrimmedIdSchema,
  versionRange: SemverRangeSchema.optional(),
})

/**
 * `module` 节 —— **Kernel 拥有**，形状对齐 `KernelModuleManifest`（单一事实来源在
 * `@velaros-ai/core/kernel/abi`；本文件只是它的磁盘 JSON 投影，不是第二个定义）。
 *
 * `entry` / `exportName` 是 Kernel 侧的**装载寻址**：pack 目录里哪一个文件导出这个模块。
 * 它们只对 installed pack 有意义（bundled pack 走构建图，没有寻址问题）。
 *
 * 本 schema 住在 agent-protocol 而不是 core，是因为**依赖方向**：契约层（①）不得反向依赖
 * Kernel 库（②）。Kernel 侧读同一节时用它自己的窄读取器——两个 owner 各读各节，正是 §8.3
 * 要的形状。
 */
const VelarosModModuleSectionSchema = z.strictObject({
  id: TrimmedIdSchema,
  version: SemverVersionSchema,
  apiVersion: z.number().int().positive(),
  provides: tolerantArray(
    tolerantCapabilityRef(VelarosModCapabilityTokenSchema)
  ).default([]),
  requires: tolerantArray(
    tolerantCapabilityRef(VelarosModCapabilityRequirementSchema)
  ).default([]),
  optionalRequires: tolerantArray(
    tolerantCapabilityRef(VelarosModCapabilityRequirementSchema)
  ).default([]),
  permissions: tolerantArray(TrimmedIdSchema).default([]),
  isolation: z.enum(['in-process', 'worker', 'sidecar']).default('in-process'),
  entry: TrimmedIdSchema.optional(),
  exportName: TrimmedIdSchema.optional(),
})
type VelarosModModuleSection = z.infer<typeof VelarosModModuleSectionSchema>

/**
 * 信封本体。
 *
 * `strictObject` 是有意的：节的闭集由官方演进，mod 不能发明第四节——否则「谁读它」就没有答案。
 * `agent` / `ui` 声明成 `unknown`：信封层只负责**分节与路由**，节内容归各自 owner 校验。
 */
const VelarosModEnvelopeSchema = z.strictObject({
  module: VelarosModModuleSectionSchema,
  agent: z.unknown().optional(),
  ui: z.unknown().optional(),
})
type VelarosModEnvelope = z.infer<typeof VelarosModEnvelopeSchema>

type VelarosModEnvelopeParseResult =
  | { ok: true; envelope: VelarosModEnvelope }
  | { ok: false; diagnostics: readonly AgentModDiagnostic[] }

/**
 * 解析一份 `velaros.mod.json` 的**信封**：校验分节形状与 `module` 节，其余节原样交还。
 *
 * 刻意不碰 `agent` / `ui` 的内容——取到节之后由各自 owner 校验（Agent 侧走
 * {@link parseAgentModManifest}）。
 */
function parseVelarosModEnvelope(
  input: unknown,
  options: ParseAgentModManifestOptions = {}
): VelarosModEnvelopeParseResult {
  const origin = options.origin
  const parsed = VelarosModEnvelopeSchema.safeParse(input)
  if (!parsed.success) return {
      ok: false,
      diagnostics: parsed.error.issues.map((issue) => ({
        code: 'mod.envelope-invalid',
        message: issue.message,
        path: issue.path.join('.') || '<root>',
        origin,
      })),
    }

  const envelope = parsed.data
  // 身份复核：这是唯一一处跨节动作。一个 mod 只能有一个身份，两节各报一个 id 是事故形态
  // （安装器按 module.id 落盘，Agent 注册机按 agent.id 记账，之后二者永远对不上）。
  const agentId = readOptionalModId(envelope.agent)
  if (isPresent(agentId) && agentId !== envelope.module.id) return {
      ok: false,
      diagnostics: [
        {
          code: 'mod.envelope-id-mismatch',
          message: `module 节的 id「${envelope.module.id}」与 agent 节的 id「${agentId}」不一致；一个 mod 只能有一个身份。`,
          path: 'agent.id',
          modId: envelope.module.id,
          origin,
        },
      ],
    }

  return { ok: true, envelope }
}

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
  AgentModContributesSchema,
  AgentModContributionAxisNames,
  AgentModContributionAxisNameSchema,
  AgentModEnginesSchema,
  AgentModExecutionModeContributionSchema,
  AgentModHookContributionSchema,
  AgentModManifestSchema,
  AgentModManifestSchemaVersion,
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
  parseVelarosModEnvelope,
  readAgentModContributionKey,
  satisfiesSemverRange,
  VelarosModCapabilityRequirementSchema,
  VelarosModCapabilityTokenSchema,
  VelarosModEnvelopeSchema,
  VelarosModManifestFileName,
  VelarosModModuleSectionSchema,
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
  VelarosModEnvelope,
  VelarosModEnvelopeParseResult,
  VelarosModModuleSection,
}
