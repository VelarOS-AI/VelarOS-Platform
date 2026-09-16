import type { BrowserWorkspaceArtifactManager } from '../impl/workspace/BrowserWorkspaceArtifactManager.js'
import type { buildRecipeExecutionPlan } from '../utils/recipes/plan.js'

import type { BrowserPageInspection, BrowserRecipeSkeleton, BrowserSiteContext } from './browser'
import type { BrowserPageNavigationOptions, BrowserPageScrollOptions, BrowserRecipeSkeletonStep, BrowserTargetActionOptions, BrowserWaitForSelectorOptions,BrowserWorkspaceArtifactRecord } from './browser.js'

export type BrowserRecipeRunVariables = Record<string, string>

export interface BrowserRecipeVariableResolution {
  resolvedInputs: Record<string, string>
  usedVariableNames: string[]
  unusedVariableNames: string[]
  missingVariableNames: string[]
}

/** 执行 recipe 步骤列表的入参。 */
export interface ExecuteBrowserRecipeStepsInput {
  /** 已经由 plan helper 编译好的步骤计划。 */
  stepPlan: BrowserRecipeStepPlan[]
  /** target 未命中时是否立即抛错停止。 */
  stopOnMiss?: boolean
}

export type BrowserRecipeRunRecipeFields = Pick<
  BrowserRecipeRunRecordArtifact,
  'recipePath' | 'recipeUrl' | 'recipeTitle' | 'dryRun'
>

export type BrowserRecipeRunWindowFields = Pick<
  BrowserRecipeRunRecordArtifact,
  'startedAt' | 'finishedAt' | 'activeBrowserContext'
>

export type BrowserRecipeRunStepSummaryFields = Pick<
  BrowserRecipeRunRecordArtifact,
  | 'executableStepCount'
  | 'executedStepCount'
  | 'readyStepCount'
  | 'missingInputCount'
  | 'skippedStepCount'
>

export type BrowserRecipeRunInputFields = Pick<
  BrowserRecipeRunRecordArtifact,
  | 'requiredInputNames'
  | 'optionalInputNames'
  | 'unusedInputNames'
  | 'missingInputs'
  | 'usedVariableNames'
  | 'unusedVariableNames'
  | 'missingVariableNames'
>

export type BrowserRecipeRunArtifactFields = Pick<
  BrowserRecipeRunRecordArtifact,
  'snapshotArtifacts' | 'snapshotSaveSkippedReason' | 'stepResults'
>

/** 执行 recipe skeleton 的入参。 */
export interface RunBrowserRecipeSkeletonInput {
  /** recipes/xxx.json 路径。 */
  path: string
  /** recipe input.name -> 输入值。 */
  inputs?: Record<string, string>
  /** %variableName% -> 真实执行值；不会写入 run record。 */
  variables?: BrowserRecipeRunVariables
  /** 最多执行多少个可执行步骤。 */
  maxSteps?: number
  /** 只预检，不执行页面动作、不写 run record。 */
  dryRun?: boolean
  /** target 未命中时是否立即停止。 */
  stopOnMiss?: boolean
  /** 是否保存 runs/ 运行记录。 */
  saveRun?: boolean
  /** 是否保存 before/after 页面快照。 */
  saveSnapshots?: boolean
  /** run/snapshot artifact 名称前缀。 */
  runName?: string
}

export type BrowserRecipeRunSnapshot = Awaited<
  ReturnType<BrowserWorkspaceArtifactManager['savePageSnapshot']>
>

/** recipe skeleton 可选预设模板。 */
export type BrowserRecipeTemplate = 'login' | 'search' | 'pagination' | 'form_submit'

/** 从当前页面生成 recipe skeleton 的入参。 */
export interface GenerateBrowserRecipeSkeletonInput {
  name?: string
  saveSnapshot?: boolean
  snapshotName?: string
  overwriteSnapshot?: boolean
  maxTextChars?: number
  overwrite?: boolean
  template?: BrowserRecipeTemplate
}

/** 从已保存 snapshot 生成 recipe skeleton 的入参。 */
export interface GenerateBrowserRecipeSkeletonFromSnapshotInput {
  path: string
  name?: string
  overwrite?: boolean
  template?: BrowserRecipeTemplate
}

/** 读取并预览 recipe skeleton 的入参。 */
export interface ReadBrowserRecipeSkeletonInput {
  path: string
  inputs?: Record<string, string>
  maxSteps?: number
}

