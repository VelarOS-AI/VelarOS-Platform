/**
 * 工作区内核工具共享定义。
 *
 * 这里集中保存桌面工作区工具覆写层复用的结构、参数描述、能力声明、
 * 归一化辅助函数与错误提示；真正的工具注册在 `Kernel.tool.ts`。
 *
 * 内核事务编辑流程：
 *   1. 准备编辑 —— 暂存操作、生成 diff，不写盘
 *   2. 校验 ——（可选）对事务暂存内容运行校验器
 *   3. 应用编辑 —— 通过 revision 与锁检查后写入
 *   4. 一步提交 —— 准备、校验，通过后应用
 *   5. 回滚 —— 撤销已应用的事务
 *
 * 本模块面向模型的工具描述和结构说明文案统一使用中文。
 */
import { z } from 'zod'

import { isArray, isEmpty, isFalse, isNonBlankString, isPlainObject, isPositiveNumber,isPresent, isString, toOptional } from '@velaros-ai/core'
import type { ToolCapabilitySchema } from '@velaros-ai/core/types'
import { optionalWhenLazy } from '@velaros-ai/core/utils/optionalWhen'
import {
  compactStructuredParameterDescription,
  compactStructuredToolDescription,
  renderParameterDescription,
  type StructuredParameterDescriptionSpec,
  type ToolDescriptionDetail,
} from '@velaros-ai/core/utils/ToolDescription'

import {
  amendEditInputSchema,
  commitEditInputSchema,
  editIntentSchema,
  editOperationUnion,
  prepareEditInputSchema,
} from '../tool-schemas.js'
import { WorkspaceKernelToolNames } from '../workspace-tool-names.js'

import type { VelaTool } from './Types'
import {
  type AgentWorkspaceApplyResult,
  type AgentWorkspaceDiagnostic,
  type AgentWorkspaceFixResult,
  type AgentWorkspaceKernelPort,
  type AgentWorkspacePreparedTransaction,
  type AgentWorkspaceValidationResult,
  isAgentWorkspaceError,
  toAgentWorkspaceErrorObject,
} from './WorkspaceCapabilityPort'

export const wsTool = WorkspaceKernelToolNames

/**
 * 工作区内核工具面向模型的描述详细程度（L4 渐进式披露）。这是单一开关，一行即可回退：
 * 'compact'（默认）压缩工具描述与参数描述里的建议性分节；'full' 保留作者写下的全部要点。
 * 始终完整保留：工具级 `强制流程` 门禁、参数级 `取值` 枚举。
 */
export const WorkspaceToolDescriptionDetail: ToolDescriptionDetail = 'compact'

/** 渲染结构化参数描述；compact 模式下保留 描述/取值，仅压缩 用法/注意 到首条。 */
export function parameterDescription(spec: StructuredParameterDescriptionSpec): string {
  const rendered = renderParameterDescription(spec)
  return WorkspaceToolDescriptionDetail === 'compact'
    ? compactStructuredParameterDescription(rendered)
    : rendered
}

/** 按详细程度处理单个工具及其 surfaces 的结构化描述。 */
function withToolDescriptionDetail<T extends VelaTool<any>>(
  tool: T,
  detail: ToolDescriptionDetail
): T {
  if (detail === 'full') return tool
  const next: T = { ...tool, description: compactStructuredToolDescription(tool.description) }
  if (isPresent(next.surfaces)) {
    next.surfaces = Object.fromEntries(
      Object.entries(next.surfaces).map(([id, surface]) => [
        id,
        isPresent(surface)
          ? { ...surface, description: compactStructuredToolDescription(surface.description) }
          : surface,
      ])
    ) as T['surfaces']
  }
  return next
}

/** 对整组工作区内核工具应用统一的描述详细程度，保留精确的逐键类型。 */
export function applyWorkspaceToolDescriptionDetail<T extends Record<string, VelaTool<any>>>(
  tools: T,
  detail: ToolDescriptionDetail
): T {
  if (detail === 'full') return tools
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [name, withToolDescriptionDetail(tool, detail)])
  ) as T
}

export const workspaceCwdDescription = parameterDescription({
  description: '当前工作区内的执行目录。',
  usage: ['传相对工作区根目录的子目录；只有指向其它项目时才进入或切换目标工作区。'],
})

// ---------------------------------------------------------------------------
// 复用型参数描述（单一来源）—— 同一参数在多个工具/批处理 schema 里出现时，
// 统一从这里取，避免手抄多份、措辞漂移，降低维护成本（对齐 tool-concepts 思路）。
// ---------------------------------------------------------------------------

export const workspaceExtensionsParam = parameterDescription({
  description: '扩展名过滤。',
  usage: ['传不带点号的扩展名，如 ts、tsx。'],
  notes: ['内部会转换成对应 glob。'],
})

export const workspaceExcludePresetsParam = parameterDescription({
  description: '常用排除预设。',
  values: [
    'vcs：版本控制目录，例如 .git。',
    'dependencies：依赖目录，例如 node_modules、.pnpm、.yarn。',
    'build-output：构建产物目录，例如 dist、build、out。',
    'test-artifacts：测试产物目录，例如 coverage、test-results、playwright-report。',
    'common-source-noise：上述常见源码噪声合集。',
  ],
})

export const workspaceExcludeParam = parameterDescription({
  description: '额外排除的 glob。',
  usage: ['例如 **/*.snap 或 fixtures/**。'],
  notes: ['会叠加在默认 .gitignore 排除之后。'],
})

export const workspaceExcludeGitignoredParam = parameterDescription({
  description: '是否遵守 .gitignore 与 git exclude。',
  notes: ['根目录默认 true；明确 path 子树时默认 false。'],
})

export const workspaceAllowUnboundedParam = parameterDescription({
  description: '是否显式允许无界读取。',
  usage: [
    '只有确认文件足够小或调用方能承受完整内容时才传 true；默认必须提供 range、maxBytes 或 maxChars。',
  ],
})

export const workspaceBaseRevisionsParam = parameterDescription({
  description: '期望的文件 revision 映射。',
  usage: ['键是 paths 中的工作区相对路径，值是该路径期望的 revision。'],
})

export const workspaceRegexParam = parameterDescription({
  description: '是否把 query 当作正则表达式。',
})

