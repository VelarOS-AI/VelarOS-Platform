/**
 * 浏览器领域的 mod / 空间身份常量 —— **宿主无关、零运行时依赖**。
 *
 * 单独成模块而不是留在 `composition/mod.ts`，是因为消费者分处两端：装配侧要它来注册随包 mod，
 * 而产品壳的**空间门控声明**（renderer 也会读的那份 descriptor）只需要这一个字符串。
 * 后者若从 `composition/mod` 取，就会把浏览器工具集与 CloakBrowser 启动器整条 Node 侧依赖
 * 拖进渲染层 bundle（实测：Vite 会去分析 `CloakBrowserLauncher` 的动态 import 并报警）。
 *
 * 因此身份住 core（浏览器安全档，见 `contracts.ts` 的入口说明），装配侧从这里取，
 * 单一来源不变。
 */
export const BrowserModId = 'velaros.browser' as const

export const BrowserSpaceId = 'browser' as const
