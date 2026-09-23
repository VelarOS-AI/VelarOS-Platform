import type { ContextRef } from '@velaros-ai/context'

/**
 * 对稳定键的版本化修改；驻留只影响可见性，原文始终归档。
 * @AgentView
 * 改一份工作笔记：key 1 到 96 个字符，只用字母、数字与 _ . -，以字母或数字开头；baseRevision 是刚读到的 revision，新笔记为 0，而且必须给 body。
 * title 最多 200 个字符，body 最多 60000 个字符，sources 是它依据的原文引用（最多 64 条）；resident 为假时这份笔记不再自动展示，原文仍可召回。
 */
export interface WorkspaceUpdate {
  readonly key: string
  readonly baseRevision: number
  readonly title?: string
  readonly body?: string
  readonly sources?: readonly ContextRef[]
  readonly resident?: boolean
}
/**
 * 目录和投影使用引用，不通过目录偷偷加载全文。
 * @AgentView
 * 一份笔记的当前版本：ref 是这一版正文的引用，chars 是正文字符数，resident 表示它是否自动展示。
 */
export interface WorkspaceEntry {
  readonly key: string
  readonly revision: number
  readonly title: string
  readonly ref: ContextRef
  readonly resident: boolean
  readonly chars: number
}
