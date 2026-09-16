/**
 * 产品面：浏览器包交给外面的整件能力。
 *
 * 类实现的 API 定义在各自类的上方（`impl/` 里，接口紧挨着类），这里只做登记；没有类的公开接口直接声明在这里。
 * 改这个文件等于改对外契约。
 */
import type { ToolPermission } from '@velaros-ai/agent/contracts'
import type { ToolContractRuntimeSpec, ToolContractSurface } from '@velaros-ai/tool-contract'

import type { BrowserToolContext } from './requires.js'

/**
 * 工具的一个「面」：同一个工具在不同运行档下交给模型的参数形状。
 *
 * base 面是完整形状，guided 面把常用参数收成几个选项；宿主按运行档选面，工具只写一次执行。
 */
export type VelaToolSurface<
  TSurfaceInput extends Record<string, unknown> = Record<string, unknown>,
  TBaseInput extends Record<string, unknown> = Record<string, unknown>,
> = ToolContractSurface<TSurfaceInput, TBaseInput, BrowserToolContext>

/**
 * 浏览器包交给宿主的全部模型面工具，按工具名索引。
 *
 * 每个工具的入参形状各不相同，集合只保证「按名取到一个工具」；宿主拿它挂进 mod 的工具轴。
 */
export type BrowserToolCollection = Readonly<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 见上：集合里的工具入参形状互不相同。
  Record<string, VelaTool<any>>
>

/** 一个浏览器工具的运行时定义：名字、说明、schema、权限、副作用声明与 execute。 */
export type VelaTool<TInput extends Record<string, unknown> = Record<string, unknown>> =
  ToolContractRuntimeSpec<TInput, BrowserToolContext, unknown, ToolPermission>

// ── 类上方接口的登记 ───────────────────────────────────────────────────────
// 纯策略一组：地址栏、偏好、截图选项、动作策略。渲染进程与主进程共用同一份判据。
export type { BrowserActionPolicyApi } from '../impl/policies/BrowserActionPolicy.js'
export type { BrowserAddressApi } from '../impl/policies/BrowserAddress.js'
export type { BrowserPreferencesApi } from '../impl/policies/BrowserPreferences.js'
export type { BrowserScreenshotPolicyApi } from '../impl/policies/BrowserScreenshotPolicy.js'

// 站点工作区一组：文件读写、产物、用户脚本、登录墙门控。宿主的界面与工具走的是同一份实现。
export type { BrowserLoginGateApi } from '../impl/workspace/BrowserLoginGate.js'
export type { BrowserUserScriptManagerApi } from '../impl/workspace/BrowserUserScriptManager.js'
export type { BrowserWorkspaceArtifactManagerApi } from '../impl/workspace/BrowserWorkspaceArtifactManager.js'
export type { BrowserWorkspaceFileAccessApi } from '../impl/workspace/BrowserWorkspaceFileAccess.js'

// recipe 一组：生成骨架、读产物、执行。Desktop 的 recipe 面板与 browser:recipe 工具共用同一套执行器。
export type { BrowserRecipesApi } from '../impl/operations/BrowserRecipes.js'

// 运行时一组：Electron 运行时是两个产品的主进程唯一入口。
export type { ElectronBrowserRuntimeApi } from '../impl/electron/ElectronBrowserRuntime.js'

// 渲染进程一组：React 合成边界。
export type { BrowserCompositionApi } from '../impl/BrowserComposition.js'