export const workspaceCaseSensitiveParam = parameterDescription({
  description: '是否区分大小写。',
  notes: ['默认 false；只有显式传 true 时才区分大小写。'],
})

export const workspaceMaxResultsParam = parameterDescription({
  description: '最多返回的命中条数。',
  notes: ['最大 500。'],
})

export const BASE_REVISION_MISMATCH_AGENT_HINT =
  ' 提示：请重新通过「读文件」能力获取内容并限定 range/maxBytes 等上界，再基于本次返回的 snapshot.revision 准备新的编辑事务（勿沿用过期 revision）。'

export function augmentRevisionMismatchMessage(error: any): void {
  if (!isAgentWorkspaceError(error, 'BASE_REVISION_MISMATCH')) return
  error.message = `${error.message}${BASE_REVISION_MISMATCH_AGENT_HINT}`
  error.suggestedNextAction ??=
    '请重新读取受影响路径，并用最新的 baseRevision 重建编辑事务准备步骤。'
}

export const PREPARE_EDIT_TEXT_SNAPSHOT_HINT_ZH = ` 说明：若缺少文本快照，多为路径/targetId 未解析到可读文件，或对话里上一份「读文件」已被历史消毒替换为 stale:true 占位；请先 ${wsTool.read}（带界）取得正文与 revision，再调用本工具。`

export const MODEL_PREFLIGHT_CONFIRM_FIELD = 'confirmRisk'

export type ModelPreflightSeverity = 'notice' | 'caution' | 'danger'

export interface ModelPreflightAdvisory {
  code: string
  severity: ModelPreflightSeverity
  message: string
  paths?: string[]
  suggestions?: string[]
}

export function buildModelPreflightResult(action: string, advisories: ModelPreflightAdvisory[]) {
  const reasons = advisories.map((advisory) => advisory.message)
  return {
    status: 'needs_model_review' as const,
    action,
    changed: false,
    applied: false,
    blocked: true,
    confirmField: MODEL_PREFLIGHT_CONFIRM_FIELD,
    message:
      '本次调用命中工作区风险预检。工具尚未执行；模型可以修改参数后重试，或在确认必要性后带 confirmRisk:true 强制执行。',
    reasons,
    advisories,
    nextActions: [
      '若风险来自未排除目录，请补充 excludePresets 或 exclude 后重试。',
      '若风险来自编辑目标或操作类型，请先审阅原因、缩小范围或重新定位目标。',
      `若确认必须执行，请用相同参数加 ${MODEL_PREFLIGHT_CONFIRM_FIELD}:true 重试。`,
    ],
  }
}

export function uniqueValues(values: Array<LooseOptional<string>>): string[] {
  return [
    ...new Set(
      values.filter((value): value is string => !!value?.trim()).map((value) => value.trim())
    ),
  ]
}

export const WorkspaceRiskyPathPatterns = [
  {
    id: 'vcs',
    label: '版本控制目录',
    pattern: /^\.git(?:\/|$)/,
    excludeHints: ['vcs', '.git/**'],
  },
  {
    id: 'dependencies',
    label: '依赖目录',
    pattern: /^(node_modules|\.pnpm|\.yarn|bower_components)(?:\/|$)/,
    excludeHints: ['dependencies', 'node_modules/**'],
  },
  {
    id: 'build-output',
    label: '构建产物目录',
    pattern: /^(dist|build|out|\.next|\.nuxt|\.vite)(?:\/|$)/,
    excludeHints: ['build-output', 'dist/**'],
  },
  {
    id: 'test-artifacts',
    label: '测试产物目录',
    pattern: /^(coverage|test-results|playwright-report|\.nyc_output)(?:\/|$)/,
    excludeHints: ['test-artifacts', 'coverage/**'],
  },
  {
    id: 'sensitive',
    label: '敏感配置或 secrets 路径',
    pattern: /(^\.env(?:\.|$)|(^|\/)secrets\/)/,
    excludeHints: ['.env', '.env.*', '**/secrets/**'],
  },
] as const

