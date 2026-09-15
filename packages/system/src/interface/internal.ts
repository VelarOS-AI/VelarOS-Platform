/**
 * 包内部不属于某个类的接口：utils 函数的选项与工具定义的入参。它们带回调或注入对象，传的是行为，不是数据，所以不能放进契约。
 * 包内部类的接口不在这里：每个类的接口写在它自己的实现文件里、紧挨在类的上方。这里的接口都不出包。
 */

import type { ToolPermission } from '@velaros-ai/agent/protocol'
import type { DefineToolRuntimeSpecInput } from '@velaros-ai/agent/tool-contract'

import type { ResolvedSystemShell, SystemShellProbeResult } from '../contract/commands.js'
import type { ShellCommandSpecOptions } from '../contract/platform.js'
import type { SystemToolName } from '../contract/system.js'

import type { SystemProcessConfinementProvider, SystemToolContext } from './requires.js'

// ── 工具定义 ────────────────────────────────────────────────────

/** 定义一个系统工具时给 `defineSystemTool` 的入参：工具运行时规格去掉类别（类别按工具名查表），外加是否支持入参复用。 */
export type DefineSystemToolInput<TInput extends Record<string, unknown>> = Omit<
  DefineToolRuntimeSpecInput<TInput, SystemToolContext, unknown, ToolPermission>,
  'category'
> & {
  /** 工具名，类别按它查表。 */
  name: SystemToolName
  /** 失败后入参可复用：失败回执带 inputReuse，下一次用 reuse + changes 只改出问题的字段。执行器在 execute 之前把复用请求还原成完整入参。 */
  inputReuse?: boolean
}

// ── shell 选择 ──────────────────────────────────────────────────

/** 选 shell 时的选项；平台、环境变量、指定的 shell 路径与种类见继承的 `ShellCommandSpecOptions`。 */
export interface ResolveSystemShellOptions extends ShellCommandSpecOptions {
  /** 判断文件存在的方式；缺省用真实文件系统，测试时可以换成假的。 */
  isFile?: (path: string) => boolean
  /** 每个候选试跑的超时毫秒数，默认 2500。 */
  timeoutMs?: number
  /** 自定义就绪自检；缺省让 shell 打印带中文的标记和版本。 */
  probe?: (shell: ResolvedSystemShell, timeoutMs: number) => Promise<SystemShellProbeResult>
}

// ── 受管子进程 ──────────────────────────────────────────────────

/** 找 Windows 原生进程宿主、把命令包进宿主时的选项。 */
export interface SystemProcessHostOptions {
  /** 按哪个平台判断；只有 Windows 才用原生宿主。 */
  platform?: NodeJS.Platform
  /** 读 VELAROS_PROCESS_HOST 用的环境变量。 */
  env?: NodeJS.ProcessEnv
  /** 显式指定原生宿主的路径，优先于环境变量和默认位置。 */
  hostPath?: string
  /** 子进程要跟随的父进程 pid；缺省是当前进程。 */
  parentPid?: number
  /** 判断文件存在的方式；缺省用真实文件系统，测试时可以换。 */
  isFile?: (path: string) => boolean
}

/** 给命令加进程约束时的选项。 */
export interface SystemProcessConfinementBuildOptions {
  /** 按哪个平台选约束后端：macOS 用 sandbox-exec，Linux 用 bubblewrap。 */
  platform?: NodeJS.Platform
  /** 找约束工具可执行文件用的环境变量。 */
  env?: NodeJS.ProcessEnv
  /** 宿主注入的约束后端，给了就优先用它。 */
  provider?: SystemProcessConfinementProvider
  /** sandbox-exec 的路径，缺省是系统自带的那个。 */
  sandboxExecPath?: string
  /** sandbox-exec 是否可用；缺省按路径探测。 */
  sandboxExecAvailable?: boolean
  /** bubblewrap 的路径，缺省在 PATH 里找。 */
  bubblewrapPath?: string
  /** bubblewrap 是否可用；缺省按路径探测。 */
  bubblewrapAvailable?: boolean
  /** 临时目录，约束里一律允许写它。 */
  tempDir?: string
}
