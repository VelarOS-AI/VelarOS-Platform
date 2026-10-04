/** 连续源码与版本绑定的编辑目标；公开数据不含模型需要计算的字符坐标。 */
import type { ProjectVisibleCoverage } from './file-refs.js'
import type { ProjectEditResult, ProjectRecodeReceipt } from './files.js'

/** @AgentView 工具签发的目标。一次脚本内直接传递此对象；跨轮原样使用 ref（target: 加 8 位十六进制）。path、kind、label 是说明，写入位置只由签发记录决定。 */
export interface ProjectSelection {
  ref: string
  path: string
  kind: 'file' | 'lines' | 'symbol' | 'text'
  label?: string
}

/** @AgentView 精确选择一个目标：path 与 within 二选一，symbol 与 match 二选一。symbol 是完整的声明名，如 Cache.load、outer.inner；内置解析器支持 JS/TS/JSX/TSX、Python/pyi。match 是唯一字面片段（CRLF/LF 等价，其余字符精确），只在 within 目标内查找。歧义返回候选，必须明确选中。 */
export type ProjectSelectTarget =
  | ({ path: string } & ({ symbol: string } | { match: string }))
  | ({ within: string | ProjectSelection } & ({ symbol: string } | { match: string }))

/** @AgentView 最多 1000 个目标、100 个源码文件；完整源码与返回正文各最多 20000000 字符，一项歧义最多 20 个完整候选，超限明确报错。没有可靠结构解析时用 match 或 read 的文本目标。 */
export interface ProjectSelectInput {
  targets: ProjectSelectTarget[]
}

/** @AgentView 已确认位置的连续原文。index 对应输入项，startLine 是工具计算的位置，不需要数行；text 保留缩进、注释和装饰器，按 LF 展示。新块按相同缩进提供。 */
export interface ProjectSelectedSource {
  index: number
  target: ProjectSelection
  startLine: number
  text: string
  /** 歧义片段附近的连续可见原文，仅用于选择候选，不扩大 target 的编辑范围。 */
  context?: { startLine: number; text: string }
}

/** @AgentView 定位缺口。候选只是选项；取其中一个 target 才能在后续 patch 中明确指定位置。 */
export interface ProjectSelectIssue {
  index: number
  code: string
  message: string
  next?: string
  candidates?: ProjectSelectedSource[]
}

/** @AgentView targets 只有唯一成功项；issues 保留全部失败项。存在缺口时先处理，不把成功子集当作完整请求。 */
export interface ProjectSelectResult {
  targets: ProjectSelectedSource[]
  issues?: ProjectSelectIssue[]
}

/** @AgentView 替换 target 为 text；op 缺省 replace，before/after 在目标前/后插入。只发新正文，不复制旧块、不计算坐标。文件/片段按字符替换；整行/结构块保留末行原换行，新块包含自身缩进。 */
export interface ProjectPatchEdit {
  target: string | ProjectSelection
  text: string
  op?: 'replace' | 'before' | 'after'
}

/** @AgentView 增量修正失败计划的一项：index 是原始 edits 的下标；edit 为 null 明确移除此项，其余项不变。 */
export interface ProjectPatchAmendment {
  index: number
  edit: Nullable<ProjectPatchEdit>
}

/** @AgentView 一次最多 1000 项，同文件各项基于同一原文一次拼接，整个批次一个事务，缺省最多 100 个文件。receipt 缺省 summary；full 获取完整差量和变更窗口。blocked 的 planRef 可用 amendments 修正，无需重新发送正确项；版本冲突必须重新定位，不自动模糊应用。 */
export type ProjectPatchInput =
  | { edits: ProjectPatchEdit[]; receipt?: 'summary' | 'full' }
  | {
      planRef: string
      amendments: ProjectPatchAmendment[]
      receipt?: 'summary' | 'full'
    }

/** @AgentView 简短提交回执；inspect(changeRef) 可取完整差量，undo 可整次撤销。changed=false 时 changeRef 可能为空。 */
export interface ProjectEditSummary {
  changeRef: string
  transactionId: string
  changed: boolean
  changedFiles: string[]
  oldRevisions: Record<string, string>
  newRevisions: Record<string, string>
  diffLines: number
  notes?: string[]
  recode?: ProjectRecodeReceipt
}

/** @AgentView 整批未提交的问题。index 有值时指 edits 原始下标；没有 index 是事务级校验问题。details 保留候选、诊断或恢复材料。 */
export interface ProjectPatchIssue {
  index?: number
  code: string
  message: string
  next?: string
  details?: Record<string, unknown>
}

/** @AgentView applied 才表示提交成功；blocked 明确一字节未写，保留计划及所有独立定位问题。取消、未知写入状态、回滚失败仍抛错，不伪装成 blocked。计划只在本会话、本项目有效，提交后不能再重用。 */
export type ProjectPatchResult =
  | ({ status: 'applied' } & ProjectEditSummary)
  | ({ status: 'applied' } & ProjectEditResult)
  | {
      status: 'blocked'
      executionOutcome: 'not-applied'
      planRef: string
      issues: ProjectPatchIssue[]
    }

/** 工具内部绑定；偏移为原始 JS 字符串 UTF-16 下标，禁止由模型提供或猜测。 */
export interface ProjectSelectionRecord {
  fileRef: string
  start: number
  end: number
  kind: ProjectSelection['kind']
  lines: boolean
  coverage: ProjectVisibleCoverage[]
  label?: string
}

/** 已解析的结构边界：解析器只定位，修改始终拼接原始源码。 */
export interface ProjectStructureSpan {
  name: string
  start: number
  end: number
}

/** 未提交的可增量修正计划；null 保留原下标。 */
export interface ProjectPatchDraft {
  edits: Array<Nullable<ProjectPatchEdit>>
  receipt: 'summary' | 'full'
}
