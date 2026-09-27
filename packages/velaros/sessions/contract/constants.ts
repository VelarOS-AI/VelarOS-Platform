/**
 * 约定的常量表（对外合同的一部分）：`velaros:sessions` 的错误码与会话的三种工作区。
 * 程序与宿主按错误码判断入参哪里不对；工作区清单是入参核对用的那一份，也和声明里写给模型的一致（由验收核对）。
 * 不 import 任何东西、不用 Node 专属类型，整个文件随 `./sessions/contracts` 入口出单元。
 */

/**
 * sessions 能力对外承诺的错误语义：入参不对时抛的专属码，都在交给宿主之前抛，宿主一次都没被调。
 * 码本身是契约的一部分，不得改名；文字说明随时可能改。对方是不是这个对话里的会话、两个会话互相等待、对方正忙这些由宿主判断，
 * 宿主的错误原样抛出，不在这张表里。
 */
export const SessionsErrorCodes = Object.freeze({
  /** 入参不是对象、带了不认的字段，或者某个字段不是字符串。 */
  inputInvalid: 'SESSIONS_INPUT_INVALID',
  /** ask 的 task 去掉首尾空白之后是空的。 */
  taskEmpty: 'SESSIONS_TASK_EMPTY',
  /** tell 的 message 去掉首尾空白之后是空的。 */
  messageEmpty: 'SESSIONS_MESSAGE_EMPTY',
  /** 没说交给谁：ask 既没给 to 也没给 workspace，tell 没给 to（空白的 to 当作没给）。 */
  targetMissing: 'SESSIONS_TARGET_MISSING',
  /** ask 同时给了 to 与 workspace：交给已有的会话还是开新的，只能选一个。 */
  targetConflict: 'SESSIONS_TARGET_CONFLICT',
  /** workspace 不是 project、system、browser 之一。 */
  workspaceUnknown: 'SESSIONS_WORKSPACE_UNKNOWN',
  /** 开项目会话没给 root，或者 root 不是绝对路径。 */
  rootInvalid: 'SESSIONS_ROOT_INVALID',
  /** site 不是 http 或 https 的网址。 */
  siteInvalid: 'SESSIONS_SITE_INVALID',
  /** root、site 没配着 workspace 给，或者和 workspace 对不上：root 只给 project，site 只给 browser。 */
  optionMismatch: 'SESSIONS_OPTION_MISMATCH',
} as const)

/** 错误码的联合类型，外面按它分支处理失败。 */
export type SessionsErrorCode = (typeof SessionsErrorCodes)[keyof typeof SessionsErrorCodes]

/** 会话的三种工作区：project 在一个项目里干活，system 在本机上干活，browser 有内置浏览器。 */
export const SessionWorkspaces = Object.freeze(['project', 'system', 'browser'] as const)
