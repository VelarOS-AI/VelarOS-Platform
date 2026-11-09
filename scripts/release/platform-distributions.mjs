// 发行单元是安装边界；源码单元与工作区包仍由各自所有权登记管理。
export const platformModules = Object.freeze([
  'core',
  'kernel',
  'model',
  'agent',
  'context',
  'script',
])
export const sharedDeclarationSupport = Object.freeze(['dist/internal/utility-types.d.ts'])
// 系统组合模板由 act-catalog 的系统入口引用，不属于某一组 Operations 的生成模板。
export const compositeModelSourceAssets = Object.freeze(['dist/act/system/template.js'])

export const platformDistributions = Object.freeze({
  velaros: Object.freeze({
    name: '@velaros-ai/velaros',
    units: Object.freeze([
      'act/runtime',
      'act/system',
      'act/search',
      'act/agents',
      'execution',
      'memory',
    ]),
    modules: platformModules,
    resources: Object.freeze(['execution/native']),
  }),
  capabilities: Object.freeze({
    name: '@velaros-ai/capabilities',
    units: Object.freeze([
      'features',
      'images',
      'sandbox',
      'project',
      'computer',
      'office',
      'browser',
      'web',
      'sessions',
      'skills',
      'act/bridge',
    ]),
    modules: Object.freeze(['skill-jsts']),
    resources: Object.freeze([
      'computer/runtime',
      'office/vendor',
      'browser/vendor',
      'skills/resources',
    ]),
  }),
})

// 路径须落在某个完整源码单元内；未知目录不能随着总 dist 被悄悄发行。
export function distributionForVelarosPath(file) {
  const normalized = file
    .replaceAll('\\', '/')
    .replace(/^\.\//u, '')
    .replace(/^dist\//u, '')
  if (normalized === 'internal/utility-types.d.ts' || normalized === 'internal/utility-types.js')
    return 'declarations'
  for (const [id, distribution] of Object.entries(platformDistributions)) {
    if (distribution.units.some((unit) => normalized === unit || normalized.startsWith(`${unit}/`)))
      return id
  }
  throw new Error(`Unregistered Velaros distribution path: ${file}`)
}

// 原公开入口只有一个发行所有者；迁出的能力没有基础包兼容别名。
export function distributionExports(manifest, id) {
  if (!platformDistributions[id]) throw new Error(`Unknown Platform distribution: ${id}`)
  return Object.fromEntries(
    Object.entries(manifest.exports).filter(([entry, target]) => {
      if (entry === './package.json' && target === './package.json') return true
      const files =
        typeof target === 'string'
          ? [target]
          : Object.values(target ?? {}).filter((value) => typeof value === 'string')
      if (files.length === 0) throw new Error('Platform export has no concrete target')
      const owners = new Set(files.map(distributionForVelarosPath))
      if (owners.size !== 1)
        throw new Error(`Platform export crosses distribution boundaries: ${files.join(', ')}`)
      return owners.has(id)
    })
  )
}

// 能力归档与基础包使用同一来源版本；依赖锁定这一份基础运行时，禁止内嵌第二份。
export function capabilityDistributionItem(item) {
  return {
    ...item,
    directoryName: 'capabilities',
    distribution: 'capabilities',
    manifest: {
      ...item.manifest,
      name: platformDistributions.capabilities.name,
      description: 'Explicit optional capabilities for the shared VelarOS Runtime.',
      exports: distributionExports(item.manifest, 'capabilities'),
      dependencies: {},
      peerDependencies: { '@velaros-ai/velaros': item.manifest.version },
      optionalDependencies: {},
      bin: undefined,
    },
  }
}
