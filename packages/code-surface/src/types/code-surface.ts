/**
 * 可移植数据：代码面上流动的那些形状——模型交上来的程序、typecheck 的诊断、跑完之后回给模型的结果。
 * 不 import 任何东西，渲染进程也能加载（从 `@velaros-ai/code-surface/contracts` 取）。
 */

import type { CodeSurfaceErrorCode } from '../contract/constants.js'

/** 一段字符区间，两端都从 0 起、右开。 */
export interface CodeProgramRange {
  /** 起点，从 0 起。 */
  offset: number
  /** 终点，右开。 */
  end: number
}

/**
 * 在上一份程序上改的一处：`oldText` 一字不差、范围里必须唯一、一组全成或全不成、各处不许重叠。
 *
 * **不用行号**——模型看不见自己刚写的那段代码的行号，让它数行是在让它做最不擅长的事。
 * `oldText` 是主键，`range` 只是可选的收窄手段：程序是模型刚写的，没有回执可以照抄位置。
 */
export interface CodeProgramEdit {
  /** 要换掉的原文，必须和上一份程序里的字符一模一样（含缩进与换行），且在范围里唯一。 */
  oldText?: string
  /** 换成什么；空串就是把那一段删掉。 */
  newText: string
  /** 可选：把查找范围收窄到这一段；不给就在整份程序里找。不给 `oldText` 时则是把这一整段换掉，空区间就是在那个位置插入。 */
  range?: CodeProgramRange
}

/**
 * 模型交上来的一次程序。
 *
 * `blobs` 是这份契约里最不显然的一格，理由值得写下来：文件内容这类大字符串**不许进 `source`**。
 * 进了就要过三层转义（JSON 字符串 → JS 字符串字面量 → 内容本身），反引号、`${`、反斜杠、引号全是雷。
 * 走 `blobs` 只有一层；程序里按名字引用（`blobs.patch`）。
 */
export interface CodeProgramRequest {
  /**
   * 程序正文，是一个 **JavaScript ES 模块**：`import` 拿能力，顶层 `await` 直接用，`export default` 交出答案。
   *
   * 写 JavaScript 而不是 TypeScript，但**照样受类型检查**——类型从生成的声明里推，
   * 字段名拼错、读一个不存在的字段、入参形状错，都在执行之前就被拦下。
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

/** 账上的一笔：程序发出去并且**已经落定**的一次能力调用。 */
export interface CompletedCall {
  /** 调的是谁，如 `system.edit`。 */
  call: string
  /** 成没成。没成时副作用通常没发生，但这要看那件能力自己的语义。 */
  ok: boolean
  /**
   * 连着调了几次。只有 >1 时才给。
   *
   * 账上只记「调的是谁」不记参数（参数可以很大），所以循环里连着的同名同结果那几笔本来就分不开，
   * 折成一个数不丢信息，却让「读了 23 个文件之后停在这」一眼看得出来。
   */
  times?: number
}

/**
 * 一次程序跑完之后回给模型的东西。
 *
 * 成功时 `value` 是主角，其余有才给；失败时主角换成 `failed` 与 `logs`——
 * 返回值没了，日志是唯一能说明「走到哪一步、拿到了什么」的东西。
 */
export interface CodeProgramResult {
  /** 程序 `export default` 交出来的值；失败时没有这一格。 */
  value?: unknown
  /** 程序里 `console.log` 的输出，超出预算时保留结尾（失败现场在尾部）。 */
  logs?: string[]
  /** 系统插手过的地方。 */
  notices?: CodeCallNotice[]
  /**
   * 程序中止或失败时，已经做完的那些调用**逐条**列在这里；正常跑完时没有这一格。
   *
   * 成功时不列是因为程序是模型自己写的、它知道自己调了什么；
   * **失败与中止时它不知道自己做到哪了**：中断落在程序执行的中途，副作用是真的，
   * 只回一个 `ABORTED` 等于让它对着三个字瞎猜。
   *
   * 这是**账**不是事务：它不承诺回滚（跑过的命令回滚不了），承诺**知道**。
   */
  completed?: CompletedCall[]
  /** 程序没跑完时的说明。 */
  failed?: CodeProgramFailure
}

/** typecheck 没过时的结果：程序**一行都没有执行**，所以不是 `CodeProgramResult` 的形状。 */
export interface CodeProgramCheckFailure {
  /** 恒为 false，用来和通过的那支区分。 */
  ok: false
  /** 逐条诊断，最多 20 条。 */
  diagnostics: CodeProgramDiagnostic[]
  /** 还有几条没列出。后面的多半是前面那几处连带出来的——先改列出的，再交一次。 */
  omitted?: number
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
  | {
      /** typecheck 没走到：程序 import 了没授权的模块。 */
      checked: false
      /** 要补签名的命名空间，按程序里出现的顺序。 */
      needsModules: string[]
    }
  | {
      checked: true
      result: CodeProgramResult
      /** 程序里的能力 import 与租约意图；宿主据此续租、退租、回收。没有 import 就没有这一格。 */
      imports?: readonly ProgramImport[]
    }

/**
 * 租约的三档：**意图，不是期限**。
 *
 * 不让模型报「几轮」——它看不见前缀预算，报短了被回收白花一轮重导，报长了前缀膨胀它也感知不到。
 * `once` / `task` / `done` 是它答得对的东西。宿主拥有回收策略，这三档只是优先级信号。
 */
export type CapabilityLease = 'once' | 'task' | 'done'

/** 程序里的一条能力 import。 */
export interface ProgramImport {
  /** 命名空间，如 `system`；`velar:` 前缀已剥掉。 */
  namespace: string
  /** 原样的模块名，如 `velar:system`。 */
  specifier: string
  /** 模型给的租约意图；没写就没有这一格。 */
  lease?: CapabilityLease
}

/** 这一轮授给程序的一个能力模块：命名空间与它的完整声明。 */
export interface GrantedModule {
  /** 命名空间，如 `system`。 */
  namespace: string
  /** 这个命名空间的完整 `.d.ts` 正文。 */
  declarations: string
}