export function normalizeToolPath(pathValue: LooseOptional<string>): string {
  return pathValue?.trim().replace(/\\/g, '/').replace(/^\.\//, '') ?? ''
}

export function riskyPathAdvisories(
  paths: Array<LooseOptional<string>>,
  description: string
): ModelPreflightAdvisory[] {
  const normalizedPaths = uniqueValues(paths.map(normalizeToolPath))
  return WorkspaceRiskyPathPatterns.flatMap((rule) => {
    const matches = normalizedPaths.filter((pathValue) => rule.pattern.test(pathValue))
    return isEmpty(matches)
      ? []
      : [
          {
            code: `workspace-risk-path:${rule.id}`,
            severity: rule.id === 'sensitive' || rule.id === 'vcs' ? 'danger' : 'caution',
            message: `${description} 涉及${rule.label}，请确认这是任务所需，而不是范围过宽或未排除目录导致。`,
            paths: matches,
            suggestions: [
              `若非必要，请排除：${rule.excludeHints.join(' / ')}`,
              `若必要，请带 ${MODEL_PREFLIGHT_CONFIRM_FIELD}:true 重试。`,
            ],
          } satisfies ModelPreflightAdvisory,
        ]
  })
}

export type WorkspaceToolCapabilitySchema = ToolCapabilitySchema & {
  metadata: Readonly<Record<string, unknown>>
}

export function defineWorkspaceToolCapability<
  const TCapability extends WorkspaceToolCapabilitySchema,
>(capability: TCapability): TCapability {
  return capability
}

export const WorkspaceReadCapability = {
  effectKind: 'read',
  readScopes: ['workspace'],
  filesystem: { read: 'workspace', write: 'none' },
  metadata: {
    workspace: {
      requiresActiveProject: true,
      requiresWorkspaceSwitchForExternalCwd: true,
      mutation: 'none',
      arbitraryRead: true,
    },
  },
  concurrency: 'safe',
  reason: 'workspace inspection',
} satisfies WorkspaceToolCapabilitySchema

export const WorkspaceTransactionPrepareCapability = {
  effectKind: 'write',
  readScopes: ['workspace'],
  writeScopes: ['workspace'],
  filesystem: { read: 'workspace', write: 'workspace' },
  metadata: {
    workspace: {
      requiresActiveProject: true,
      requiresWorkspaceSwitchForExternalCwd: true,
      mutation: 'transaction-prepare',
    },
    canMutateWorkspace: false,
  },
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'prepare workspace transaction',
} satisfies WorkspaceToolCapabilitySchema

export const WorkspaceTransactionAmendCapability = {
  effectKind: 'write',
  readScopes: ['workspace'],
  writeScopes: ['workspace'],
  filesystem: { read: 'workspace', write: 'workspace' },
  metadata: {
    workspace: {
      requiresActiveProject: true,
      mutation: 'transaction-amend',
    },
    canMutateWorkspace: false,
  },
  transaction: { scopeFields: ['transactionId'] },
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'amend prepared workspace transaction',
} satisfies WorkspaceToolCapabilitySchema

export const WorkspaceTransactionApplyCapability = {
  effectKind: 'write',
  readScopes: ['workspace'],
  writeScopes: ['workspace'],
  filesystem: { read: 'workspace', write: 'workspace' },
  metadata: {
    workspace: {
      requiresActiveProject: true,
      mutation: 'transaction-apply',
    },
  },
  transaction: { scopeFields: ['transactionId'] },
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'apply workspace transaction',
} satisfies WorkspaceToolCapabilitySchema

export const WorkspaceTransactionCommitCapability = {
  effectKind: 'write',
  readScopes: ['workspace'],
  writeScopes: ['workspace'],
  filesystem: { read: 'workspace', write: 'workspace' },
  metadata: {
    workspace: {
      requiresActiveProject: true,
      requiresWorkspaceSwitchForExternalCwd: true,
      mutation: 'transaction-commit',
    },
    canMutateWorkspace: true,
  },
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'prepare, validate and apply workspace transaction',
} satisfies WorkspaceToolCapabilitySchema

export const WorkspaceTransactionRollbackCapability = {
  effectKind: 'write',
  readScopes: ['workspace'],
  writeScopes: ['workspace'],
  filesystem: { read: 'workspace', write: 'workspace' },
  metadata: {
    workspace: {
      requiresActiveProject: true,
      mutation: 'transaction-rollback',
    },
  },
  transaction: { scopeFields: ['transactionId'] },
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'rollback workspace transaction',
} satisfies WorkspaceToolCapabilitySchema

export const WorkspaceTransactionValidateCapability = {
  effectKind: 'read',
  readScopes: ['workspace'],
  filesystem: { read: 'workspace', write: 'none' },
  metadata: {
    workspace: {
      requiresActiveProject: true,
      mutation: 'transaction-validate',
      arbitraryRead: true,
    },
  },
  transaction: { scopeFields: ['transactionId'], preApplyValidationWhenScoped: true },
  concurrency: 'safe',
  reason: 'workspace transaction or path validation',
} satisfies WorkspaceToolCapabilitySchema

export const WorkspaceTransactionInspectCapability = {
  effectKind: 'transaction_inspect',
  readScopes: ['workspace'],
  filesystem: { read: 'workspace', write: 'none' },
  metadata: {
    workspace: {
      requiresActiveProject: true,
      mutation: 'transaction-inspect',
    },
  },
  transaction: { scopeFields: ['transactionId', 'sessionTransactionIds'] },
  concurrency: 'safe',
  reason: 'workspace transaction diff inspection',
} satisfies WorkspaceToolCapabilitySchema

export const WorkspaceTransactionBatchCapability = {
  effectKind: 'write',
  readScopes: ['workspace'],
  writeScopes: ['workspace'],
  filesystem: { read: 'workspace', write: 'workspace' },
  metadata: {
    workspace: {
      requiresActiveProject: true,
      mutation: 'transaction-batch',
    },
  },
  concurrency: 'unsafe',
  reason: 'workspace batch mixes read, write and validation phases',
} satisfies WorkspaceToolCapabilitySchema

/** 将内核 NOT_SUPPORTED（文本补丁快照相关）补充为对模型更友好的中文上下文。 */
export function augmentPrepareEditSnapshotHints(error: any): void {
  if (!isAgentWorkspaceError(error, 'NOT_SUPPORTED')) return
  const msg = error.message
  if (msg.includes('cannot edit binary files')) {
    error.message = `${msg} 请改用非文本补丁流程处理该二进制文件。`
    error.suggestedNextAction ??=
      '避免对二进制路径使用 replace_text / insert_text 等文本类 operation。'
    return
  }
  if (msg.includes('loaded text snapshot')) {
    error.message = `${msg}${PREPARE_EDIT_TEXT_SNAPSHOT_HINT_ZH}`
    error.suggestedNextAction ??= `确认 operation.path、op.from 或 targetId；必要时重新 ${wsTool.read} 并用返回的 snapshot.revision 作为 baseRevision。`
  }
}

// ---------------------------------------------------------------------------
// Helper: extract kernel from context and assert workspace auth for writes
// ---------------------------------------------------------------------------

export type Ctx = Parameters<VelaTool<Record<string, never>>['execute']>[1]

export async function requireKernel(ctx: Ctx) {
  return ctx.workspace.kernel()
}

export const WorkspaceSearchExcludePresetIds = [
  'vcs',
  'dependencies',
  'build-output',
  'test-artifacts',
  'common-source-noise',
] as const

export type WorkspaceSearchExcludePreset = (typeof WorkspaceSearchExcludePresetIds)[number]

export const WorkspaceSearchExcludePresetGlobs: Record<WorkspaceSearchExcludePreset, readonly string[]> = {
  vcs: ['.git/**'],
  dependencies: ['node_modules/**', '.pnpm/**', '.yarn/**', 'bower_components/**'],
  'build-output': ['dist/**', 'build/**', 'out/**', '.next/**', '.nuxt/**', '.vite/**'],
  'test-artifacts': ['coverage/**', 'test-results/**', 'playwright-report/**', '.nyc_output/**'],
  'common-source-noise': [
    '.git/**',
    'node_modules/**',
    '.pnpm/**',
    '.yarn/**',
    'bower_components/**',
    'dist/**',
    'build/**',
    'out/**',
    '.next/**',
    '.nuxt/**',
    '.vite/**',
    'coverage/**',
    'test-results/**',
    'playwright-report/**',
    '.nyc_output/**',
  ],
}

export function resolveWorkspaceSearchExcludes(
  presets: LooseOptional<WorkspaceSearchExcludePreset[]>,
  exclude: LooseOptional<string[]>
): string[] | undefined {
  const values = [
    ...(presets ?? []).flatMap((preset) => WorkspaceSearchExcludePresetGlobs[preset]),
    ...(exclude ?? []),
  ]
  return optionalWhenLazy(!isEmpty(values), () => [...new Set(values)])
}

export function hasSearchNoiseExclusion(
  presets: LooseOptional<WorkspaceSearchExcludePreset[]>,
  exclude: LooseOptional<string[]>
): boolean {
  if (presets?.includes('common-source-noise')) return true
  const coveredByPreset = new Set(presets ?? [])
  if (
    coveredByPreset.has('vcs') &&
    coveredByPreset.has('dependencies') &&
    coveredByPreset.has('build-output') &&
    coveredByPreset.has('test-artifacts')
  ) return true
  const excludeText = (exclude ?? []).join('\n')
  return ['.git', 'node_modules', 'dist', 'coverage'].every((marker) =>
    excludeText.includes(marker)
  )
}

export function isBroadWorkspaceScope(pathValue: LooseOptional<string>): boolean {
  const pathText = normalizeToolPath(pathValue)
  return !pathText || pathText === '.'
}

export function buildDiscoveryPreflight(
  action: string,
  input: {
    confirmRisk?: boolean
    exclude?: string[]
    excludeGitignored?: boolean
    excludePresets?: WorkspaceSearchExcludePreset[]
    path?: string
    recursive?: boolean
    query?: string
    glob?: string
    extensions?: string[]
  }
): Nullable<ReturnType<typeof buildModelPreflightResult>> {
  if (input.confirmRisk) return null
  const advisories: ModelPreflightAdvisory[] = []
  const hasFilters = !!(input.query?.trim() || input.glob?.trim() || input.extensions?.length)
  const broadTraversal = isBroadWorkspaceScope(input.path) && (input.recursive || hasFilters)
  const broadSearch = action === wsTool.search && isBroadWorkspaceScope(input.path)
  if (
    (broadTraversal || broadSearch) &&
    isFalse(input.excludeGitignored) &&
    !hasSearchNoiseExclusion(input.excludePresets, input.exclude)
  ) {
    advisories.push({
      code: 'workspace-broad-discovery-without-excludes',
      severity: 'caution',
      message:
        '本次工作区发现/搜索范围较宽，且已关闭默认 .gitignore 排除，但没有显式排除依赖、构建产物、测试产物或版本控制目录。',
      suggestions: [
        '按项目情况补充 excludePresets:["common-source-noise"] 或更精确的 exclude。',
        '保留默认 excludeGitignored:true，让 .gitignore 继续收窄扫描范围。',
        '将 path 缩小到 src、packages、apps 等目标子树。',
        `如确实需要全量扫描，请带 ${MODEL_PREFLIGHT_CONFIRM_FIELD}:true 重试。`,
      ],
    })
  }
  return isEmpty(advisories) ? null : buildModelPreflightResult(action, advisories)
}

export interface WorkspaceFileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: WorkspaceFileTreeNode[]
}

