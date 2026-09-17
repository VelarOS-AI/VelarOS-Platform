/**
 * 产品面：本包交给外面的整件能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发；
 * 没有类的公开接口直接声明在这里。这里的每个接口都必须从根入口导出。
 *
 * 只有两件：**代码面**（模型写 `import { read } from 'velar:system'`，调用落到操作表）
 * 与**本地内核**（宿主端口的本机实现）。
 */

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { LocalSystemKernelApi } from '../impl/LocalSystemKernel.js'
export type { SystemCodeSurfaceApi } from '../impl/SystemCodeSurface.js'
