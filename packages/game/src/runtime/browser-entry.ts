/**
 * 内置运行时页面的入口 —— **这段代码跑在被服务的页面里，不在主进程里**。
 *
 * 它被 `bun build --target=browser` 单独打成 `dist/browser/page.js`（含 phaser），由
 * {@link GameBuiltinDevServer} 在 `/__velaros/page.js` 上原样送出。宿主主进程的 bundle 里
 * **没有**这一段（`createPhaserGameRuntime` 从来没被主进程 import 过，rollup 会摇掉），
 * 两条打包路径是分开的，这正是上一批调查里那条「运行时不是宿主提供的」缺口的补法。
 *
 * 职责刻意窄成三件：
 *  1. 从 `/__velaros/boot.json` 取一份**已经解析好**的负载（继承/prefab/引用校验都在宿主侧做完，
 *     错误正文因此能直接回到模型手里，而不是变成页面里一句谁也读不到的话）；
 *  2. 把工程声明的玩法脚本 `import()` 进来，拼成 {@link GameScriptRegistry}；
 *  3. 交给 {@link createPhaserGameRuntime} 投影，并挂上 `window.__velarosGame` 窄桥。
 *
 * **失败必须可见**：任何一步炸了都把原因挂到 `window.__velarosGameBootError` 并画在页面上。
 * 宿主的就绪轮询读那个字段，于是「页面开了但没就绪」从一次 15 秒静默超时变成一条真原因。
 */
import { isFunction } from '@velaros-ai/core'

import type {
  GameAssetsManifest,
  GameProjectManifest,
  GameResolvedScene,
} from '../core/index.js'

import {
  type GameBootPayload,
  GameBuiltinHostBootRoute,
  GameBuiltinHostSceneQueryKey,
} from './builtin-host-contract.js'
import {
  createPhaserGameRuntime,
  type GameEntityScriptFactory,
  type GameScriptRegistry,
} from './phaser-projection.js'

declare global {
  interface Window {
    /**
     * 页面在**投影建立之前**就炸了时挂上的那句话（键名单源在 `builtin-host-contract.ts`）。
     *
     * 就绪的窄桥是 `__velarosGame`，可它只在成功路径上出现；没有这一格时，宿主对
     * 「取工程失败 / 脚本装不进来 / phaser 起不来」全都只能等满 15 秒再回一句
     * 「window.__velarosGame 未在 15 秒内就绪」——错的类型、零可执行信息。
     */
    __velarosGameBootError?: string
  }
}

const RootElementId = 'velaros-game-root'

function requireRoot(): HTMLElement {
  const root = document.getElementById(RootElementId)
  if (!root) throw new Error(`页面里找不到 #${RootElementId} 容器。`)
  return root
}

function reportBootFailure(message: string): void {
  window.__velarosGameBootError = message
  const root = document.getElementById(RootElementId)
  if (!root) return
  const notice = document.createElement('pre')
  notice.style.cssText =
    'margin:0;padding:16px;max-width:80ch;color:#ffb4b4;font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap'
  notice.textContent = message
  root.replaceChildren(notice)
}

async function fetchBootPayload(): Promise<GameBootPayload> {
  const requestedScene = new URL(window.location.href).searchParams.get(
    GameBuiltinHostSceneQueryKey
  )
  const url = new URL(GameBuiltinHostBootRoute, window.location.origin)
  if (requestedScene) url.searchParams.set(GameBuiltinHostSceneQueryKey, requestedScene)
  const response = await fetch(url.toString(), { cache: 'no-store' })
  const body = await response.text()
  if (!response.ok) throw new Error(body || `读取游戏工程失败（HTTP ${response.status}）。`)
  return JSON.parse(body) as GameBootPayload
}

/**
 * 玩法脚本装载。
 *
 * 单个模块装不进来**不阻断整幕**——它只让引用它的实体没有行为，而那件事投影层本来就会
 * 逐实体报「引用了未注册脚本模块」。这里额外报的是**为什么**装不进来（网络 404 / 语法错 /
 * 没有 default 导出），两条信息合起来才够模型下一步做对。
 */
async function loadScriptRegistry(
  payload: GameBootPayload,
  onError: (message: string) => void
): Promise<GameScriptRegistry> {
  const registry: Record<string, GameEntityScriptFactory> = {}
  for (const issue of payload.scriptIssues) {
    onError(`玩法脚本 ${issue.module} 不可用：${issue.reason}`)
  }
  for (const entry of payload.scripts) {
    try {
      const module = (await import(/* @vite-ignore */ entry.url)) as {
        default?: unknown
      }
      if (!isFunction(module.default)) {
        onError(`玩法脚本 ${entry.module} 没有 default 导出的工厂函数（(context) => behavior）。`)
        continue
      }
      registry[entry.module] = module.default as GameEntityScriptFactory
    } catch (error) {
      // arch-guard:silent-catch-ok 不是吞错：原文经 onError 进诊断表（`source:'console'`），
      // 模型下一轮读得到。单个脚本装不进来不该拖垮整幕。
      onError(`玩法脚本 ${entry.module} 装载失败：${describe(error)}`)
    }
  }
  return registry
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function boot(): Promise<void> {
  const parent = requireRoot()
  const payload = await fetchBootPayload()
  const pending: string[] = []
  const collect = (message: string): void => {
    pending.push(message)
  }
  const scripts = await loadScriptRegistry(payload, collect)
  await createPhaserGameRuntime({
    parent,
    project: payload.project satisfies GameProjectManifest,
    scene: payload.scene satisfies GameResolvedScene,
    assets: payload.assets satisfies GameAssetsManifest,
    scripts,
  })
  // 装载期攒下的问题在**运行时就绪之后**才报，而且刻意走 window 的 error 事件：
  // `GameRuntimeDiagnostics.installWindowCapture()` 监听的就是它，于是这些问题与运行期错误
  // 进同一张表，`game:query_state({select:'errors'})`、调试抽屉、`game.runtime-errors`
  // 三处都看得见。早于 createPhaserGameRuntime 报会丢（那时采集还没装）；不报就等于
  // 我们知道却不说。
  for (const message of pending) window.dispatchEvent(new ErrorEvent('error', { message }))
}

void boot().catch((error: unknown) => {
  reportBootFailure(describe(error))
})
