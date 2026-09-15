/**
 * 可移植数据：一条 shell 命令执行前的分类结果，以及调度器问「能不能并发」时给的入参与选项。
 * 不 import 任何东西，不带函数，浏览器和渲染进程都能用；从 `@velaros-ai/shell-command/contracts` 取。
 */

/**
 * 一条 shell 命令执行前的分类。三个判定各自兜着一道闸，误判代价不同，判据也不同：
 * - `isReadOnly` 决定能不能并发、能不能无人值守放行：白名单加整体否决，拿不准一律非只读。
 * - `isDangerous` 决定要不要强制确认：黑名单，漏判只是少弹一次确认，真正的授权门在宿主的审批端口。
 * - `shouldStartInBackground` 是体验判定（识别开发服务器这类长驻进程），误判只让命令跑在前台或后台。
 */
export interface ShellCommandPlan {
  /** 任何参数组合下都不写盘、不执行别的程序。 */
  isReadOnly: boolean
  /** 危险或长驻，执行前要问用户。 */
  shouldRequestConfirmation: boolean
  /** 看起来是长驻服务，缺省该转后台。 */
  shouldStartInBackground: boolean
  /** 长驻的理由；不长驻为 null。 */
  reason: Nullable<string>
  /** 删数据、丢未提交改动、改系统这类不可逆操作。 */
  isDangerous: boolean
  /** 危险的理由，确认卡上原样展示；不危险为 null。 */
  dangerousReason: Nullable<string>
  /** 命令里看得出来的端口。 */
  ports: number[]
}

/** 调度器问一次命令调用能不能与别的调用并发时给的原始入参：工具入参里的这三个字段，类型不保证。 */
export interface ShellCommandConcurrencyInput {
  command?: unknown
  background?: unknown
  parallel?: unknown
}

/** 并发判定的选项。 */
export interface ShellCommandConcurrencyOptions {
  /** 为真时还要求入参显式写了 `parallel: true`（工具 schema 有 parallel 字段时用）；为假时只在入参写了 `parallel: false` 才拒绝。缺省为真。 */
  optIn?: boolean
}
