import type { ProjectLineRange } from './files.js'

/**
 * @AgentView
 * 一个纯快照输出：path 在当前项目内，range 是要捕获的连续行；key 最多 96 字符，purpose 最多 1000 字符。
 * format 默认 text；json 严格解析正文，pointer 是最多 1024 字符的 JSON Pointer。所有转换只依赖此次捕获的正文。
 * view 默认 auto；full 请求完整展示，reference 只给引用。required 只用于本阶段确实必需的事实。
 */
export interface ProjectSnapshotEntry {
  readonly path: string
  readonly range?: ProjectLineRange
  readonly key: string
  readonly purpose: string
  readonly format?: 'text' | 'json'
  readonly pointer?: string
  readonly view?: 'auto' | 'full' | 'reference'
  readonly required?: boolean
}

/**
 * @AgentView
 * 当前项目的固定纯快照计划：files 最多 20 项，key 互不相同；每次捕获正文合计最多 500000 字符。
 * 每个业务轮仍真实读盘，前后两次捕获一致才完整；同值只允许省掉纯派生和程序运行，不证明期间没有变化。
 */
export interface ProjectSnapshotInput {
  readonly files: readonly ProjectSnapshotEntry[]
}

/** @AgentView 一份实际读取的连续正文；没有可用作编辑凭据的 fileRef。 */
export interface ProjectSnapshotFile {
  readonly path: string
  readonly revision: string
  readonly text: string
  readonly startLine: number
  readonly totalLines?: number
}

/**
 * @AgentView
 * 领域的真实完整捕获回执。fingerprint 比较此次捕获的值，不是完整变更代次；providerId 绑定当前内核生命周期。
 * readRequests 是实际文件读取请求数，materialBytes 是捕获正文的 UTF-8 字节数，均包括前后核对；它们不代表底层磁盘的额外内部读取。
 */
export interface ProjectSnapshotCapture {
  readonly providerId: string
  readonly root: string
  readonly fingerprint: string
  readonly complete: true
  readonly checkedAt: string
  readonly readRequests: number
  readonly materialBytes: number
  readonly value: { readonly files: readonly ProjectSnapshotFile[] }
}
