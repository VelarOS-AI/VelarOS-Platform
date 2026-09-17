/**
 * 产品面：本包交给外面的整件能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发；
 * 这里的每个接口都必须从根入口导出。
 *
 * 只有两件：**系统空间**（一张操作表，`velar:files`、`velar:shell`、`velar:sandbox` 配上系统空间的端口）
 * 与**本地内核**（系统空间要的本机能力，外加宿主界面要的进程、端口、指标、搜索、控制台）。
 */

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { LocalSystemKernelApi } from '../impl/LocalSystemKernel.js'
export type { SystemSpaceApi } from '../impl/SystemSpace.js'
