// P7a 合并后的能力包清单。字段语义:
//   directory      相对 packages/ 的目录(平铺一层,如 project)
//   entrySubpaths  package.json exports 里必须带 types+import 的入口键;单入口包写 ['.'],
//                  合包写各切片子路径(合包**没有**根导出:切片运行面互斥,禁止混进同一个口)
//   sourceRoots    各切片的 src 子目录(相对 src/);单切片包写 ['']
//   electronRoots  允许 import electron 的 src 子目录(相对 src/);其余源码零 Electron
//   schemaEntry    check-schemas 拿 tool schema 的 dist 入口(默认 dist/index.js)
export const CapabilityOwners = [
  {
    owner: 'project',
    packages: [
      {
        directory: 'project',
        name: '@velaros-ai/project',
        entrySubpaths: ['.', './contracts'],
        sourceRoots: [''],
        electronRoots: [],
        schemaExports: ['projectTools'],
        schemaEntry: 'dist/index.js',
      },
      {
        directory: 'development',
        name: '@velaros-ai/development',
        entrySubpaths: ['.', './contracts'],
        sourceRoots: [''],
        electronRoots: [],
        schemaExports: [],
      },
    ],
  },
  {
    owner: 'browser',
    packages: [
      {
        directory: 'browser',
        name: '@velaros-ai/browser',
        entrySubpaths: ['./core', './tools', './composition', './runtime'],
        sourceRoots: ['contract', 'types', 'impl', 'utils', 'exports'],
        electronRoots: ['impl/electron', 'utils/electron', 'types/electron.ts'],
        schemaExports: [],
      },
    ],
  },
  {
    owner: 'computer',
    packages: [
      {
        directory: 'computer',
        name: '@velaros-ai/computer',
        entrySubpaths: ['./runtime', './tools'],
        sourceRoots: ['contract', 'types', 'impl', 'utils', 'exports'],
        electronRoots: [],
        schemaExports: ['computerTools'],
        schemaEntry: 'dist/tools.js',
      },
    ],
  },
  {
    owner: 'system',
    packages: [
      {
        directory: 'system',
        name: '@velaros-ai/system',
        entrySubpaths: ['.', './contracts'],
        sourceRoots: [''],
        electronRoots: [],
        schemaExports: ['systemTools'],
        schemaEntry: 'dist/index.js',
      },
    ],
  },
  {
    owner: 'office',
    packages: [
      {
        directory: 'office',
        name: '@velaros-ai/office',
        entrySubpaths: ['.'],
        sourceRoots: ['contract', 'types', 'impl', 'utils', 'exports'],
        electronRoots: [],
        schemaExports: ['officeTools'],
        schemaEntry: 'dist/index.js',
      },
    ],
  },
  {
    owner: 'composition',
    packages: [
      {
        directory: 'cli',
        name: '@velaros-ai/cli',
        entrySubpaths: ['.', './contracts'],
        sourceRoots: [''],
        electronRoots: [],
        schemaExports: [],
      },
    ],
  },
]

export const CapabilityPackages = CapabilityOwners.flatMap(({ owner, packages }) =>
  packages.map((item) => ({ ...item, owner })),
)

/** 能力包 dist 里取 tool schema 的入口(合包按切片给)。 */
export const capabilitySchemaEntry = (item) => item.schemaEntry ?? 'dist/index.js'
