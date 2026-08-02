const DevelopmentToolNames = Object.freeze({
  queryCode: 'development:query-code',
} as const)

type DevelopmentToolName =
  (typeof DevelopmentToolNames)[keyof typeof DevelopmentToolNames]

export { DevelopmentToolNames }
export type { DevelopmentToolName }
