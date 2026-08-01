export const GameSchemaChannel = 'v0' as const
export const GameProjectFileName = 'game.project.json' as const

export type GameSchemaChannel = typeof GameSchemaChannel

// GameProjectDirectories / GameProjectDirectory 住 references.ts（编辑器要用它推路径，放这里
// 就是一条 index → editor → index 的循环），经下面的 `export *` 原样转出，对外位置不变。

export * from './editor.js'
export * from './formatter.js'
export * from './manifest-parser.js'
export * from './ports.js'
export * from './references.js'
export * from './resolver.js'
export * from './schemas.js'
