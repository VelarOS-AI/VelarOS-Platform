/**
 * App 自述事实（进程级静态单例）。
 *
 * main 在启动时一次性写入（app 版本、userData 存储根、velar hooks HTTP 端点等），
 * agent-runtime 的 prompt 段直接读取——让运行在 app 内的 agent 知道"自己是谁、跑在哪、
 * 怎么被外部驱动"，避免它靠 bash 试探+翻源码去反推自身环境。
 *
 * 只放真正静态的进程级事实；会话级/易变状态仍走 turn-context 与 runtime snapshot。
 */
import { isNotUndefined, isPresent } from '../typeGuards'

export interface AppRuntimeFacts {
  /** 应用版本号，如 "0.3.1"。 */
  appVersion: Nullable<string>
  /** 平台标识，如 "darwin" / "win32" / "linux"。 */
  platform: Nullable<string>
  /** userData 存储根目录（会话/记忆/向量库等落盘位置的父目录）。 */
  userDataRoot: Nullable<string>
  /** velar hooks 本地 HTTP 端点 URL，如 "http://127.0.0.1:48741"。 */
  velarHookHttpUrl: Nullable<string>
  /** velar hooks endpoint 描述文件路径（CLI 据此发现端口与 token）。 */
  velarHookEndpointFilePath: Nullable<string>
}

const facts: AppRuntimeFacts = {
  appVersion: null,
  platform: null,
  userDataRoot: null,
  velarHookHttpUrl: null,
  velarHookEndpointFilePath: null,
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
