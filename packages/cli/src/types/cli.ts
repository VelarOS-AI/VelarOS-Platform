/**
 * 命令行的数据形状（可移植）：运行选项、两种输出信封与一次运行的结果。
 * 只从常量表 import type，不引实现、不用 Node 类型，随 `./contracts` 出包。
 */
// 门禁要求可移植文件的常量表 import 写成一行。
import type { VelarosCliEnvelope } from '../contract/constants.js'

/** 一次运行的结局：成功与失败两种信封按它分。 */
export type VelarosCliStatus = 'ok' | 'error'

/** 进程环境变量表：`process.env` 的只读形状，宿主原样交进来。 */
export interface VelarosCliEnvironment {
  /** 变量名到值的映射；没设的变量是 undefined。 */
  readonly [name: string]: Optional<string>
}

/** 跑一次命令行时宿主可以交代的东西，两项都可以不给。 */
export interface VelarosCliRunOptions {
  /** 命令在哪个目录里执行；不给时由路由器按宿主的解析器取当前目录。 */
  cwd?: string
  /** 命名空间要读的环境变量；不给时读本进程的 `process.env`。 */
  environment?: VelarosCliEnvironment
}

/** 成功信封：带 `--json` 时原样打到 stdout。 */
export interface VelarosCliSuccessEnvelope {
  /** 信封的结构版本，取自常量表。 */
  schemaVersion: (typeof VelarosCliEnvelope)['schemaVersion']
  /** 这条结果是什么：`velaros.cli.<命名空间>.<子命令>`。 */
  kind: string
  /** 固定是 `ok`。 */
  status: Extract<VelarosCliStatus, 'ok'>
  /** 哪个命名空间给的；根帮助是 `root`。 */
  namespace: string
  /** 哪个子命令给的。 */
  command: string
  /** 命令执行时的工作目录。 */
  cwd: string
  /** 这次执行花了多少毫秒。 */
  durationMs: number
  /** 子命令自己的结果，形状由各命名空间定。 */
  result: unknown
}

/** 失败信封：错误码是稳定契约，文字随版本可变。 */
export interface VelarosCliErrorEnvelope {
  /** 信封的结构版本，取自常量表。 */
  schemaVersion: (typeof VelarosCliEnvelope)['schemaVersion']
  /** 固定是常量表里的 `errorKind`。 */
  kind: (typeof VelarosCliEnvelope)['errorKind']
  /** 固定是 `error`。 */
  status: Extract<VelarosCliStatus, 'error'>
  /** 失败的原因。 */
  error: {
    /** 稳定的错误码，外面按它判断；命令行自己的码登记在 `VelarosCliErrorCodes`。 */
    code: string
    /** 给人看的中文说明；命令、路径、错误码、环境变量名原样夹在里面。 */
    message: string
    /** 补充字段，按错误码各有各的形状。 */
    details: PlainObject
  }
}

/** 一个命名空间跑完给出的东西：路由器只依赖 `text` 与 `exitCode`。 */
export interface VelarosCliNamespaceRunResult {
  /** 要打印的文本；没有东西要打印就是空串（例如 `velaros terminal` 直通子进程）。 */
  text: string
  /** 进程退出码；0 走 stdout，非 0 走 stderr。 */
  exitCode: number
  /** 结构化载荷：本包的命令给出下面两种信封，第三方命名空间可以带自己的对象，也可以不带。 */
  envelope?: VelarosCliSuccessEnvelope | VelarosCliErrorEnvelope | PlainObject
}
