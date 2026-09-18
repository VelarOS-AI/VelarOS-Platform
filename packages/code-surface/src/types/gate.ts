/**
 * 代码面那扇门上流动的数据：四个工具的入参、门的入参与回执、门替每个会话记着的状态。
 */

import type { ScriptDiffKind, ScriptStepOp } from '../contract/constants.js'
import type { CodeSurfaceEventSink, CodeSurfaceSpacePort, CodeSurfaceTimelinePort } from '../contract/requires.js'

import type { CodeAttachment, CodeProgramEdit, CodeProgramFailure, CodeSurfaceOutcome, ScriptFileChange } from './code-surface.js'

/**
 * `script:exec` 的一步。哪几个字段有用看 op：
 * write 要 path、program；edit 要 path、edits，from 可选；restore 要 path、version；
 * run 要 program 或 from（带 from 时可以加 edits），input、blobs 可选；replay 要 step，或者 from、to 一段调用号。
 */
export type ScriptStepInput = {
  /** 这一步做什么。 */
  op: ScriptStepOp
  /** 代码正文（write、run）。 */
  program?: string
  /** 底稿：已有的代码——脚本库里的 `lib/x.js`（最新版）、`lib/x.js@3`，或者之前的一步 `C12.2`（edit、run）；replay 一段时是从哪次调用起（`C10`）。 */
  from?: string
  /** replay 一段时到哪次调用止（`C14`）；不给是到最近一次。 */
  to?: string
  /** 在底稿上改的几处（edit、run）。 */
  edits?: CodeProgramEdit[]
  /** 脚本库里的路径（write、edit、restore）。 */
  path?: string
  /** 退回到哪一版（restore）。 */
  version?: number
  /** 重放哪一步（replay）：`C12.2`。 */
  step?: string
  /** 参数（run）：脚本里 `import { input } from 'velar:program'` 取。 */
  input?: unknown
  /** 大段文本（run）：脚本里 `import { blobs } from 'velar:program'` 按名字取。 */
  blobs?: Record<string, string>
}

/** `script:exec` 的入参：几步，按顺序做。 */
export type ScriptExecInput = {
  /** 各步，按顺序做；某一步没成就停，后面的不做。 */
  steps: ScriptStepInput[]
}

/** `script:history` 的入参：都不给就是最近的几条。 */
export type ScriptHistoryInput = {
  /** 只看写过、改过、跑过这个脚本的步骤（库里的路径）。 */
  script?: string
  /** 只看改过这个文件的步骤与外部改动（相对工作区根目录）。 */
  file?: string
  /** 从哪次调用起（`C10`）。 */
  from?: string
  /** 到哪次调用止（`C14`）。 */
  to?: string
  /** 最多列几条。 */
  limit?: number
}

/** `script:show` 的入参。 */
export type ScriptShowInput = {
  /** 看什么：调用 `C12`、步骤 `C12.2`、脚本 `lib/x.js` 或 `lib/x.js@3`；不给就是脚本库目录。 */
  ref?: string
  /** 只看这一步 blobs 里的这一段。 */
  blob?: string
}

/** `script:diff` 的入参。 */
export type ScriptDiffInput = {
  /** 旧的那一边。 */
  from: string
  /** 新的那一边；不给时代码比这个脚本的最新版，时间点比现在。 */
  to?: string
  /** 比代码还是比文件；不给按引用猜：调用号与 now 比文件，其余比代码。 */
  of?: ScriptDiffKind
}

/** 门办一次 exec 要的东西。 */
export interface CodeGateExecInput {
  /** 会话身份：导入过的模块按它记，时间线按它标出是谁的调用。 */
  sessionId: string
  /** 各步。 */
  steps: readonly ScriptStepInput[]
  /** 这一次调用所在的空间：挂的能力、能力端口、时间线。 */
  space: CodeSurfaceSpacePort
  /** 每一段程序的墙钟上限（毫秒）；不给用缺省，仍受对外上限钳制。 */
  timeoutMs?: number
  /** 取消信号：用户停下这一轮时触发。 */
  signal?: AbortSignal
  /** 界面要实时看见的事（调用起止、日志）；模型那边不走这条路。 */
  events?: CodeSurfaceEventSink
}

/** 门查一次时间线（history、show、diff）要的东西。 */
export interface CodeGateQuery<TQuery> {
  /** 会话身份：history 据此标出哪些调用是别的会话的。 */
  sessionId: string
  /** 这个空间的时间线。 */
  timeline: CodeSurfaceTimelinePort
  /** 工具的入参。 */
  query: TQuery
  /** 取消信号。 */
  signal?: AbortSignal
}

/** exec 里一步的结果：给宿主画界面、记账用；模型读的是回执文字。 */
export interface ScriptStepReport {
  /** 步骤号，如 `C14.2`。 */
  ref: string
  /** 做的什么。 */
  op: ScriptStepOp
  /** 成没成。 */
  ok: boolean
  /** 存成了哪一版（`lib/x.js@3`）：write、edit、restore 成功时有。 */
  saved?: string
  /** run、replay 交给会话之后的原样结果。 */
  outcome?: CodeSurfaceOutcome
  /** 没成时的码与说明。 */
  error?: CodeProgramFailure
  /** 这一步改了工作区里哪些文件（只有哈希）。 */
  changes?: readonly ScriptFileChange[]
}

/** 门办完一次 exec 交回的东西：给模型读的一段文字、跟在后面的图，以及每一步的结果。 */
export interface CodeGateReply {
  /** 给模型读的回执：每一步一段，开头是步骤号。 */
  text: string
  /** 各步的程序交给模型看的图，按交出的顺序。 */
  images: readonly CodeAttachment[]
  /** 调用号，如 `C14`。 */
  call: string
  /** 做了的那几步；没成的那一步之后的不在里面。 */
  steps: readonly ScriptStepReport[]
}

/** 门替一个会话记着的东西。 */
export interface CodeGateSessionState {
  /** 模型 import 过、完整声明已经给过它的模块（命名空间）；检查程序时一并加载。 */
  imported: Set<string>
  /** 给过声明、后来退租的模块：再用到时静默装回去，不再让模型白跑一轮。 */
  retired: Set<string>
}

/** 门的工具结果里交给模型的一块：一段文字，或者一张图。 */
export type ScriptModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image-data'; data: string; mediaType: string }

/**
 * 门的工具结果：result 与 modelContent 里的文字逐字相同——agent 认出这一点，就把 modelContent 原样交给模型，
 * 不再转义、截断；图跟在文字后面，每张前面一行说明。
 */
export interface ScriptToolResult {
  /** 给模型读的全部文字（modelContent 里各段文字按换行拼起来）。 */
  result: string
  /** 交给模型的内容块：文字在前，图在后。 */
  modelContent: ScriptModelContentPart[]
}
