export const RepositoryUrl =
  'git+https://github.com/VelarOS-AI/VelarOS-Platform.git'

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
        entrySubpaths: ['.', './files', './changes', './execution', './agent', './composition', './contracts', './kernel'],
        sourceRoots: [''],
        electronRoots: [],
        schemaExports: ['projectTools'],
        schemaEntry: 'dist/agent/index.js',
      },
      {
        directory: 'development',
        name: '@velaros-ai/development',
        entrySubpaths: ['.', './runtime'],
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
        sourceRoots: ['core', 'tools', 'composition', 'runtime'],
        electronRoots: ['runtime'],
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
        sourceRoots: ['runtime', 'tools'],
        electronRoots: [],
        schemaExports: ['computerTools'],
        schemaEntry: 'dist/tools/index.js',
      },
    ],
  },
  {
    owner: 'system',
    packages: [
      {
        directory: 'system',
        name: '@velaros-ai/system',
        entrySubpaths: ['.', './files', './execution', './processes', './desktop', './composition', './platform-compatibility', './contracts'],
        sourceRoots: [''],
        electronRoots: [],
        schemaExports: ['systemTools'],
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
        sourceRoots: [''],
        electronRoots: [],
        schemaExports: ['officeTools'],
      },
    ],
  },
  {
    owner: 'composition',
    packages: [
      {
        directory: 'cli',
        name: '@velaros-ai/cli',
        entrySubpaths: ['.'],
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
