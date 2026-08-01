export const GameRuntimeBackend = 'phaser4' as const

export type GameRuntimeBackend = typeof GameRuntimeBackend

export interface GameRuntimeDescriptor {
  readonly backend: GameRuntimeBackend
  readonly renderer: 'web'
}

export function createGameRuntimeDescriptor(): GameRuntimeDescriptor {
  return Object.freeze({
    backend: GameRuntimeBackend,
    renderer: 'web',
  })
}

export * from './builtin-host.js'
export * from './builtin-host-contract.js'
export * from './dev-server.js'
export * from './diagnostics.js'
// `phaser-projection` 是**页面侧**代码（它 import phaser），只经这条 export 出现在类型面上：
// 主进程从不调用 `createPhaserGameRuntime`，rollup 因此整段摇掉。真正跑它的是
// `browser-entry.ts` 打出来的 `dist/browser/page.js` —— 那是另一条打包路径。
export * from './phaser-projection.js'
export * from './project-runtime.js'
