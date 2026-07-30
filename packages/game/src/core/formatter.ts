const PreferredKeyOrder = [
  'name',
  'schemaChannel',
  'runtime',
  'profile',
  'canvas',
  'width',
  'height',
  'pixelArt',
  'entryScene',
  'scenes',
  'prefabs',
  'assets',
  'layers',
  'collisionLayers',
  'input',
  'actions',
  'dev',
  'server',
  'command',
  'readyText',
  'port',
  'overlay',
  'id',
  'kind',
  'extends',
  'from',
  'parent',
  'remove',
  'meta',
  'entities',
  'components',
  'transform',
  'position',
  'rotation',
  'scale',
  'visual',
  'body',
  'camera',
  'animation',
  'script',
  'tags',
  'layer',
  'order',
  'path',
  'frame',
  'count',
  'clips',
  'autoPlay',
  'module',
  'params',
  'notes',
] as const

const KeyRank = new Map<string, number>(PreferredKeyOrder.map((key, index) => [key, index]))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value

  const entries = Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => {
      const leftRank = KeyRank.get(left) ?? Number.POSITIVE_INFINITY
      const rightRank = KeyRank.get(right) ?? Number.POSITIVE_INFINITY
      return leftRank === rightRank ? left.localeCompare(right) : leftRank - rightRank
    })
  return Object.fromEntries(entries.map(([key, nested]) => [key, canonicalize(nested)]))
}

export function formatGameManifest(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`
}