export function workspaceTreeRootPath(pathValue: LooseOptional<string>): string {
  const normalized = normalizeToolPath(pathValue)
  return normalized || '.'
}

export function sortWorkspaceTreeChildren(node: WorkspaceFileTreeNode): void {
  node.children?.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  node.children?.forEach(sortWorkspaceTreeChildren)
}

export function buildWorkspaceFileTree(
  entries: Array<{ path: string; type: 'file' | 'directory' }>,
  pathValue: LooseOptional<string>
): WorkspaceFileTreeNode {
  const rootPath = workspaceTreeRootPath(pathValue)
  const rootName = rootPath === '.' ? '.' : rootPath.split('/').at(-1) || rootPath
  const root: WorkspaceFileTreeNode = {
    name: rootName,
    path: rootPath,
    type: 'directory',
    children: [],
  }

  const directoryByPath = new Map<string, WorkspaceFileTreeNode>([[root.path, root]])

  const getOrCreateDirectory = (directoryPath: string): WorkspaceFileTreeNode => {
    const normalizedDirectoryPath = normalizeToolPath(directoryPath) || '.'
    const existing = directoryByPath.get(normalizedDirectoryPath)
    if (existing) return existing
    const parentPath = normalizedDirectoryPath.includes('/')
      ? normalizedDirectoryPath.split('/').slice(0, -1).join('/')
      : '.'
    const parent = getOrCreateDirectory(parentPath)
    const node: WorkspaceFileTreeNode = {
      name: normalizedDirectoryPath.split('/').at(-1) || normalizedDirectoryPath,
      path: normalizedDirectoryPath,
      type: 'directory',
      children: [],
    }
    parent.children ??= []
    parent.children.push(node)
    directoryByPath.set(normalizedDirectoryPath, node)
    return node
  }

  for (const entry of entries) {
    const normalizedPath = normalizeToolPath(entry.path)
    if (!normalizedPath || normalizedPath === root.path) continue
    const parentPath = normalizedPath.includes('/')
      ? normalizedPath.split('/').slice(0, -1).join('/')
      : '.'
    const parent = getOrCreateDirectory(parentPath)
    const existing = parent.children?.find((child) => child.path === normalizedPath)
    if (existing) {
      existing.type = entry.type
      if (entry.type === 'directory') existing.children ??= []
      continue
    }
    const node: WorkspaceFileTreeNode = {
      name: normalizedPath.split('/').at(-1) || normalizedPath,
      path: normalizedPath,
      type: entry.type,
      children: optionalWhenLazy((entry.type === 'directory'), () => []),
    }
    parent.children ??= []
    parent.children.push(node)
    if (entry.type === 'directory') directoryByPath.set(normalizedPath, node)
  }

  sortWorkspaceTreeChildren(root)
  return root
}

// ---------------------------------------------------------------------------
// Mutation tools — require workspace authorisation
// ---------------------------------------------------------------------------