/** recipe skeleton 的读取结果及可执行性摘要。 */
export interface ReadBrowserRecipeSkeletonResult {
  path: string
  recipe: BrowserRecipeSkeleton
  summary: {
    url: string
    title: string
    sourceSnapshotPath: Nullable<string>
    inputCount: number
    requiredInputNames: string[]
    optionalInputNames: string[]
    executableStepCount: number
    previewStepCount: number
    readyStepCount: number
    missingInputCount: number
    skippedStepCount: number
    unusedInputNames: string[]
    missingInputs: Array<{
      stepId: string
      name: string
      label: string
      type: string
      required: boolean
    }>
  }
  stepResults: BrowserRecipeRunStepResult[]
}

/** 读取 run record 的入参。 */
export interface ReadBrowserRecipeRunInput {
  path: string
}

/** 基于历史 run record 重跑 recipe 的入参。 */
export interface RerunBrowserRecipeFromRunInput {
  path: string
  inputs?: Record<string, string>
  variables?: BrowserRecipeRunVariables
  maxSteps?: number
  dryRun?: boolean
  stopOnMiss?: boolean
  saveRun?: boolean
  saveSnapshots?: boolean
  runName?: string
}

/** 写入 runs/ 的 recipe 执行记录。 */
export interface BrowserRecipeRunRecordArtifact {
  /** recipe artifact 路径。 */
  recipePath: string
  /** recipe 关联页面 URL。 */
  recipeUrl: string
  /** recipe 标题。 */
  recipeTitle: string
  /** 是否只是 dryRun。 */
  dryRun: boolean
  /** 执行开始时间。 */
  startedAt: number
  /** 执行结束时间。 */
  finishedAt: number
  /** 执行结束时的 browser context。 */
  activeBrowserContext: LooseOptional<BrowserSiteContext>
  /** 可执行步骤总数。 */
  executableStepCount: number
  /** 已执行步骤数。 */
  executedStepCount: number
  /** ready 但未执行的步骤数，通常来自 dryRun。 */
  readyStepCount: number
  /** 缺失输入数。 */
  missingInputCount: number
  /** 跳过/未命中步骤数。 */
  skippedStepCount: number
  /** 必填输入名。 */
  requiredInputNames: string[]
  /** 可选输入名。 */
  optionalInputNames: string[]
  /** 未被 recipe 使用的输入名。 */
  unusedInputNames: string[]
  /** 缺失输入详情。 */
  missingInputs: BrowserRecipeExecutionPlan['missingInputs']
  /** 本次输入中实际引用的变量占位符名，不包含变量值。 */
  usedVariableNames: string[]
  /** 调用方传入但未被输入占位符使用的变量名。 */
  unusedVariableNames: string[]
  /** dryRun 中发现、真实执行前会要求补齐的变量名。 */
  missingVariableNames: string[]
  /** before/after 快照 artifact。 */
  snapshotArtifacts: BrowserRecipeRunSnapshotArtifacts
  /** 快照未保存的原因。 */
  snapshotSaveSkippedReason: LooseOptional<string>
  /** 每一步结果。 */
  stepResults: BrowserRecipeRunStepResult[]
}

/** recipe 步骤在预览/执行过程中的状态。 */
export type BrowserRecipeRunStepStatus =
  | 'ready'
  | 'executed'
  | 'skipped'
  | 'not_found'
  | 'missing_input'

/** 单个 recipe 步骤的预览或执行结果。 */
export interface BrowserRecipeRunStepResult {
  /** recipe step id。 */
  id: string
  /** step 类型。 */
  kind: BrowserRecipeSkeletonStep['kind']
  /** 当前步骤状态。 */
  status: BrowserRecipeRunStepStatus
  /** 实际要执行的浏览器动作。 */
  action: Nullable<'click' | 'fill'>
  /** 给模型/用户看的状态说明。 */
  message: string
  /** fill_field 对应的 input.name。 */
  inputName?: string
  /** target CSS，便于调试未命中。 */
  targetCss?: LooseOptional<string>
  /** target role，便于调试未命中。 */
  targetRole?: LooseOptional<string>
  /** target text，便于调试未命中。 */
  targetText?: LooseOptional<string>
  /** runtime 返回的原始执行结果。 */
  result?: unknown
  /** 执行错误信息。 */
  error?: string
}

export type BrowserRecipeTargetActionOptions = BrowserTargetActionOptions & {
  action: 'click' | 'fill'
}

export type BrowserRecipeStepOperation =
  | { kind: 'target_action'; action: BrowserRecipeTargetActionOptions }
  | { kind: 'inspect_page' }
  | { kind: 'navigate'; options: BrowserPageNavigationOptions }
  | { kind: 'scroll'; options: BrowserPageScrollOptions }
  | { kind: 'wait_for_selector'; options: BrowserWaitForSelectorOptions }
  | { kind: 'extract_table'; selector?: string; tableIndex?: number; maxRows?: number }
  | { kind: 'extract_list'; selector?: string; maxItems?: number }

