/**
 * 隔离运行器的形状。
 *
 * 抽成接口是因为隔离方案会换：今天这个 `node --permission` 子进程**挡得住文件系统与起子进程，
 * 挡不住网络**（Node 的权限模型不覆盖 socket），所以它只能开发期用。
 * 正式发版前要换成 WASM 里的 QuickJS——那里没有任何环境能力，只有显式绑进去的。
 * 两种实现里模型写的程序、typecheck、宿主侧的能力分发三者完全相同，换的只是这一层。
 */

import type { CodeCallNotice } from './code-surface.js'

/** 交给运行器的一次任务。 */
export interface CodeRunRequest {
  /** 程序正文（函数体）。 */
  source: string
  /** 大字符串旁路，按名字注入程序。 */
  blobs: Readonly<Record<string, string>>
  /** 可调用的能力清单：命名空间 → 操作名；运行器按它造 RPC 桩。 */
  operations: Readonly<Record<string, readonly string[]>>
  /** 墙钟上限（毫秒），到点终止。 */
  timeoutMs: number
}

/** 运行器把程序发出的调用转出来时用的回调；返回值直接交回程序。 */
export type CodeRunDispatch = (call: {
  callId: number
  namespace: string
  operation: string
  input: unknown
}) => Promise<{ value?: unknown; error?: { code: string; message: string }; notices?: readonly CodeCallNotice[] }>

/** 运行器跑完一次的产物；宿主再把它编成给模型看的结果。 */
export interface CodeRunOutcome {
  /** 程序是否正常跑完。 */
  ok: boolean
  /** 程序 `return` 的值。 */
  value?: unknown
  /** 程序打的日志，按发生顺序。 */
  logs: string[]
  /** 程序没跑完时的原因。 */
  error?: { code: string; message: string; line?: number }
}