export const WorkspaceSymbolSelectorSchema = z
  .object({
    kind: z.string().optional().describe(
      parameterDescription({
        description: '符号类型。',
        usage: ['例如 function、class、method、interface。'],
      })
    ),
    name: z.string().min(1).describe(
      parameterDescription({
        description: '符号名。',
      })
    ),
    container: z.string().optional().describe(
      parameterDescription({
        description: '符号所在容器。',
        usage: ['例如类名或命名空间名。'],
      })
    ),
  })
  .describe(
    parameterDescription({
      description: '符号选择器。',
      notes: [`更稳的方式是先 ${wsTool.resolveTarget}，再把 targetId 放到 operations[].targetId。`],
    })
  )

/**
 * 编辑操作判别联合 —— 直接复用 @velaros-ai/workspace 的单一事实来源
 * （editOperationUnion）。这样消费端与内核包不会出现 schema 漂移：
 * insert_around_symbol、looseObject 透传、字段说明都来自同一处定义。
 */
export const WorkspaceEditOperationSchema = editOperationUnion

export type WorkspaceEditOperationInput = z.infer<typeof WorkspaceEditOperationSchema>

/**
 * 单个编辑 intent —— 直接复用 @velaros-ai/workspace 的 editIntentSchema：
 * 它带有 superRefine 守卫（targetId 缺失时校验 operation.path / oldText）和 typed constraints，
 * 与内核包共用同一份校验语义，零 token 成本（refinement 不进 JSON schema）。
 */
export const WorkspacePrepareEditOperationItemSchema = editIntentSchema

export const WorkspacePrepareEditSchema = prepareEditInputSchema.extend({
  dryRun: z.boolean().optional().default(false).describe(
    parameterDescription({
      description:
        'true 时只预览 diff 并丢弃事务，不返回 transactionId（无法后续 apply/commit）；默认 false 保留事务供 apply/commit。注意 prepare 本就不写盘，差别只在是否保留事务。',
    })
  ),
  cwd: z.string().optional().describe(workspaceCwdDescription),
  confirmRisk: z
    .boolean()
    .optional()
    .describe(
      parameterDescription({
        description: '是否确认执行风险预检拦截的编辑。',
        notes: ['仅当返回 needs_model_review 后仍需执行时传 true。'],
      })
    ),
})

export type WorkspacePrepareEditInput = z.infer<typeof WorkspacePrepareEditSchema>

export const WorkspaceAmendEditSchema = amendEditInputSchema.extend({
  confirmRisk: z
    .boolean()
    .optional()
    .describe(
      parameterDescription({
        description: '是否确认执行风险预检拦截的修补。',
        notes: ['仅当返回 needs_model_review 后仍需执行时传 true。'],
      })
    ),
})

export type WorkspaceAmendEditInput = z.infer<typeof WorkspaceAmendEditSchema>

export const WorkspaceCommitEditSchema = commitEditInputSchema.extend({
  cwd: z.string().optional().describe(workspaceCwdDescription),
  confirmRisk: z
    .boolean()
    .optional()
    .describe(
      parameterDescription({
        description: '是否确认执行风险预检拦截的提交。',
        notes: ['仅当返回 needs_model_review 后仍需执行时传 true。'],
      })
    ),
  autoFix: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      parameterDescription({
        description: '校验失败时是否运行对应 fixer。',
        notes: [
          '默认 true；可修复问题会作为 amendment 合入同一事务。',
          'Prettier/ESLint 默认视为最终整理，显式放入 checks 时才运行。',
        ],
      })
    ),
  split: z
    .enum(['auto', 'off'])
    .optional()
    .default('auto')
    .describe(
      parameterDescription({
        description: '大变更拆分策略。',
        values: ['auto：必要时自动拆分子事务。', 'off：不自动拆分。'],
        notes: ['默认 auto。'],
      })
    ),
})

export type WorkspaceCommitEditInput = z.infer<typeof WorkspaceCommitEditSchema>

export const WorkspacePrepareEditPresetSchema = z.object({
  path: z.string().min(1).describe(
    parameterDescription({
      description: '要修改的文件路径。',
    })
  ),
  oldText: z.string().min(1).describe(
    parameterDescription({
      description: '要替换的唯一旧文本。',
    })
  ),
  newText: z.string().describe(
    parameterDescription({
      description: '替换后的文本。',
    })
  ),
  baseRevision: z
    .string()
    .optional()
    .describe(
      parameterDescription({
        description: '期望的文件 revision。',
        notes: [`来自最近一次 ${wsTool.read} 的 snapshot.revision。`],
      })
    ),
  dryRun: z.boolean().optional().default(false).describe(
    parameterDescription({
      description:
        'true 时只预览 diff 并丢弃事务，不返回 transactionId（无法后续 apply/commit）；默认 false 保留事务供 apply/commit。注意 prepare 本就不写盘，差别只在是否保留事务。',
    })
  ),
  cwd: z.string().optional().describe(workspaceCwdDescription),
  reason: z.string().optional().describe(
    parameterDescription({
      description: '本次替换原因。',
    })
  ),
  confirmRisk: z.boolean().optional().describe(
    parameterDescription({
      description: '是否确认执行风险预检拦截的替换。',
    })
  ),
})

export type WorkspacePrepareEditPresetInput = z.infer<typeof WorkspacePrepareEditPresetSchema>

export const WorkspacePrepareEditGuidedOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('replace_text'),
    path: z.string().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('delete_text'),
    path: z.string().min(1),
    oldText: z.string().min(1),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('insert_text_at_anchor'),
    path: z.string().min(1),
    anchorText: z.string().min(1),
    position: z.enum(['before', 'after']),
    text: z.string(),
    expectedMatches: z.number().int().positive().optional(),
    skipIfAlreadyPresent: z.boolean().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('append_text'),
    path: z.string().min(1),
    text: z.string(),
    skipIfAlreadyPresent: z.boolean().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('prepend_text'),
    path: z.string().min(1),
    text: z.string(),
    skipIfAlreadyPresent: z.boolean().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('create_file'),
    path: z.string().min(1),
    content: z.string(),
    overwrite: z.boolean().optional(),
    reason: z.string().optional(),
  }),
])

