/**
 * 可移植数据：代码面上流动的那些形状——模型交上来的程序、语法检查的诊断、跑完之后回给模型的结果。
 * 不 import 任何东西，渲染进程也能加载（从 `@velaros-ai/script/contracts` 取）。
 */

import type { CodeSurfaceErrorCode } from '../contract/constants.js'

/**
 * 在底稿上改的一处：`oldText` 一字不差、在底稿里唯一，换成 `newText`；一组全成或全不成、各处不许重叠。
 * 底稿由宿主按不可变 sourceRef 解析，编辑只生成候选程序。
 *
 * **不用行号，也不用字符位置**——模型看不见自己写过的代码的行号与偏移，让它数是在让它做最不擅长的事。
 * 不唯一时多带几行上下文，直到唯一为止。
 */
export interface CodeProgramEdit {
  /** 要换掉的原文，必须和底稿里的字符一模一样（含缩进与换行），且在整份底稿里唯一。 */
  oldText: string
  /** 换成什么；空串就是把那一段删掉。 */
  newText: string
}

/**
 * 交给会话的一份脚本：正文、它在脚本库里的位置、它会 import 的库里的脚本，以及这一次的参数。
 *
 * `blobs` 是这份契约里最不显然的一格，理由值得写下来：文件内容这类大字符串**不许进 `source`**。
 * 进了就要过三层转义（JSON 字符串 → JS 字符串字面量 → 内容本身），反引号、`${`、反斜杠、引号全是雷。
 * 走 `blobs` 只有一层；脚本里按名字引用（`blobs.patch`）。
 */
export interface CodeProgramRequest {
  /**
   * 脚本正文，是一个 **JavaScript ES 模块**：`import` 拿能力，顶层 `await` 直接用，`export` 交出答案。
   *
   * 写 JavaScript 而不是 TypeScript：执行之前只查语法、核对每个 import 落得到，不查类型；
   * 字段名拼错、入参形状错由运行时当场报（能力的入参按 schema 校验，写错的那次调用不生效）。
   * 中间不必转译，因而没有转译带来的行号错位，报给模型的位置永远是它写的那一行。
   */
  source: string
  /** 这份脚本在脚本库里的路径（`lib/changelog.js`），它里面的相对 import 从这里算；直接跑的代码没有路径，从库根算。 */
  path?: string
  /** 它会 import 到的库里的脚本：路径 → 正文。检查与执行都只用这里给的这一份，版本由调用方定。 */
  modules?: Readonly<Record<string, string>>
  /** 这一次的参数：脚本里 `import { input } from 'velaros:program'` 取，原样送达（JSON 值）。 */
  input?: unknown
  /** 大字符串旁路：键是脚本里引用的名字，值原样送达，不经任何转义加工。 */
  blobs?: Record<string, string>
}

/** 检查的一条诊断；行列号已经换算成模型写的那一行。 */
export interface CodeProgramDiagnostic {
  /** 出在脚本库里的哪个脚本（它 import 的那些）；出在交上来的这份本身时不给。 */
  file?: string
  /** 模型源码里的行号，从 1 起。 */
  line: number
  /** 列号，从 1 起。 */
  column: number
  /** TypeScript 的诊断码，如 1005；import 落不到是 2307。 */
  code: number
  /** 诊断正文，已经把嵌套链展平成一行。 */
  message: string
  /** 出错源码的一行与列定位，计入诊断预算。 */
  frame?: string
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
   * 折成一个数不丢信息，却让「读了 23 个文件之后停在这」一眼看得出来。带 changeRef 的不折。
   */
  times?: number
  /** 能力回执里带的改动引用（`velaros:project` 的 edit 给的 changeRef）：撤这次改动凭它。 */
  changeRef?: string
  /** 同一份回执里的 changedFiles：这次改动动了哪些文件。 */
  changedFiles?: string[]
}

/**
 * 一次程序跑完之后回给模型的东西。
 *
 * 成功时 `value` 是主角，其余有才给；失败时主角换成 `failed` 与 `logs`——
 * 返回值没了，日志是唯一能说明「走到哪一步、拿到了什么」的东西。
 */
export interface CodeProgramResult {
  /** 标准 Node 执行的退出状态与有界输出。 */
  process?: NodeProcessReceipt
  /**
   * 程序导出的东西：只有 `export default` 时就是它；有具名导出时是 `{ default?, 名字: 值… }`（跟 `import * as m` 同形）。
   * 什么都没导出、或者没跑完时没有这一格。
   */
  value?: unknown
  /** 程序有具名导出、`value` 是 `{ default?, 名字: 值… }` 时为真：回执按名字分开给模型看。 */
  named?: true
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
  /**
   * 程序停下时（不管是跑完、失败、超时还是被中止）还没落定的能力调用，按发出的顺序；都已经要求它们停下。
   *
   * 程序不 await 就结束、或者死在一次调用中途时才会有：这些调用的副作用可能做了一半，模型要知道去核对哪几样。
   */
  unsettled?: string[]
  /** 程序没跑完时的说明。 */
  failed?: CodeProgramFailure
}

