/**
 * ask 与 tell 的入参核对：入参来自模型的程序，程序只查过语法、不查类型。不对就抛 `SessionsErrorCodes` 里的码（message 点名字段与怎么改），
 * 宿主一次都不调；对了就规范好再交给宿主：to、workspace、root、site 去掉首尾空白（空白的当作没给），site 换成网址的规范写法，
 * 没给的字段不放在对象上；task、message 原样交出。对方是谁、能不能交、要不要排队由宿主判断，这里不管。
 */

import { isEmpty, isNonBlankString, isPlainObject, isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  type SessionsErrorCode,
  SessionsErrorCodes,
  SessionWorkspaces,
} from '../contract/constants.js'
import type { SessionAskInput, SessionTellInput, SessionWorkspace } from '../types/sessions.js'

import { isAbsolutePath, webAddress } from './addresses.js'

/** 一个操作收哪些字段：多给的字段当场拒，免得模型以为它起了作用。 */
const AcceptedFields = Object.freeze({
  ask: Object.freeze(['to', 'workspace', 'root', 'site', 'task']),
  tell: Object.freeze(['to', 'message']),
})

/** 入参要是对象、只带这个操作认的字段；否则当场拒。 */
function fieldsOf(input: unknown, operation: keyof typeof AcceptedFields): Record<string, unknown> {
  const accepted: readonly string[] = AcceptedFields[operation]
  if (!isPlainObject(input))
    throw new AppError(
      SessionsErrorCodes.inputInvalid,
      `${operation} 要一个对象入参，字段是 ${accepted.join('、')}`
    )
  const extra = Object.keys(input).filter((key) => !accepted.includes(key))
  if (!isEmpty(extra))
    throw new AppError(
      SessionsErrorCodes.inputInvalid,
      `${operation} 不认 ${extra.join('、')}：只收 ${accepted.join('、')}`
    )
  return input
}

/** 取一个可选的字符串字段：不给（或给 null）、空白的交回 null，给了别的类型当场拒；交回去掉首尾空白的写法。 */
function optionalText(value: unknown, field: string): Nullable<string> {
  if (!isPresent(value)) return null
  if (!isString(value)) throw new AppError(SessionsErrorCodes.inputInvalid, `${field} 要是字符串`)
  return isNonBlankString(value) ? value.trim() : null
}

/** 取一段必填的正文（task、message）：要是字符串，去掉首尾空白之后不能是空的；原样交回。 */
function requiredText(
  value: unknown,
  field: string,
  emptyCode: SessionsErrorCode,
  hint: string
): string {
  if (isPresent(value) && !isString(value))
    throw new AppError(SessionsErrorCodes.inputInvalid, `${field} 要是字符串`)
  if (!isNonBlankString(value)) throw new AppError(emptyCode, `${field} 是空的：${hint}`)
  return value
}

/** 是不是三种工作区之一。 */
function isSessionWorkspace(value: string): value is SessionWorkspace {
  return (SessionWorkspaces as readonly string[]).includes(value)
}

/**
 * 取出一次 ask：task 不能是空的；to 与 workspace 恰好给一个。给 to 时不许带 root、site；给 workspace 时它要是三种之一，
 * root 只跟 project（必须给、必须是绝对路径），site 只跟 browser（可以不给，给了要是 http 或 https 网址）。
 */
export function askRequest(input: unknown): SessionAskInput {
  const fields = fieldsOf(input, 'ask')
  const task = requiredText(
    fields.task,
    'task',
    SessionsErrorCodes.taskEmpty,
    '写清楚要对方做什么、做到哪一步、交回什么'
  )
  const to = optionalText(fields.to, 'to')
  const workspace = optionalText(fields.workspace, 'workspace')
  const root = optionalText(fields.root, 'root')
  const site = optionalText(fields.site, 'site')
  if (isPresent(to) && isPresent(workspace))
    throw new AppError(
      SessionsErrorCodes.targetConflict,
      'to 与 workspace 只能给一个：交给已有的会话给 to，开新会话给 workspace'
    )
  if (isPresent(to)) {
    if (isPresent(root) || isPresent(site))
      throw new AppError(
        SessionsErrorCodes.optionMismatch,
        'root、site 只在开新会话（给 workspace）时用；交给已有的会话只要 to'
      )
    return { to, task }
  }
  if (!isPresent(workspace))
    throw new AppError(
      SessionsErrorCodes.targetMissing,
      '没说交给谁：给 to（list 里的会话 id），或者给 workspace 开一个新会话'
    )
  return newSessionRequest(workspace, root, site, task)
}

/** 开新会话的那一半：工作区要认得，root、site 要跟对工作区，项目目录是绝对路径，网址是 http 或 https。 */
function newSessionRequest(
  workspace: string,
  root: Nullable<string>,
  site: Nullable<string>,
  task: string
): SessionAskInput {
  if (!isSessionWorkspace(workspace))
    throw new AppError(
      SessionsErrorCodes.workspaceUnknown,
      `workspace 只能是 ${SessionWorkspaces.join('、')} 之一，这里是 ${workspace}`
    )
  if (isPresent(root) && workspace !== 'project')
    throw new AppError(
      SessionsErrorCodes.optionMismatch,
      `root 只给 project 会话（项目目录）；workspace 是 ${workspace} 时不要给`
    )
  if (isPresent(site) && workspace !== 'browser')
    throw new AppError(
      SessionsErrorCodes.optionMismatch,
      `site 只给 browser 会话（先打开的网址）；workspace 是 ${workspace} 时不要给`
    )
  const request: SessionAskInput = { workspace, task }
  if (workspace === 'project') request.root = projectRoot(root)
  if (isPresent(site)) request.site = siteAddress(site)
  return request
}

/** 项目会话的目录：必须给，必须是绝对路径。 */
function projectRoot(root: Nullable<string>): string {
  if (!isPresent(root))
    throw new AppError(
      SessionsErrorCodes.rootInvalid,
      '开项目会话要给 root：项目目录的绝对路径，比如 /home/me/shop 或 D:\\work\\shop'
    )
  if (!isAbsolutePath(root))
    throw new AppError(
      SessionsErrorCodes.rootInvalid,
      `root 要是绝对路径（/ 开头，或者 C:\\ 这样带盘符的），这里是 ${root}`
    )
  return root
}

/** 浏览器会话先打开的网址：要是 http 或 https，交回规范写法。 */
function siteAddress(site: string): string {
  const address = webAddress(site)
  if (!address)
    throw new AppError(
      SessionsErrorCodes.siteInvalid,
      `site 要是 http 或 https 的网址，比如 https://www.example.com，这里是 ${site}`
    )
  return address
}

/** 取出一次 tell：to 不能是空的，message 不能是空的。 */
export function tellRequest(input: unknown): SessionTellInput {
  const fields = fieldsOf(input, 'tell')
  const message = requiredText(
    fields.message,
    'message',
    SessionsErrorCodes.messageEmpty,
    '写上要传的话'
  )
  const to = optionalText(fields.to, 'to')
  if (!isPresent(to))
    throw new AppError(SessionsErrorCodes.targetMissing, '没说传给谁：to 要是 list 里的会话 id')
  return { to, message }
}
