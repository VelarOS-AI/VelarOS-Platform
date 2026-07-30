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

export * from './dev-server.js'
export * from './diagnostics.js'
export * from './phaser-projection.js'
export * from './project-runtime.js'