export const WorkspacePrepareEditGuidedSchema = z.object({
  edits: z
    .array(WorkspacePrepareEditGuidedOperationSchema)
    .min(1)
    .describe(
      parameterDescription({
        description: '常用编辑操作列表。',
        notes: ['需要符号、import、json 或 custom 等高级操作时切换 direct 或 expert。'],
      })
    ),
  baseRevision: z
    .string()
    .optional()
    .describe(
      parameterDescription({
        description: '期望的文件 revision。',
        notes: [`来自最近一次 ${wsTool.read} 的 snapshot.revision。`],
      })
    ),
  dryRun: z.boolean().optional().default(false).describe(
    parameterDescription({
      description:
        'true 时只预览 diff 并丢弃事务，不返回 transactionId（无法后续 apply/commit）；默认 false 保留事务供 apply/commit。注意 prepare 本就不写盘，差别只在是否保留事务。',
    })
  ),
  cwd: z.string().optional().describe(workspaceCwdDescription),
  confirmRisk: z.boolean().optional().describe(
    parameterDescription({
      description: '是否确认执行风险预检拦截的 guided 编辑。',
    })
  ),
})

export type WorkspacePrepareEditGuidedInput = z.infer<typeof WorkspacePrepareEditGuidedSchema>

export function normalizeWorkspacePrepareEditPreset(
  input: WorkspacePrepareEditPresetInput
): WorkspacePrepareEditInput {
  return {
    operations: [
      {
        operation: {
          type: 'replace_text',
          path: input.path,
          oldText: input.oldText,
          newText: input.newText,
        },
        reason: input.reason,
      },
    ],
    baseRevision: input.baseRevision,
    dryRun: input.dryRun,
    cwd: input.cwd,
    confirmRisk: input.confirmRisk,
  }
}

export function normalizeWorkspacePrepareEditGuided(
  input: WorkspacePrepareEditGuidedInput
): WorkspacePrepareEditInput {
  return {
    operations: input.edits.map((edit) => {
      const { reason, ...operation } = edit
      return {
        operation,
        reason,
      }
    }),
    baseRevision: input.baseRevision,
    dryRun: input.dryRun,
    cwd: input.cwd,
    confirmRisk: input.confirmRisk,
  }
}

export function editOperationPaths(operation: WorkspaceEditOperationInput): Array<LooseOptional<string>> {
  switch (operation.type) {
    case 'rename_file':
      return [operation.from, operation.to]
    case 'replace_text':
    case 'delete_text':
    case 'insert_text':
    case 'insert_text_at_anchor':
    case 'append_text':
    case 'prepend_text':
    case 'create_file':
    case 'delete_file':
    case 'add_import':
    case 'remove_import':
    case 'json_patch':
    case 'replace_symbol':
    case 'insert_around_symbol':
    case 'insert_before_symbol':
    case 'insert_after_symbol':
      return [operation.path]
    case 'custom':
      return []
  }
}

export function buildEditPreflight(
  action: string,
  input: {
    confirmRisk?: boolean
    operations: Array<{ operation: WorkspaceEditOperationInput; targetId?: string }>
  }
): Nullable<ReturnType<typeof buildModelPreflightResult>> {
  if (input.confirmRisk) return null
  const operations = input.operations.map((item) => item.operation)
  const operationTypes = operations.map((operation) => operation.type)
  const paths = operations.flatMap(editOperationPaths)
  const advisories = [...riskyPathAdvisories(paths, '编辑操作')]
  const overwriteCreates = operations.filter(
    (operation) => operation.type === 'create_file' && operation.overwrite
  )
  if (!isEmpty(overwriteCreates)) {
    advisories.push({
      code: 'workspace-create-file-overwrite',
      severity: 'danger',
      message: '本次 create_file 使用 overwrite:true，可能覆盖已有文件。',
      paths: uniqueValues(overwriteCreates.flatMap(editOperationPaths)),
      suggestions: [
        '先读取目标路径确认内容，或改成更窄的文本/结构化编辑。',
        `确认必须覆盖时带 ${MODEL_PREFLIGHT_CONFIRM_FIELD}:true 重试。`,
      ],
    })
  }
  if (operationTypes.includes('custom')) {
    advisories.push({
      code: 'workspace-custom-edit-operation',
      severity: 'caution',
      message:
        'custom 是扩展点，不是内置通用编辑方式；请确认当前工作区确实注册了对应 adapter/strategy。',
      suggestions: [
        '优先选择内置 operation。',
        `确认扩展处理器存在时带 ${MODEL_PREFLIGHT_CONFIRM_FIELD}:true 重试。`,
      ],
    })
  }
  return isEmpty(advisories) ? null : buildModelPreflightResult(action, advisories)
}

/**
 * 事务应用前的模型审阅 advisories（供 ws_edit 的 commit gating 使用）。
 *
 * 注意：工作区级授权在编辑阶段确认；工作区一旦授权开放，内部 diff 风险只作为
 * 模型审阅元数据返回，不再由工具层按 low/high 风险二次拦截。
 */
export function transactionPreflightAdvisories(tx: any): ModelPreflightAdvisory[] {
  if (!isPlainObject(tx)) return []
  const changedFiles = isArray(tx.changedFiles) ? tx.changedFiles.filter(isString) : []
  return [...riskyPathAdvisories(changedFiles, '事务提交')]
}

export function summarizePreparedTransaction(tx: AgentWorkspacePreparedTransaction) {
  return {
    transactionId: tx.transactionId,
    changedFiles: tx.changedFiles,
    changedLines: tx.changedLines,
    risk: tx.risk,
    patchCount: tx.patches.length,
    createdAt: tx.createdAt,
  }
}

export function flattenApplyResult(applyResult: AgentWorkspaceApplyResult) {
  return {
    oldRevisions: applyResult.oldRevisions,
    newRevisions: applyResult.newRevisions,
    rebasedFiles: toOptional(applyResult.rebasedFiles),
    gitTrackedFiles: toOptional(applyResult.gitTrackedFiles),
  }
}

export const CommitAutoApplyMaxChangedFiles = 1
export const CommitAutoApplyMaxChangedLines = 200

