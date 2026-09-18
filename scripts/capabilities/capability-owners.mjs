// P7a 合并后的能力包清单。字段语义:
//   directory      相对 packages/ 的目录(平铺一层,如 project)
//   entrySubpaths  package.json exports 里必须带 types+import 的入口键;单入口包写 ['.'],
//                  合包写各切片子路径(合包**没有**根导出:切片运行面互斥,禁止混进同一个口)
//   sourceRoots    各切片的 src 子目录(相对 src/);单切片包写 ['']
//   electronRoots  允许 import electron 的 src 子目录(相对 src/);其余源码零 Electron
export const CapabilityOwners = [
  {
    owner: 'development',
    packages: [
      {
        directory: 'development',
        name: '@velaros-ai/development',
        entrySubpaths: ['.', './contracts'],
        sourceRoots: [''],
        electronRoots: [],
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
      },
    ],
  },
]

export const CapabilityPackages = CapabilityOwners.flatMap(({ owner, packages }) =>
  packages.map((item) => ({ ...item, owner })),
)
