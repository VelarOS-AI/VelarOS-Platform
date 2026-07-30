export const GameSchemaChannel = 'v0' as const
export const GameProjectFileName = 'game.project.json' as const

export const GameProjectDirectories = Object.freeze({
  assets: 'assets',
  prefabs: 'prefabs',
  scenes: 'scenes',
  source: 'src',
})

export type GameSchemaChannel = typeof GameSchemaChannel
export type GameProjectDirectory =
  (typeof GameProjectDirectories)[keyof typeof GameProjectDirectories]

export * from './editor.js'
export * from './formatter.js'
export * from './manifest-parser.js'
export * from './ports.js'
export * from './references.js'
export * from './resolver.js'
export * from './schemas.js'