/** 检查没过时的结果：程序**一行都没有执行**，所以不是 `CodeProgramResult` 的形状。 */
export interface CodeProgramCheckFailure {
  /** 恒为 false，用来和通过的那支区分。 */
  ok: false
  /** 逐条诊断，最多 20 条。 */
  diagnostics: CodeProgramDiagnostic[]
  /** 还有几条没列出。后面的多半是前面那几处连带出来的——先改列出的，再交一次。 */
  omitted?: number
}

/** 检查通过。 */
export interface CodeProgramCheckSuccess {
  /** 恒为 true。 */
  ok: true
  /**
   * 模型手滑写了 TypeScript 时，这里是替它剥掉类型之后的 JavaScript；写的本来就是 JS 时没有这一格。
   *
   * 为什么不直接弹回去：仓库的宽容铁律是「钳制不拒绝」——语法偏好不值得废掉一整轮。
   * 真正的语法错误照样拦，只有「这个语法只能在 TypeScript 文件里用」那一族才走这条路。
   */
  transpiled?: string
  /** 走过上面那条路时为真，用来在回执里提醒模型下次直接写 JavaScript。 */
  wroteTypeScript?: true
}

/** 检查的结果。 */
export type CodeProgramCheckResult = CodeProgramCheckSuccess | CodeProgramCheckFailure

/** 这一轮授给程序的一个能力模块：命名空间与它的完整声明。 */
export interface GrantedModule {
  /** 命名空间，如 `system`。 */
  namespace: string
  /** 这个命名空间的完整 `.d.ts` 正文。 */
  declarations: string
}

/** 宿主提供的虚拟包；成员只引用已注册模块，不携带代码。 */
export interface ScriptPackageDefinition {
  /** 脚本导入名，velaros 为原语包。 */
  readonly specifier: string
  /** 导出成员名到真实 Kernel 模块身份。 */
  readonly exports: Readonly<Record<string, string>>
}

/** 同次查询的导出共享一份依赖闭包；缺少任何名字时不交付不完整声明。 */
export interface ScriptModuleExportsSlice {
  /** 所选导出、传递依赖类型与模块共同规则；名称缺失时为 null。 */
  readonly declarations: Nullable<string>
  /** 模块的真实值导出目录。 */
  readonly exports: readonly string[]
  /** 未在模块中找到的请求名称。 */
  readonly missing: readonly string[]
}

/** 实际模型正文的目录身份，独立于操作 schema 和挂载实例。 */
export interface ScriptModuleIndex {
  readonly exports: readonly string[]
  readonly contentRevision: string
}

/** 按当前授权编译的包和声明，检查器与执行器共用。 */
export interface ScriptPackageSurface {
  /** 已过滤不可用成员的包投影。 */
  readonly packages: readonly ScriptPackageDefinition[]
  /** 真实模块与聚合包的完整声明。 */
  readonly granted: readonly GrantedModule[]
}

/** 精确编辑已保存程序中的主源码或一个既有附属模块。 */
export interface CodeProgramTargetEdit extends CodeProgramEdit {
  /** 原程序 modules 中的精确键，省略时编辑主源码。 */
  readonly module?: string
}
/** 一组编辑只产生完整候选或一个有定位的拒绝。 */
export type CodeProgramEditResult =
  | { readonly ok: true; readonly program: CodeProgramRequest; readonly changed: boolean }
  | {
      readonly ok: false
      readonly code: 'SCRIPT_EDIT'
      readonly message: string
      readonly editIndex?: number
    }

/** 标准 Node 子进程的宿主请求。 */
export interface NodeProcessRequest {
  readonly source: string
  readonly cwd: string
  /** 仅本次进程的能力桥地址、凭据与目录。 */
  readonly environment: Readonly<Record<string, string>>
  /** 调用身份由 Kernel 会话写入，子任务不能冒用父会话。 */
  readonly sessionId?: string
  readonly executionId?: string
}

/** 宿主在进程及其后代收束之后返回的真实结果。 */
export interface NodeProcessResult {
  readonly exitCode: Nullable<number>
  readonly signal: Nullable<string>
  readonly stdout: string
  readonly stderr: string
  readonly aborted?: boolean
  readonly timedOut?: boolean
  readonly cleanupIncomplete?: boolean
  readonly truncated?: boolean
  readonly confinement?: {
    readonly mode: string
    readonly enforcement: string
    readonly reason: string
  }
}

/** 包含失败现场的模型回执；进程成功退出不代替任务验收。 */
export interface NodeProcessReceipt extends NodeProcessResult {
  readonly launched: boolean
  readonly logPath: string
  readonly logBytes: number
  readonly logTruncated: boolean
}
