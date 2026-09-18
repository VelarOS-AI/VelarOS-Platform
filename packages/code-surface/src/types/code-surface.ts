/**
 * 可移植数据：代码面上流动的那些形状——模型交上来的程序、typecheck 的诊断、跑完之后回给模型的结果。
 * 不 import 任何东西，渲染进程也能加载（从 `@velaros-ai/code-surface/contracts` 取）。
 */

import type { CodeSurfaceErrorCode } from '../contract/constants.js'

/**
 * 在底稿上改的一处：`oldText` 一字不差、在底稿里唯一，换成 `newText`；一组全成或全不成、各处不许重叠。
 * 底稿是一份已有的代码：脚本库里的一版，或者之前某一步跑过、存过的代码。
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
   * 写 JavaScript 而不是 TypeScript，但**照样受类型检查**——类型从生成的声明里推，
   * 字段名拼错、读一个不存在的字段、入参形状错，都在执行之前就被拦下。
   * 不写类型标注换来的是：中间不必转译，因而没有转译带来的行号错位，报给模型的位置永远是它写的那一行。
   */
  source: string
  /** 这份脚本在脚本库里的路径（`lib/changelog.js`），它里面的相对 import 从这里算；直接跑的代码没有路径，从库根算。 */
  path?: string
  /** 它会 import 到的库里的脚本：路径 → 正文。检查与执行都只用这里给的这一份，版本由调用方定。 */
  modules?: Readonly<Record<string, string>>
  /** 这一次的参数：脚本里 `import { input } from 'velar:program'` 取，原样送达（JSON 值）。 */
  input?: unknown
  /** 大字符串旁路：键是脚本里引用的名字，值原样送达，不经任何转义加工。 */
  blobs?: Record<string, string>
}

/** typecheck 的一条诊断；行列号已经换算成模型写的那一行。 */
export interface CodeProgramDiagnostic {
  /** 出在脚本库里的哪个脚本（它 import 的那些）；出在交上来的这份本身时不给。 */
  file?: string
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

/**
 * 程序交给模型看的一张图。
 *
 * **不走返回值**：`export default` 是给模型读的文字，base64 进去只会被截成乱码，还白占字数。
 * 图片走旁边这条通道——能力在调用时把图交出来，宿主在程序跑完之后把它们按顺序放到结果后面，
 * 模型看到的是真正的图。程序自己拿到的只有尺寸、token 这类元数据。
 */
export interface CodeAttachment {
  /** 恒为 `image-data`；与宿主交给模型的内容块同形，宿主原样转过去。 */
  type: 'image-data'
  /** `image/png` 之类。 */
  mediaType: string
  /** base64，已经缩到 API 的限制以内。 */
  data: string
  /** 放在这张图前面的一行说明，模型据此知道是哪一张。 */
  label: string
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
  /** 能力回执里带的改动引用（`velar:project` 的 edit 给的 changeRef）：撤这次改动凭它。 */
  changeRef?: string
  /** 同一份回执里的 changedFiles：这次改动动了哪些文件。 */
  changedFiles?: string[]
}

/**
 * 一步改了工作区里的一个文件：改前、改后各是什么内容的哈希（sha256）。
 * 只有哈希，不存内容；新建的文件没有 before，删掉的没有 after。
 */
export interface ScriptFileChange {
  /** 相对工作区根目录的路径。 */
  path: string
  /** 改前的内容哈希；这一步之前文件不存在时不给。 */
  before?: string
  /** 改后的内容哈希；这一步把文件删了时不给。 */
  after?: string
}

/**
 * 一次程序跑完之后回给模型的东西。
 *
 * 成功时 `value` 是主角，其余有才给；失败时主角换成 `failed` 与 `logs`——
 * 返回值没了，日志是唯一能说明「走到哪一步、拿到了什么」的东西。
 */
export interface CodeProgramResult {
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
      /**
       * 程序交给模型看的图，按交出的顺序。放在 `result` 旁边而不是里面：
       * `result` 是文字，受 `resultChars` 约束；图有自己的张数与体积上限，另算。
       */
      attachments?: readonly CodeAttachment[]
      /** 程序里的能力 import 与租约意图；宿主据此续租、退租、回收。没有 import 就没有这一格。 */
      imports?: readonly ProgramImport[]
      /** 这次程序落定的全部能力调用（连着的同名同结果折成一条），时间线记账用；不回给模型。没有调用就没有这一格。 */
      calls?: readonly CompletedCall[]
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
  /** 原样的模块名，如 `velar:files`。 */
  specifier: string
  /** 模型给的租约意图；没写就没有这一格。 */
  lease?: CapabilityLease
}

/**
 * 一件能力随包发布的模型面：模型 import 的模块名、放出去的方法、生成的完整声明。
 * 能力包的生成物（`contract/surface.ts`）给出它，本包不认识任何一件具体能力。
 */
export interface CapabilityModuleSurface {
  /** 模型写在 import 里的模块名，如 `velar:files`。 */
  readonly specifier: string
  /** 命名空间，如 `files`；能力端口按它分发调用。 */
  readonly namespace: string
  /** 放出去的方法名；给模型的索引只列这些。 */
  readonly methods: readonly string[]
  /** 生成的完整 `.d.ts` 正文，检查程序时按它推类型。 */
  readonly declarations: string
  /**
   * 代码模版：日常最常用写法的示例，一段一个函数，只是示例、不要求照着写。不进声明、不常驻——模型拿不准怎么组合时，
   * 在程序里 `template('velar:files')`（`velar:program`）读它。
   */
  readonly template: string
}

/**
 * 空间挂的一件能力：它的模型面，加上在这个空间里常不常驻。
 * 常驻的完整声明一直给模型；其余只列模块名与方法名，程序 import 了才把完整声明给它、留在这个会话里。
 */
export interface MountedCapabilityModule {
  /** 这件能力的模型面。 */
  readonly surface: CapabilityModuleSurface
  /** 这个空间的核心几件常驻；其余按需导入。 */
  readonly resident: boolean
}

/** 这一轮授给程序的一个能力模块：命名空间与它的完整声明。 */
export interface GrantedModule {
  /** 命名空间，如 `system`。 */
  namespace: string
  /** 这个命名空间的完整 `.d.ts` 正文。 */
  declarations: string
}