/** 单个步骤的执行计划：是否 ready、动作是什么、缺什么输入。 */
export interface BrowserRecipeStepPlan {
  /** 原始 recipe step。 */
  step: BrowserRecipeSkeletonStep
  /** 预执行状态。 */
  status: Extract<BrowserRecipeRunStepStatus, 'ready' | 'skipped' | 'missing_input'>
  /** 可直接交给 browser runtime 的操作。 */
  operation: Nullable<BrowserRecipeStepOperation>
  /** 计划说明。 */
  message: string
  /** 该步骤使用的 input.name。 */
  inputName?: string
}

export type BrowserRecipeExecutionPlan = ReturnType<typeof buildRecipeExecutionPlan>

/** run record 中记录的 before/after snapshot artifact。 */
export interface BrowserRecipeRunSnapshotArtifacts {
  before: LooseOptional<BrowserWorkspaceArtifactRecord>
  after: LooseOptional<BrowserWorkspaceArtifactRecord>
}

/** 持久化到 runs/ 的 recipe 执行记录结构。 */
export interface BrowserRecipeRunRecord {
  /** 原始 recipe artifact 路径。 */
  recipePath: string
  /** recipe 创建时的页面 URL。 */
  recipeUrl: string
  /** recipe 标题。 */
  recipeTitle: string
  /** 是否为 dryRun 预检。 */
  dryRun: boolean
  /** 执行开始时间戳。 */
  startedAt: number
  /** 执行结束时间戳。 */
  finishedAt: number
  /** recipe 中可执行步骤数量。 */
  executableStepCount: number
  /** 实际执行成功的步骤数量。 */
  executedStepCount: number
  /** 跳过/未命中/缺输入的步骤数量。 */
  skippedStepCount: number
  /** 必填输入名列表。 */
  requiredInputNames: string[]
  /** 可选输入名列表。 */
  optionalInputNames: string[]
  /** 调用方传入但 recipe 没用到的输入名。 */
  unusedInputNames: string[]
  /** 缺失输入详情。 */
  missingInputs: Array<{
    stepId: string
    name: string
    label: string
    type: string
    required: boolean
  }>
  /** 本次输入中实际引用的变量占位符名；旧 run record 可能没有。 */
  usedVariableNames?: string[]
  /** 调用方传入但未被输入占位符使用的变量名；旧 run record 可能没有。 */
  unusedVariableNames?: string[]
  /** dryRun 中发现、真实执行前会要求补齐的变量名；旧 run record 可能没有。 */
  missingVariableNames?: string[]
  /** 每一步预览或执行结果。 */
  stepResults: BrowserRecipeRunStepResult[]
}

/** 读一份 recipe 骨架的回执：路径、骨架本身、读的时候所在的站点上下文。 */
export interface BrowserRecipeSkeletonRead {
  /** 工作区内的相对路径。 */
  path: string
  /** 解析出来的 recipe 骨架。 */
  recipe: BrowserRecipeSkeleton
  /** 读的时候当前站点的上下文（同源校验用的就是它）。 */
  context: BrowserSiteContext
}

/** 读一份页面快照的回执。 */
export interface BrowserPageSnapshotRead {
  /** 工作区内的相对路径。 */
  path: string
  /** 解析出来的页面检查结果。 */
  inspection: BrowserPageInspection
  /** 读的时候当前站点的上下文。 */
  context: BrowserSiteContext
}

/** 读一份 recipe 运行记录的回执。 */
export interface BrowserRecipeRunRead {
  /** 工作区内的相对路径。 */
  path: string
  /** 解析出来的运行记录。 */
  run: BrowserRecipeRunRecord
  /** 读的时候当前站点的上下文。 */
  context: BrowserSiteContext
}

/** recipe 里声明了、这次没给值的输入项。 */
export interface BrowserRecipeMissingInput {
  /** 属于哪一步。 */
  stepId: string
  /** 输入项的字段名。 */
  name: string
  /** 给用户看的标签。 */
  label: string
  /** 输入类型（text、number 等）。 */
  type: string
  /** 是不是必填。 */
  required: boolean
}

