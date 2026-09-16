/**
 * 产品面：浏览器包交给外面的整件能力。
 *
 * 类实现的 API 定义在各自类的上方（`impl/` 里，接口紧挨着类），这里只做登记；没有类的公开接口直接声明在这里。
 * 改这个文件等于改对外契约。
 *
 * **改造中**：入口还是收口前的六个子路径（`./core`、`./tools`、`./runtime` 等），还没有 `.` 这个根入口，
 * 所以门禁会报「没有从根入口导出」——那一条随下一段的入口收口（四个入口、0.3.0）一起消掉，
 * 届时这里登记的接口按 `docs/engineering/refactor-plans/browser.md` §3.1 的表再核一遍，
 * 出包的值改成工厂与实例（`createBrowserUserScriptStore` 等），类不再出包。
 */
import type { ToolPermission } from '@velaros-ai/agent/protocol'
import type { ToolContractRuntimeSpec, ToolContractSurface } from '@velaros-ai/agent/tool-contract'

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

/** 一个浏览器工具的运行时定义：名字、说明、schema、权限、副作用声明与 execute。 */
export type VelaTool<TInput extends Record<string, unknown> = Record<string, unknown>> =
  ToolContractRuntimeSpec<TInput, BrowserToolContext, unknown, ToolPermission>

// ── 类上方接口的登记 ───────────────────────────────────────────────────────
// 站点工作区一组：文件读写、产物、用户脚本、登录墙门控。宿主的界面与工具走的是同一份实现。
export type { BrowserLoginGateApi } from '../impl/workspace/BrowserLoginGate.js'
export type { BrowserUserScriptManagerApi } from '../impl/workspace/BrowserUserScriptManager.js'
export type { BrowserWorkspaceArtifactManagerApi } from '../impl/workspace/BrowserWorkspaceArtifactManager.js'
export type { BrowserWorkspaceFileAccessApi } from '../impl/workspace/BrowserWorkspaceFileAccess.js'

// recipe 一组：生成骨架、读产物、执行。Desktop 的 recipe 面板与 browser:recipe 工具共用。
export type { BrowserRecipeArtifactsApi } from '../impl/operations/RecipeArtifacts.js'
export type { BrowserRecipeReaderApi } from '../impl/operations/RecipeReader.js'
export type { BrowserRecipeRunnerApi } from '../impl/operations/RecipeRun.js'

// 运行时一组：Electron 运行时是两个产品的主进程唯一入口；无 Electron 的 CDP 运行时待拍板（方案 7-5）。
export type { CdpBrowserRuntimeApi } from '../impl/CdpBrowserRuntime.js'
export type { ElectronBrowserRuntimeApi } from '../impl/electron/ElectronBrowserRuntime.js'

// 渲染进程一组：React 合成边界。
export type { BrowserCompositionApi } from '../impl/BrowserComposition.js'
