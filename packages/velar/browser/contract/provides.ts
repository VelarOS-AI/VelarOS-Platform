/**
 * 产品面：本单元交给外面的整件能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里只做登记与转发；
 * 这里登记的每个接口都从根入口导出。空间与宿主要塞进来的东西在 `contract/requires.ts`。改这个文件等于改对外契约。
 */

// ── 模型面：velar:browser 与 velar:devtools ───────────────────────
export type { BrowserOperationsApi } from '../impl/BrowserOperations.js'
export type { DevtoolsOperationsApi } from '../impl/DevtoolsOperations.js'

// ── 纯策略：地址栏、偏好、截图选项、动作策略。渲染进程与主进程共用同一份判据 ──
export type { BrowserActionPolicyApi } from '../impl/policies/BrowserActionPolicy.js'
export type { BrowserAddressApi } from '../impl/policies/BrowserAddress.js'
export type { BrowserPreferencesApi } from '../impl/policies/BrowserPreferences.js'
export type { BrowserScreenshotPolicyApi } from '../impl/policies/BrowserScreenshotPolicy.js'

// ── 站点工作区：文件访问、用户脚本存储、登录墙门控。宿主拼空间端口时用 ──────
export type { BrowserLoginGateApi } from '../impl/workspace/BrowserLoginGate.js'
export type { BrowserUserScriptManagerApi } from '../impl/workspace/BrowserUserScriptManager.js'
export type { BrowserWorkspaceFileAccessApi } from '../impl/workspace/BrowserWorkspaceFileAccess.js'

// ── 运行时：Electron 运行时是宿主主进程的唯一入口 ───────────────────
export type { ElectronBrowserRuntimeApi } from '../impl/electron/ElectronBrowserRuntime.js'

// ── 渲染进程：React 合成边界 ────────────────────────────────────────
export type { BrowserCompositionApi } from '../impl/BrowserComposition.js'
