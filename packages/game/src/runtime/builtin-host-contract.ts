/**
 * 内置静态服务与它服务出去的那张页面之间的**单源契约**。
 *
 * 两侧分别被打进两个不同的产物（服务进主进程 bundle，页面进 `dist/browser/page.js`），
 * 于是「路由叫什么、负载长什么样」如果各写一份，改一处就会静默错位——而这种错位在运行前
 * 一个门都拦不住。这个文件是它们唯一的交汇点：**零 node 依赖、零浏览器依赖**，两边都能 import。
 */
import type {
  GameAssetsManifest,
  GameProjectManifest,
  GameResolvedScene,
} from '../core/index.js'

export const GameBuiltinHostIndexRoute = '/'
export const GameBuiltinHostPageScriptRoute = '/__velaros/page.js'
export const GameBuiltinHostBootRoute = '/__velaros/boot.json'
/** 浏览器自己会去要的那一条；服务明确回 204，不让它在控制台留一条我们自己造的假报错。 */
export const GameBuiltinHostFaviconRoute = '/favicon.ico'
/** 页面身份里的场景参数；`GameRuntimePageHost.open` 拼的就是这一个。 */
export const GameBuiltinHostSceneQueryKey = 'velarosScene'
/** 页面在 boot 失败时挂上的那句话；宿主的就绪轮询读它，把静默超时换成一条真原因。 */
export const GameBuiltinHostBootErrorKey = '__velarosGameBootError'

/** 内置服务这一次要开的那份 boot 负载；页面拿它直接投影，不在浏览器里重跑一遍解析。 */
export interface GameBootPayload {
  readonly project: GameProjectManifest
  readonly scene: GameResolvedScene
  readonly assets: GameAssetsManifest
  /** 本幕真正引用到的玩法脚本：模块声明路径 → 服务上的 URL 路径。 */
  readonly scripts: ReadonlyArray<{ readonly module: string; readonly url: string }>
  /** 声明了、但本服务送不出去的脚本；页面把它们如实报成运行时错误，不假装没这回事。 */
  readonly scriptIssues: ReadonlyArray<{ readonly module: string; readonly reason: string }>
}
