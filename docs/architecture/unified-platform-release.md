# Platform 整体发行

Platform 的源码模块继续由同仓拓扑构建；`safePackPackage` 对 `@velaros-ai/velaros` 生成整体发行暂存区，不要求宿主安装任何 `@velaros-ai/*` 内部包。第三方依赖范围冲突或安装版本不满足源码声明时拒绝打包，不使用 Desktop overrides。

## 接入合同

原 `@velaros-ai/{core,kernel,model,agent,context,script}` 的每个公开 export（含 `core/utils/*`）对应 `@velaros-ai/velaros/<模块>` 加原子路径。已有 Velaros 入口不变。JS、动态 import、require.resolve、声明、进程启动壳与模板均随同重定位，共享同一模块实例。浏览器入口没有改成 Node 总入口转发。

第三方默认 Node 包合入整体包根 dependencies；Desktop 从 Velaros 根解析，不再从 Script 包解析。现有 `dist/skills/resources/browser`、computer/runtime、execution/native、office/vendor、browser/vendor 保留。JSTS 资源可从 `@velaros-ai/velaros/skill-jsts/package.json` 定位，资源物理位置 `modules/skill-jsts`，Skill 逻辑身份仍为 `@velaros-ai/skill-jsts`。`modules/<模块>/dist` 是发行内部布局，不是额外安装的 npm 包。kernel daemon 启动壳与相对 dist 布局一起保留。

## 所有权与验收

公开合同仍归各模块的 contract/provides、package exports 和 governed-modules 登记所有；发行器派生子路径，不另造职责重叠的源码入口。此次不修改业务合同，不变更模型能力与验收承诺。新增发行职责归 `scripts/release/unified-platform-package.mjs`；原安全 pack 保留目录边界、超时和进程组回收。

先运行 `bun run build`，再运行 `bun run test:unified-platform`、`bun run check:unified-platform` 和 `bun run check:module-ownership`。隔离检查从独占临时目录安装实际归档，检查根清单无内部依赖、全部公开子路径、Node 导入、默认 npm 资源、Skill、声明消费和浏览器打包，并留存 receipt.json 与归档供父任务核验。临时归档仅用于验收；Desktop 正式清单应使用批准发布后的 GitHub Release URL，不写本机路径。