/**
 * 上下文感知的编辑预算（治大型编辑）。
 *
 * 把「单次事务 diff 的预估 token」当作一次写盘要占用的上下文页：当它超过本轮模型
 * 输入侧可用窗口（usableContextWindow）的某个比例时，强制走 needs_model_review，
 * 提示模型按文件 / 按 hunk 分批提交，并把「已提交 / 待提交」写进 plan——避免一个巨型
 * diff 既撑爆上下文又触发「改→发现不够→回查→再改」的反复。
 */
/** diff 预估 token 触发模型审核的阈值，占可用窗口的比例。 */
export const CommitDiffReviewTokenRatio = 0.5
/** 可用窗口未知（agent loop 未下发）时的保守回退额度（token）。 */
export const CommitDiffReviewFallbackUsableContextTokens = 24_000
/** diff 字符到 token 的粗略换算口径（与上下文用量估算保持一致）。 */
export const CommitDiffReviewCharsPerToken = 4
/** diff 预估 token 低于该绝对下限时永不触发，避免小窗口下对正常小改误报。 */
export const CommitDiffReviewMinTriggerTokens = 1_500

/** 由 diff 文本粗略估算 token 数（向上取整，空 diff 记 0）。 */
export function estimateDiffTokens(diff: LooseOptional<string>): number {
  if (!isNonBlankString(diff)) return 0
  return Math.ceil(diff.length / CommitDiffReviewCharsPerToken)
}

export interface TransactionDiffBudgetAssessment {
  /** diff 预估 token 是否超过本次可用窗口的允许比例。 */
  exceeded: boolean
  /** diff 预估 token。 */
  estimatedTokens: number
  /** 触发阈值（token）：max(下限, 可用窗口 * 比例)。 */
  budgetTokens: number
  /** 本次采用的可用窗口（token）；未知时为回退默认值。 */
  usableContextWindowTokens: number
  /** 采用回退默认窗口（agent loop 未下发真实窗口）时为 true。 */
  usedFallbackWindow: boolean
  /** 涉及文件数；>1 时优先建议按文件分批。 */
  fileCount: number
  /** 最大单文件补丁路径，用于「按文件 vs 按 hunk」拆分建议。 */
  largestFilePath: Nullable<string>
  /** 最大单文件补丁变更行数。 */
  largestFileChangedLines: number
}

/** 评估一次事务 diff 是否超出上下文编辑预算，并给出拆分所需的结构信息。 */
export function assessTransactionDiffBudget(
  tx: AgentWorkspacePreparedTransaction,
  usableContextWindowTokens: LooseOptional<number>
): TransactionDiffBudgetAssessment {
  const usedFallbackWindow = !isPositiveNumber(usableContextWindowTokens)
  const usable = usedFallbackWindow
    ? CommitDiffReviewFallbackUsableContextTokens
    : (usableContextWindowTokens as number)
  const budgetTokens = Math.max(
    CommitDiffReviewMinTriggerTokens,
    Math.floor(usable * CommitDiffReviewTokenRatio)
  )
  const estimatedTokens = estimateDiffTokens(tx.diff)

  let largestFilePath: Nullable<string> = null
  let largestFileChangedLines = 0
  for (const patch of tx.patches) {
    if (patch.changedLines > largestFileChangedLines) {
      largestFileChangedLines = patch.changedLines
      largestFilePath = patch.path
    }
  }

  return {
    exceeded: estimatedTokens > budgetTokens && estimatedTokens >= CommitDiffReviewMinTriggerTokens,
    estimatedTokens,
    budgetTokens,
    usableContextWindowTokens: usable,
    usedFallbackWindow,
    fileCount: tx.changedFiles.length,
    largestFilePath,
    largestFileChangedLines,
  }
}

/** 把超预算评估转成一条人类可读的审核原因（diff 未超预算时返回 null）。 */
export function transactionDiffBudgetReason(
  assessment: TransactionDiffBudgetAssessment
): Nullable<string> {
  if (!assessment.exceeded) return null
  const splitHint =
    assessment.fileCount > 1
      ? '建议先按文件分批提交（split: "file"）'
      : '建议按 hunk / 子区域拆成多次较小编辑分批提交'
  return (
    `单次编辑 diff 预估约 ${assessment.estimatedTokens} tokens，` +
    `超过可用上下文窗口的编辑预算（阈值 ${assessment.budgetTokens} tokens，` +
    `占可用窗口 ${Math.round(CommitDiffReviewTokenRatio * 100)}%）。${splitHint}，` +
    '并在 plan 中记录「已提交 / 待提交」，避免一个巨型 diff 撑爆上下文。'
  )
}
export const CommitEditFinalizerCheckIds =
  new Set(['external.prettier', 'external.eslint'])
export const CommitEditNoDefaultValidatorCheck =
  '__velaros_commit_edit_no_default_finalizers__'

export async function resolveCommitValidationChecks(
  workspace: AgentWorkspaceKernelPort,
  checks: string[] | undefined
): Promise<{ checks?: string[]; deferredFinalizerChecks: string[] }> {
  if (checks?.length) return { checks, deferredFinalizerChecks: [] }

  const status = await workspace.status()
  const checksWithoutFinalizers = status.validators.filter(
    (validator) => !CommitEditFinalizerCheckIds.has(validator)
  )
  const deferredFinalizerChecks = status.validators.filter(
    (validator) => CommitEditFinalizerCheckIds.has(validator)
  )
  return {
    checks: !isEmpty(checksWithoutFinalizers)
      ? checksWithoutFinalizers
      : [CommitEditNoDefaultValidatorCheck],
    deferredFinalizerChecks,
  }
}

export interface CommitEditPreparedGroup {
  groupId: string
  operations: WorkspaceCommitEditInput['operations']
  tx: AgentWorkspacePreparedTransaction
  validation: AgentWorkspaceValidationResult
  fix?: AgentWorkspaceFixResult
}

export const workspaceTrustParam = parameterDescription({
  description: '输入信任标签，用于密钥脱敏判定。',
  usage: ['形如 { source: "user"|"workspace"|"tool"|"external"|"system", trust: "trusted"|"untrusted" }。'],
  notes: ['省略时按工作区默认（项目内容不可信）处理。'],
})

export function modelVisibleErrorMessage(error: any): string {
  const errorObject = toAgentWorkspaceErrorObject(error)
  const message = errorObject.message
  if (isNonBlankString(message)) return message
  return '工具执行失败，但没有提供可读错误信息。'
}

