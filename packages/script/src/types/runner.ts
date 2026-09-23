import type { ScriptOutputCapture } from './output.js'
/** 隔离进程中的 QuickJS 执行请求、回执与能力调用约定。 */
import type { CodeCallNotice, ScriptPackageDefinition } from './script.js'

/** 交给运行器的一次任务。 */
export interface CodeRunRequest {
  /** 只引用实际授权操作的虚拟包成员。 */
  packages?: readonly ScriptPackageDefinition[]
  /** 程序正文（函数体）。 */
  source: string
  /** 程序 import 到的库里的脚本，已经改写成函数体：路径 → 正文。隔离里按路径加载，每个只跑一次。 */
  modules: Readonly<Record<string, string>>
  /** 大字符串旁路，按名字注入程序。 */
  blobs: Readonly<Record<string, string>>
  /** 这一次的参数，原样注入程序（`velaros:program` 的 input）。 */
  input: unknown
  /** 可调用的能力清单：命名空间 → 操作名；运行器按它造 RPC 桩。 */
  operations: Readonly<Record<string, readonly string[]>>
  /** 墙钟上限（毫秒），到点终止。 */
  timeoutMs: number
}

/**
 * 停一下墙钟，返回的函数恢复它。**能力调用的时间不是程序的时间**：命令跑多久由它自己的时限管，等用户点头也在调用里。
 *
 * 必须在调用**开始**时停，不能等结束了再把时间补回去——用户去倒杯水回来，
 * 程序早被我们自己杀了，而他刚点了同意。恢复函数重复调只算一次；停表期间再停按层数记，全部恢复才重新走。
 */
export type HoldProgramClock = () => () => void

/**
 * 运行器把程序发出的调用转出来时用的回调；返回值直接交回程序。
 *
 * 第二个参数是墙钟的闸：闸在运行器手里（钟是它的），会话在每次调用开始时停表、落定时恢复。
 */
export type CodeRunDispatch = (
  call: {
    callId: number
    namespace: string
    operation: string
    input: unknown
  },
  holdClock: HoldProgramClock
) => Promise<{ value?: unknown; error?: { code: string; message: string }; notices?: readonly CodeCallNotice[] }>

/** 运行器跑完一次的产物；宿主再把它编成给模型看的结果。 */
export interface CodeRunOutcome {
  /** 程序停止瞬间仍在等待能力回执的调用编号；回收期间的迟到回执不改变此快照。 */
  pendingCalls?: readonly number[]
  /** 即使程序失败，也保留调用时已采集的输出。 */
  output?:ScriptOutputCapture
  /** 程序是否正常跑完。 */
  ok: boolean
  /** 程序 `return` 的值。 */
  value?: unknown
  /** 程序打的日志，按发生顺序。 */
  logs: string[]
  /** 程序没跑完时的原因。 */
  error?: { code: string; message: string; line?: number }
}
