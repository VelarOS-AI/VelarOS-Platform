export const RepositoryUrl =
  'git+https://github.com/VelarOS-AI/VelarOS-Capabilities.git'

// P7a 合并后的能力包清单。字段语义:
//   directory      相对 packages/ 的目录(可含一层分组前缀,如 capabilities/workspace)
//   entrySubpaths  package.json exports 里必须带 types+import 的入口键;单入口包写 ['.'],
//                  合包写各切片子路径(合包**没有**根导出:切片运行面互斥,禁止混进同一个口)
//   sourceRoots    各切片的 src 子目录(相对 src/);单切片包写 ['']
//   electronRoots  允许 import electron 的 src 子目录(相对 src/);其余源码零 Electron
//   schemaEntry    check-schemas 拿 tool schema 的 dist 入口(默认 dist/index.js)
export const CapabilityOwners = [
  {
    owner: 'workspace',
    packages: [
      {
        directory: 'capabilities/workspace',
        name: '@velaros-ai/workspace',
        version: '1.2.5',
        entrySubpaths: ['.'],
        sourceRoots: [''],
        electronRoots: [],
        schemaExports: ['WorkspaceAgentToolSpecs'],
      },
    ],
  },
  {
    owner: 'browser',
    packages: [
      {
        directory: 'browser',
        name: '@velaros-ai/browser',
        version: '0.2.6',
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
        version: '0.2.6',
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
        directory: 'capabilities/system-tools',
        name: '@velaros-ai/system-tools',
        version: '0.2.8',
        entrySubpaths: ['.'],
        sourceRoots: [''],
        electronRoots: [],
        schemaExports: ['systemTools', 'systemProjectTools'],
      },
    ],
  },
  {
    owner: 'office',
    packages: [
      {
        directory: 'capabilities/office-tools',
        name: '@velaros-ai/office-tools',
        version: '0.2.7',
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
        directory: 'capabilities/cli',
        name: '@velaros-ai/cli',
        version: '0.2.10',
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