export function modelVisibleErrorDiagnostic(
  source: string,
  error: any,
  path?: string
): AgentWorkspaceDiagnostic {
  const errorObject = toAgentWorkspaceErrorObject(error)
  return {
    severity: 'error',
    source,
    path: toOptional(path),
    message: modelVisibleErrorMessage(error),
    data: errorObject,
  }
}

export function buildToolErrorResult(action: string, error: any, extra: Record<string, any> = {}) {
  const errorObject = toAgentWorkspaceErrorObject(error)
  const diagnostic = modelVisibleErrorDiagnostic(action, error)
  return {
    status: 'error' as const,
    action,
    changed: false,
    applied: false,
    message: diagnostic.message,
    error: errorObject,
    diagnostics: [diagnostic],
    ...extra,
  }
}

/**
 * 统一的工具执行包装：捕获 kernel 抛出的异常并转成模型可读的结构化错误结果
 * （buildToolErrorResult），避免 status/symbols/resolve_target/build_evidence/diff/
 * rollback/search/list_files/run_batch 这些工具裸 throw、把内部栈直接抛给执行框架。
 * 中止信号（AbortError）应在调用本包装前用 throwIfAborted() 处理，让其按取消语义向上传播。
 */
export async function runWorkspaceTool<T>(
  action: string,
  run: () => Promise<T> | T,
  extra: Record<string, any> = {},
  hooks?: { beforeErrorReturn?: (error: unknown) => void }
): Promise<T | ReturnType<typeof buildToolErrorResult>> {
  try {
    return await run()
  } catch (error) {
    // 与 read/prepare/commit 路径一致：给 BASE_REVISION_MISMATCH 补上 agent 恢复提示，
    // 否则经本包装的 symbols/rollback/diff/run_batch 等会返回缺提示的裸错误码。
    augmentRevisionMismatchMessage(error)
    hooks?.beforeErrorReturn?.(error)
    return buildToolErrorResult(action, error, extra)
  }
}

export function buildModelReviewResult(
  action: string,
  reasons: string[],
  extra: Record<string, any> = {}
) {
  return {
    status: 'needs_model_review' as const,
    action,
    changed: false,
    applied: false,
    message:
      `本次编辑已停止在模型审核阶段；工具没有写盘。模型可以审阅 diff/diagnostics，用 ${wsTool.amendEdit} 修补一个或多个点，或拆小后重试。`,
    reasons,
    nextActions: [
      `如果只是局部问题，用 ${wsTool.amendEdit} 对对应 transactionId 追加一个或多个修补 operation，然后重新 validate/commit。`,
      '如果范围过大或目标错误，缩小 operations 后重新提交。',
      `如果确认需要人工分步审阅，改用 ${wsTool.prepareEdit} → ${wsTool.diff}/${wsTool.validate} → ${wsTool.applyEdit}。`,
    ],
    ...extra,
  }
}

export function operationRequiresReview(operation: WorkspaceEditOperationInput): Nullable<string> {
  switch (operation.type) {
    case 'delete_file':
      return '包含删除文件操作'
    case 'rename_file':
      return '包含重命名文件操作'
    case 'create_file':
      return operation.overwrite ? '包含覆盖式创建文件操作' : null
    case 'custom':
      return '包含 custom 扩展编辑操作'
    default:
      return null
  }
}

export function commitGroupKey(
  item: WorkspacePrepareEditInput['operations'][number],
  index: number
): string {
  const paths = editOperationPaths(item.operation).filter(isNonBlankString)
  if (paths.length === 1) return `file:${paths[0]}`
  if (item.targetId) return `target:${item.targetId}`
  if (paths.length > 1) return `multi:${paths.join('->')}`
  return `operation:${index}`
}

export function splitCommitOperations(
  operations: WorkspaceCommitEditInput['operations'],
  mode: WorkspaceCommitEditInput['split']
): Array<{ groupId: string; operations: WorkspaceCommitEditInput['operations'] }> {
  if (mode === 'off' || operations.length <= 1) return [{ groupId: 'all', operations }]

  const groups = new Map<string, WorkspaceCommitEditInput['operations']>()
  operations.forEach((operation, index) => {
    const key = commitGroupKey(operation, index)
    const current = groups.get(key) ?? []
    current.push(operation)
    groups.set(key, current)
  })

  return [...groups.entries()].map(([groupId, groupOperations]) => ({
    groupId,
    operations: groupOperations,
  }))
}

export function transactionRequiresModelReview(
  tx: AgentWorkspacePreparedTransaction,
  operations: WorkspaceCommitEditInput['operations'],
  _options?: { usableContextWindowTokens?: LooseOptional<number> }
): string[] {
  // 只对**真正有破坏性**的操作要模型确认：删文件、覆盖已有文件、重命名、custom 扩展编辑。
  // 新建文件、普通/大批量文本编辑一律直接写盘——不因「风险等级/改动行数/文件数/diff 预算」搞确认
  // 仪式（那些既不危险、又拖慢每一步）。超大编辑的上下文预算由 executeCommitEditWithGating 内部
  // 按文件自动拆分处理，不再让模型二次确认。
  return [
    ...new Set(
      operations.map((item) => operationRequiresReview(item.operation)).filter(isNonBlankString)
    ),
  ]
}

export function summarizeCommitGroup(group: CommitEditPreparedGroup) {
  return {
    groupId: group.groupId,
    transactionId: group.tx.transactionId,
    changedFiles: group.tx.changedFiles,
    changedLines: group.tx.changedLines,
    risk: group.tx.risk,
    validation: group.validation,
    fix: group.fix,
    prepared: summarizePreparedTransaction(group.tx),
  }
}

export interface WorkspaceDiffResult {
  diff: string
  changedFiles: string[]
  changedLines: number
}

export function combineWorkspaceDiffResults(results: WorkspaceDiffResult[]): WorkspaceDiffResult {
  return {
    diff: results
      .map((result) => result.diff)
      .filter(Boolean)
      .join('\n'),
    changedFiles: [...new Set(results.flatMap((result) => result.changedFiles))],
    changedLines: results.reduce((sum, result) => sum + result.changedLines, 0),
  }
}
