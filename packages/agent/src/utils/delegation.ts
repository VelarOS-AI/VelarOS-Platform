import { AppError } from '@velaros-ai/core/error'

import { AgentCollaborationLimits, ChildDeliveryLimits } from '../contract/constants.js'
import type { ActRunEvent } from '../types/act.js'
import type { AgentJob, AgentStart } from '../types/delegation.js'

/** 规范化词法声明并复制数组；不解析真实路径，也不授予写权限。 */
export function agentCollaboration(
  input: AgentStart['collaboration']
): AgentStart['collaboration'] {
  if (input === undefined) return undefined
  if (
    !input ||
    typeof input.root !== 'string' ||
    input.root.length > AgentCollaborationLimits.chars ||
    !Array.isArray(input.plannedWrites) ||
    input.plannedWrites.length > AgentCollaborationLimits.paths
  )
    throw new AppError('VALIDATION', '协作声明需要绝对 root 和有界 plannedWrites')
  const raw = input.root.replaceAll('\\', '/')
  const windows = /^[a-z]:\//i.test(raw) || raw.startsWith('//')
  if (
    (!raw.startsWith('/') && !/^[a-z]:\//i.test(raw)) ||
    /[*?]/.test(raw) ||
    [...raw].some((char) => char.charCodeAt(0) < 32) ||
    raw.startsWith('//?/')
  )
    throw new AppError('VALIDATION', '协作 root 必须是普通绝对路径')
  const parts: string[] = []
  const prefix = /^[a-z]:\//i.test(raw) ? raw.slice(0, 3) : raw.startsWith('//') ? '//' : '/'
  const floor = prefix === '//' ? 2 : 0
  for (const part of raw.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > floor) parts.pop()
      else throw new AppError('VALIDATION', '协作 root 越过根边界')
    } else parts.push(part)
  }
  if (floor && parts.length < floor) throw new AppError('VALIDATION', 'UNC root 缺少服务器或共享名')
  let root = prefix + parts.join('/')
  if (windows) root = root.toLowerCase()
  const plannedWrites = input.plannedWrites.map((value: string) => {
    if (typeof value !== 'string' || !value || value.length > AgentCollaborationLimits.chars)
      throw new AppError('VALIDATION', '协作路径必须是有界非空相对路径')
    const path = value.replaceAll('\\', '/')
    if (
      path.startsWith('/') ||
      /[:*?]/.test(path) ||
      [...path].some((char) => char.charCodeAt(0) < 32) ||
      path.split('/').includes('..')
    )
      throw new AppError('VALIDATION', '协作路径不接受绝对路径、父目录或 glob')
    const normalized =
      path
        .split('/')
        .filter((part) => part && part !== '.')
        .join('/') || '.'
    return windows ? normalized.toLowerCase() : normalized
  })
  return { root, plannedWrites: [...new Set(plannedWrites)] }
}

/** 仅对同父逻辑任务活动兄弟生成有界重叠快照，不阻止任何运行。 */
export function agentCollaborationConflicts(
  job: AgentJob,
  peers: readonly AgentJob[]
): Pick<AgentJob, 'conflicts' | 'omittedConflicts'> {
  if (!job.collaboration) return {}
  const conflicts: Array<NonNullable<AgentJob['conflicts']>[number]> = []
  let omittedConflicts = 0
  const full = (root: string, path: string) =>
    path === '.' ? root.replace(/\/$/, '') : `${root.replace(/\/$/, '')}/${path}`
  for (const peer of peers) {
    if (
      peer.id === job.id ||
      peer.parentSessionId !== job.parentSessionId ||
      peer.parentTaskId !== job.parentTaskId ||
      !['running', 'waiting'].includes(peer.status) ||
      !peer.collaboration
    )
      continue
    for (const path of job.collaboration.plannedWrites)
      for (const otherPath of peer.collaboration.plannedWrites) {
        const a = full(job.collaboration.root, path)
        const b = full(peer.collaboration.root, otherPath)
        if (a !== b && !a.startsWith(`${b}/`) && !b.startsWith(`${a}/`)) continue
        if (conflicts.length >= AgentCollaborationLimits.conflicts) {
          omittedConflicts++
          continue
        }
        conflicts.push({
          jobId: peer.id,
          sessionId: peer.sessionId,
          path: a,
          otherPath: b,
          reason: 'path-overlap',
        })
      }
  }
  return { conflicts, omittedConflicts }
}

/** 引导拒绝带上权威状态和显式续跑入口，不把收束误报成暂时未就绪。 */
export function guidanceUnavailable(job: AgentJob): AppError {
  return new AppError(
    'UNAVAILABLE',
    `子运行当前状态为 ${job.status}，不能接收引导；收束后使用 resume 在同一会话续跑，已用预算保留。`
  )
}

/** 在子任务收集时及时释放超额正文，返回本次移出条数。 */
export function appendChildEvent(events: ActRunEvent[], event: ActRunEvent): number {
  // 交付只需要最新状态与最后一段非空回答；完整过程仍可从 eventSource 读取。
  if (event.type === 'accepted' && !event.text.trim()) return 1
  let omitted = 0
  if (event.type === 'state' || event.type === 'accepted') {
    for (let index = events.length - 1; index >= 0; index--) {
      if (events[index]!.type !== event.type) continue
      events.splice(index, 1)
      omitted++
    }
  }
  events.push(event)
  while (
    events.length > ChildDeliveryLimits.events ||
    JSON.stringify(events).length > ChildDeliveryLimits.chars
  ) {
    events.shift()
    omitted++
  }
  return omitted
}