/** 存一次 recipe 骨架的回执。 */
export interface BrowserRecipeSkeletonSave {
  /** 落盘的产物记录。 */
  artifact: BrowserWorkspaceArtifactRecord
  /** 这份 recipe 的概要。 */
  recipe: {
    /** 生成时所在的页面地址。 */
    url: string
    /** 生成时的页面标题。 */
    title: string
    /** 骨架里有几步。 */
    stepCount: number
    /** 页面上认出多少个链接。 */
    linkCount: number
  }
  /** 骨架本身。 */
  skeleton: BrowserRecipeSkeleton
}

/** 存一次页面快照的回执。 */
export interface BrowserPageSnapshotSave {
  /** 落盘的产物记录。 */
  artifact: BrowserWorkspaceArtifactRecord
  /** 这一页的概要。 */
  page: {
    /** 页面地址。 */
    url: string
    /** 页面标题。 */
    title: string
    /** 采集时刻。 */
    capturedAt: number
    /** 标题结构有多少条。 */
    headings: number
    /** 链接有多少条。 */
    links: number
    /** 正文取了多少字符。 */
    textChars: number
  }
}

/** 从当前页面生成 recipe 骨架的回执：骨架本身，外加顺手存下的页面快照。 */
export interface BrowserRecipeSkeletonGenerate extends BrowserRecipeSkeletonSave {
  /** 顺手存下的页面快照；`saveSnapshot: false` 时是 null。 */
  sourceSnapshot: Nullable<BrowserPageSnapshotSave>
}

/** recipe 跑完一次的回执：每一步的结果、落盘的产物、输入与变量的对账。 */
export interface BrowserRecipeRunOutcome {
  /** 每一步的执行结果，按执行顺序。 */
  stepResults: BrowserRecipeRunStepResult[]
  /** 这次跑下来存的页面快照。 */
  snapshotArtifacts: BrowserRecipeRunSnapshotArtifacts
  /** 没存快照时的原因；存了就是 null。 */
  snapshotSaveSkippedReason: Nullable<string>
  /** 这次运行记录落盘的产物；没存时缺席。 */
  runArtifact: LooseOptional<BrowserWorkspaceArtifactRecord>
  /** 没存运行记录时的原因。 */
  runSaveSkippedReason: LooseOptional<string>
  /** 真正用上的变量名。 */
  usedVariableNames: string[]
  /** 给了却没人用的变量名。 */
  unusedVariableNames: string[]
  /** recipe 要、这次没给的变量名。 */
  missingVariableNames: string[]
  /** recipe 声明的必填输入名。 */
  requiredInputNames: string[]
  /** recipe 声明的选填输入名。 */
  optionalInputNames: string[]
  /** 给了却没人用的输入名。 */
  unusedInputNames: string[]
  /** 缺失的输入项明细。 */
  missingInputs: BrowserRecipeMissingInput[]
  /** 计划里能执行的步数。 */
  executableStepCount: number
  /** 实际执行了几步。 */
  executedStepCount: number
  /** 输入齐备、可以直接跑的步数。 */
  readyStepCount: number
  /** 因为缺输入而跑不了的步数。 */
  missingInputCount: number
  /** 跳过了几步。 */
  skippedStepCount: number
  /** recipe 的工作区相对路径。 */
  path: string
  /** recipe 声明的起始地址。 */
  url: string
  /** recipe 标题。 */
  title: string
  /** 这次是不是干跑。 */
  dryRun: boolean
}

/** 读一次运行记录并算出对账概要的回执。 */
export interface BrowserRecipeRunReview {
  /** 工作区内的相对路径。 */
  path: string
  /** 运行记录原文。 */
  run: BrowserRecipeRunRecord
  /** 给模型看的对账概要。 */
  summary: {
    /** recipe 的路径。 */
    recipePath: string
    /** recipe 声明的起始地址。 */
    recipeUrl: string
    /** recipe 标题。 */
    recipeTitle: string
    /** 这次是不是干跑。 */
    dryRun: boolean
    /** 开始时刻。 */
    startedAt: number
    /** 结束时刻。 */
    finishedAt: number
    /** 计划里能执行的步数。 */
    executableStepCount: number
    /** 实际执行了几步。 */
    executedStepCount: number
    /** 跳过了几步。 */
    skippedStepCount: number
    /** 必填输入名。 */
    requiredInputNames: string[]
    /** 选填输入名。 */
    optionalInputNames: string[]
    /** 缺失的输入项明细。 */
    missingInputs: BrowserRecipeMissingInput[]
    /** 真正用上的变量名。 */
    usedVariableNames: string[]
    /** 给了却没人用的变量名。 */
    unusedVariableNames: string[]
    /** recipe 要、这次没给的变量名。 */
    missingVariableNames: string[]
  }
}
