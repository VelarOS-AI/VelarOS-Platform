/**
 * 应用自述事实（进程级静态单例）。
 *
 * 主进程在启动时一次性写入（应用版本、用户数据存储根等），
 * 智能体提示词直接读取这些事实，使运行中的智能体明确自身身份与环境，
 * 避免通过命令行试探和翻查源码反推运行环境。
 *
 * 只放真正静态的进程级事实；会话级或易变状态仍走回合上下文与运行时快照。
 */
import { isNotUndefined, isPresent } from '@velaros-ai/core'

export interface AppRuntimeFacts {
  /** 应用版本号，如 "0.3.1"。 */
  appVersion: Nullable<string>
  /** 平台标识，如 "darwin" / "win32" / "linux"。 */
  platform: Nullable<string>
  /** CPU 架构，如 "arm64" / "x64"。 */
  arch?: LooseOptional<string>
  /** 操作系统版本，如 Darwin kernel release 或 Windows release。 */
  osRelease?: LooseOptional<string>
  /** 实际承载命令执行的 shell 路径。 */
  shell?: LooseOptional<string>
  /** 当前用户主目录。 */
  homeDir?: LooseOptional<string>
  /** userData 存储根目录（会话数据与本地索引等落盘位置的父目录）。 */
  userDataRoot: Nullable<string>
}

const facts: AppRuntimeFacts = {
  appVersion: null,
  platform: null,
  arch: null,
  osRelease: null,
  shell: null,
  homeDir: null,
  userDataRoot: null,
}

/**
 * main 启动时写入（可多次调用增量补全，如 hooks 端口在 http server 起来后才知道）。
 *
 * 只有省略位（`undefined`）被跳过；显式传 `null` 表示「清空这项事实」，必须写入。
 */
export function configureAppRuntimeFacts(next: Partial<AppRuntimeFacts>): void {
  const entries = Object.entries(next) as Array<[keyof AppRuntimeFacts, Nullable<string>]>
  for (const [key, value] of entries) {
    if (isNotUndefined(value)) facts[key] = value
  }
}

/** 读取当前 app 自述事实快照。 */
export function readAppRuntimeFacts(): AppRuntimeFacts {
  return { ...facts }
}

/** 是否已至少写入过一项事实（未配置时 prompt 段直接跳过）。 */
export function hasAnyAppRuntimeFact(): boolean {
  return Object.values(facts).some((value) => isPresent(value))
}
