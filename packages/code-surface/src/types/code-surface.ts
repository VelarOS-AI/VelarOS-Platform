/**
 * 可移植数据：代码面上流动的那些形状——模型交上来的程序、typecheck 的诊断、跑完之后回给模型的结果。
 * 不 import 任何东西，渲染进程也能加载（从 `@velaros-ai/code-surface/contracts` 取）。
 */

import type { CodeSurfaceErrorCode } from '../contract/constants.js'

/**
 * 模型交上来的一次程序。
 *
 * `blobs` 是这份契约里最不显然的一格，理由值得写下来：文件内容这类大字符串**不许进 `source`**。
 * 进了就要过三层转义（JSON 字符串 → TS 字符串字面量 → 内容本身），反引号、`${`、反斜杠、引号全是雷。
 * 走 `blobs` 只有一层，和今天的工具调用一样；程序里按名字引用（`blobs.patch`）。
 */
/** 一段字符区间，两端都从 0 起、右开；与 `system:read` 回执里的 `range` 同形。 */
export interface CodeProgramRange {
  /** 起点，从 0 起。 */
  offset: number
  /** 终点，右开。 */
  end: number
}

/**
 * 在上一份程序上改的一处。协议照 `system:edit`：`oldText` 一字不差、范围里必须唯一、
 * 一组全成或全不成、各处不许重叠。
 *
 * **不用行号**——模型看不见自己刚写的那段代码的行号，让它数行是在让它做最不擅长的事。
 * `system:edit` 的 `range` 是必填的（那来自 `system:read` 的回执，模型照抄即可）；
 * 这里的程序是模型刚写的、没有回执可抄，所以 `oldText` 升为主键、`range` 只是可选的收窄手段。
 */
export interface CodeProgramEdit {
  /** 要换掉的原文，必须和上一份程序里的字符一模一样（含缩进与换行），且在范围里唯一。 */
  oldText?: string
  /** 换成什么；空串就是把那一段删掉。 */
  newText: string
  /** 可选：把查找范围收窄到这一段；不给就在整份程序里找。不给 `oldText` 时则是把这一整段换掉，空区间就是在那个位置插入。 */
  range?: CodeProgramRange
}

export interface CodeProgramRequest {
  /**
   * 程序正文，是一段 **JavaScript 函数体**：可以直接 `await`，用 `return` 交出答案。
   *
   * 写 JavaScript 而不是 TypeScript，但**照样受类型检查**——类型从生成的声明里推，
   * `contents` 拼错、读一个不存在的字段、入参形状错，都在执行之前就被拦下。
   * 不写类型标注换来的是：中间不必转译，因而没有转译带来的行号错位，报给模型的位置永远是它写的那一行。
   */
  source?: string
  /**
   * 在**上一份程序**上改，而不是整份重写。与 `source` 二选一。
   *
   * typecheck 挡回去之后整份重发，六十行的程序每迭代一次就是六十行输出，还容易在别处改出新错。
   * 上一份程序由宿主记着并在 `submit` 时给进来；给不出来时这条会被明确拒绝，让模型改发整份。
   */
  edits?: readonly CodeProgramEdit[]
  /** 大字符串旁路：键是程序里引用的名字，值原样送达，不经任何转义加工。 */
  blobs?: Record<string, string>
}

/** typecheck 的一条诊断；行列号已经换算成模型写的那一行。 */
export interface CodeProgramDiagnostic {
  /** 模型源码里的行号，从 1 起。 */
  line: number
  /** 列号，从 1 起。 */
  column: number
  /** TypeScript 的诊断码，如 2551。 */
  code: number
  /** 诊断正文，已经把嵌套链展平成一行。 */
  message: string
}

/**
 * 系统替模型做过的一次调整：钳制、补缺省、拒绝、截断。
 *
 * 只回放**系统插手过的地方**——程序是模型自己写的，调用清单它自己知道，回放一遍是白占字数。
 */
export interface CodeCallNotice {
  /** 哪次调用上发生的，如 `system.read`。 */
  call: string
  /** 涉及的字段名；整次调用层面的事（比如被拒）留空。 */
  field?: string
  /** 做了什么。 */
  action: 'clamped' | 'defaulted' | 'denied' | 'truncated' | 'normalized'
  /** 一句话说明调整前后是什么。 */
  detail: string
}

/** 程序没跑完时的失败说明。 */
export interface CodeProgramFailure {
  /** 失败类别。 */
  code: CodeSurfaceErrorCode
  /** 给模型看的一句话。 */
  message: string
  /** 出错在模型源码的第几行；换算不出来时不给。 */
  line?: number
}

/**
 * 一次程序跑完之后回给模型的东西。
 *
 * 成功时 `value` 是主角，其余有才给；失败时主角换成 `failed` 与 `logs`——
 * 返回值没了，日志是唯一能说明「走到哪一步、拿到了什么」的东西。
 */
export interface CodeProgramResult {
  /** 程序 `return` 出来的值；失败时没有这一格。 */
  value?: unknown
  /** 程序里 `console.log` 的输出，超出预算时保留结尾（失败现场在尾部）。 */
  logs?: string[]
  /** 系统插手过的地方。 */
  notices?: CodeCallNotice[]
  /** 程序没跑完时的说明。 */
  failed?: CodeProgramFailure
}

/** typecheck 没过时的结果：程序**一行都没有执行**，所以不是 `CodeProgramResult` 的形状。 */
export interface CodeProgramCheckFailure {
  /** 恒为 false，用来和通过的那支区分。 */
  ok: false
  /** 逐条诊断。 */
  diagnostics: CodeProgramDiagnostic[]
}

/** typecheck 通过。 */
export interface CodeProgramCheckSuccess {
  /** 恒为 true。 */
  ok: true
  /**
   * 模型手滑写了 TypeScript 时，这里是替它剥掉类型之后的 JavaScript；写的本来就是 JS 时没有这一格。
   *
   * 为什么不直接弹回去：仓库的宽容铁律是「钳制不拒绝」——语法偏好不值得废掉一整轮。
   * 真正的类型错误照样拦，只有「这个语法只能在 TypeScript 文件里用」那一族才走这条路。
   */
  transpiled?: string
  /** 走过上面那条路时为真，用来在回执里提醒模型下次直接写 JavaScript。 */
  wroteTypeScript?: true
}

/** typecheck 的结果。 */
export type CodeProgramCheckResult = CodeProgramCheckSuccess | CodeProgramCheckFailure

/**
 * 一次程序的最终去向：要么 typecheck 就没过（**一行都没执行**），要么跑完了。
 *
 * 两支形状不同是故意的：没过检查时根本没有「结果」这回事，硬凑一个空结果会让调用方分不清
 * 「没跑」和「跑了但没产出」。
 */
export type CodeSurfaceOutcome =
  | { checked: false; check: CodeProgramCheckFailure }
  | { checked: true; result: CodeProgramResult }
