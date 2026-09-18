/**
 * 时间线的形状：日志里的每一行、脚本库里的一版、时间线上的引用、工作区标记。包内用，不出包。
 *
 * 时间线只存操作（代码、参数、结果、调过的能力）和哈希，不存工作区文件的内容。
 */

import type { ScriptStepOp } from '../contract/constants.js'

import type { CodeAttachment, CodeProgramFailure, CompletedCall, ScriptFileChange } from './code-surface.js'
import type { ScriptStepReport } from './gate.js'

/** 日志里的一行：一次调用的开头。 */
export interface TimelineCallRecord {
  /** 恒为 call。 */
  t: 'call'
  /** 调用号的数字（C14 记成 14）。 */
  call: number
  /** 哪个会话的调用。 */
  session: string
  /** 开始的时刻（毫秒）。 */
  at: number
  /** 开头时工作区的标记；没有工作区、或者工作区太大没打成时不给。 */
  marker?: string
  /** 上一个记下的标记之后、这次开头之前，工作区被外面（用户、编辑器、别的程序）改了的文件。 */
  external?: ScriptFileChange[]
}

/** 保留上限清掉的东西：结果正文，或者参数（清掉参数的步骤不能再重放）。 */
export type TimelineDroppedPart = 'result' | 'input'

/** 日志里的一行：一步。 */
export interface TimelineStepRecord {
  /** 恒为 step。 */
  t: 'step'
  /** 属于哪次调用（数字）。 */
  call: number
  /** 第几步，从 1 起。 */
  step: number
  /** 做的什么。 */
  op: ScriptStepOp
  /** 开始的时刻（毫秒）。 */
  at: number
  /** 花了多久（毫秒）。 */
  ms: number
  /** 成没成。 */
  ok: boolean
  /** 没成时的码与说明。 */
  error?: CodeProgramFailure
  /** 这一步用的代码（正文的哈希）；检查没过的也记，下一步能在它上面改。 */
  code?: string
  /** 代码的底稿：from 解析出来的那一版（`lib/x.js@2`、`C12.1`）。 */
  base?: string
  /** write、edit、restore：存成了脚本库里的哪个路径；run、replay：代码在库里的位置（相对 import 从这里算）。 */
  path?: string
  /** write、edit、restore 成功时存成的版本号。 */
  version?: number
  /** 参数的哈希（input 按 JSON 存）。 */
  input?: string
  /** 大段文本的哈希（blobs 按 JSON 存）。 */
  blobs?: string
  /** 跑的时候用到的库里脚本各是哪一版：路径 → 版本号。重放按它钉住。 */
  deps?: Record<string, number>
  /** 回给模型的那份文字的哈希。 */
  result?: string
  /** 调过的能力。 */
  calls?: CompletedCall[]
  /** 这一步改了工作区里哪些文件。 */
  changes?: ScriptFileChange[]
  /** 这一步做完时工作区的标记。 */
  marker?: string
  /** replay：重放的是哪一步（`C12.2`）。 */
  replayOf?: string
  /** 保留上限清掉了什么。 */
  dropped?: TimelineDroppedPart[]
}

/** 日志里的一行。 */
export type TimelineRecord = TimelineCallRecord | TimelineStepRecord

/** 一次调用：开头那一行加上它的各步。 */
export interface TimelineCallView {
  /** 开头那一行。 */
  record: TimelineCallRecord
  /** 各步，按步号排。 */
  steps: TimelineStepRecord[]
}

/** 脚本库里的一版。 */
export interface ScriptVersionRecord {
  /** 库里的路径。 */
  path: string
  /** 版本号，从 1 起。 */
  version: number
  /** 正文的哈希。 */
  code: string
  /** 哪一步存的（`C14.1`）。 */
  step: string
  /** 存的时刻（毫秒）。 */
  at: number
}

