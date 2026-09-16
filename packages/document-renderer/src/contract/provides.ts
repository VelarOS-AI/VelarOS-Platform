/**
 * 产品面：本包交给外面的一件能力。它的 API 定义在类上方（`impl/DocumentRenderer.ts`，接口紧挨着类），这里登记并转发。
 * 没有注入面：渲染器不要宿主塞任何东西，读的那个环境变量登记在 `constants.ts` 的环境变量表里。
 */

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { DocumentRendererApi } from '../impl/DocumentRenderer.js'