/** 时间线上的一个引用：一次调用、一步、一版脚本（不给版本就是最新版），或者现在。 */
export type TimelineRef =
  | { kind: 'call'; call: number }
  | { kind: 'step'; call: number; step: number }
  | { kind: 'script'; path: string; version?: number }
  | { kind: 'now' }

/** 解析出来的一份代码：正文、它的哈希、它在库里的位置，以及它从哪来（写进回执与日志）。 */
export interface ResolvedCode {
  /** 正文。 */
  source: string
  /** 正文的哈希。 */
  code: string
  /** 在库里的位置：相对 import 从这里算；直接跑过的代码没有。 */
  path?: string
  /** 规范写法：`lib/x.js@3` 或 `C12.2`。 */
  ref: string
  /** 来自一步时是那一步的记录：run 沿用它的参数，replay 照它重跑。 */
  step?: TimelineStepRecord
}

/** 目录节点里的一项：名字、文件还是目录、内容哈希（目录是它那个节点的哈希）。 */
export type MarkerEntry = [name: string, kind: 'f' | 'd', hash: string]

/** 拼目录树时用的中间形状：名字 → 文件的哈希，或者下一层目录。 */
export type MarkerDirectory = Map<string, MarkerDirectory | string>

/** 扫一遍工作区的结果。 */
export interface WorkspaceScan {
  /** 标记：整棵目录树的根哈希。内容相同，标记就相同。 */
  marker: string
  /** 每个文件的内容哈希：相对路径 → 哈希。 */
  files: ReadonlyMap<string, string>
}

/** stat 缓存里的一项：大小、修改时间、inode 都没变时不重算哈希。 */
export interface MarkerStatEntry {
  /** 字节数。 */
  size: number
  /** 修改时间（毫秒，带小数）。 */
  mtimeMs: number
  /** inode 号。 */
  ino: number
  /** 当时算出的内容哈希。 */
  hash: string
}

/** 落盘的 stat 缓存：哪个根目录的、每个文件一项。 */
export interface MarkerStatCache {
  /** 扫的是哪个根目录；换了根整个作废。 */
  root: string
  /** 相对路径 → 那一项。 */
  files: Record<string, MarkerStatEntry>
}

/** 时间线上的一个时间点：某一步做完之后，或者某次调用开头（那之前外面刚改过）。 */
export interface TimelinePoint {
  /** 步骤号（`C12.2`，那一步做完之后）或调用号（`C13`，那次调用开头）。 */
  ref: string
  /** 为真时是调用开头。 */
  start?: true
}

/** 重放前后核对出来对不上的一个文件。 */
export interface ReplayMismatch {
  /** 相对工作区根目录的路径。 */
  path: string
  /** 应当是什么（哈希；不存在时不给）。 */
  expected?: string
  /** 实际是什么（哈希；不存在时不给）。 */
  actual?: string
}

/** 做完一步的产物：记进日志的那一行、给宿主的结果、回执里这一段的文字、这一步交给模型的图。 */
export interface ScriptStepResult {
  /** 记进日志的那一行。 */
  record: TimelineStepRecord
  /** 给宿主的结果。 */
  report: ScriptStepReport
  /** 回执里这一段的正文（段头由调用方加）。 */
  text: string
  /** 这一步的程序交给模型看的图。 */
  images: readonly CodeAttachment[]
}

/** 一步要跑的那份代码与它的参数：run 与 replay 共用。 */
export interface ScriptRunPlan {
  /** 正文。 */
  source: string
  /** 在库里的位置：相对 import 从这里算。 */
  path?: string
  /** 代码的底稿（`lib/x.js@3`、`C12.2`）。 */
  base?: string
  /** 参数。 */
  input?: unknown
  /** 大段文本。 */
  blobs?: Record<string, string>
  /** 它 import 到的库里的脚本：路径 → 正文。 */
  modules: Record<string, string>
  /** 那些脚本各是哪一版。 */
  deps: Record<string, number>
  /** replay：重放的是哪一步。 */
  replayOf?: string
}
