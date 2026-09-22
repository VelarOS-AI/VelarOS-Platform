# 项目语言服务与 CLI 归属调整差量报告

## 结果

Platform 现有 8 个包：core、kernel、model、context、script、agent、velaros、agent-lab。语言服务整体归入 `velaros/project`；命令行发行包归入 VelarOS-Termel 的 `packages/cli`。架构理由见 [ADR 0016](../decisions/0016-project-language-and-cli-ownership.md)。

## 实现与契约差量

- `project/impl/language` 收纳 8 个语言实现类，`project/utils/language` 收纳 8 个纯工具文件。工作类型合入 project/types，调参表合入 project/utils/tuning.ts。项目内部直接引用自己的契约和数据。
- `project/contract/provides.ts` 登记 `LanguageQueriesApi`、`ExternalLanguageServiceApi`、`TypeScriptProjectsApi`。project 根入口增加 `languageQueries`、`createProjectCodeQuery`、`createExternalLanguageService`、`typeScriptProjects`；它们沿用语言包的行为与生命周期。
- `project/contract/requires.ts` 纳入 `LanguageReadPort`、`LanguageToolContext`、`ProjectCodeIndexApi`。查询仍只借三个内核读方法，宿主仍控制代码图谱后端；`ProjectSpacePort.queryCode` 签名保持一致。
- project/contracts 纳入 `LanguageServiceIds`、`CodeQuerySources`、`DevelopmentCodeLimits`、`BuiltinExternalLanguageServers`，两种派生身份类型和五种外部语言数据形状。公开 Node API 与浏览器数据入口继续隔离。
- VelarOS 包增加 `@codemirror/lang-python` 运行依赖，TypeScript 复用既有依赖。宿主消费夹具与能力模版集成测试改用 project 入口。
- 模型面工具差量：`velaros:project` 六项操作和 `velaros:code` 两项操作的名称、入参、权限与生成声明保持一致；宿主选择何时装配代码查询。

## CLI 迁移

CLI 源码、bin、README、模块卡、构建配置、9 条不变量与验收测试随包迁入 Termel。保留 `@velaros-ai/cli`、`velaros` 命令、terminal 参数透传、JSON 信封与退出码。

Termel 的 Core 为已发布的 0.4.2。启动器用 `node:os.platform()` 判断 Windows，用 `error.code` 判断 ENOENT，等价替代新版 Core 的辅助入口。环境类型及测试中的 `Optional<string>` 改为 `string | undefined`，以消除对 Platform ambient 类型的依赖。包元数据归 Termel；构建使用 Termel 现有构建辅助脚本。

Termel 的 build/typecheck/test/check 纳入 CLI。模块治理脚本与 CLI 登记一并迁移；安全打包流程复用 `safe-package-pack.mjs`，独占临时目录并保留超时、进程组回收与路径检查。包检查验证 bin 与两个公开入口。

## 门禁与文档

Platform 清单、锁文件、路径别名、ESLint 范围、治理登记、发布拓扑和生成目录同步到 8 个包。能力门禁继续检查 browser/office 与宿主边界；项目门禁与模块治理接管语言实现。发布拓扑验证 `velaros` 命令由 Termel 发行。

当前架构文档按职责归属更新。Model 模块卡更正为 Agent 依赖其请求编译器，编码器由 Kernel 持有、Model 转发。

## 验收承诺

原 project 不变量编号保持稳定。语言服务 INV-1～INV-11 映射为 project INV-30～INV-40，测试断言保持原样，测试文件移为 `spec/language-acceptance.test.ts`。Project 共 36 条不变量：32 条测试、2 条类型、2 条门禁。原语言服务的 5 个实现测试文件全部迁入 project/test。

CLI 验收断言保持一致，测试中的变更仅为上述环境类型写法；Termel 中继续执行全部 9 条不变量的检验器。

## 验证

- Platform：VelarOS 构建、类型检查，项目验收与实现测试 **656 通过**，能力集成测试 **10 通过**。
- Platform：模块治理、项目架构、能力架构、锁文件、平台代、生成脚本契约、公开仓库检查通过；语言代码与调整脚本 ESLint 通过；arch-guard **37 项通过**；发布同步与公开检查脚本测试 **12 通过**。
- 隔离 tarball 消费：严格 NodeNext 声明、浏览器 contracts bundle、真实 Act 运行时、持久化与重开通过。新增打包后的 JS/TS 诊断、Python 符号查询、图谱不可用行为及公开工厂验证通过。
- Termel：CLI 构建、类型检查、**16 项验收通过**，模块治理通过；安全打包与 **12 项打包安全测试通过**；冻结锁安装通过。
- 两仓 `git diff --check` 通过。
- 扩展检查：VelarOS 能力整套测试 **1141 通过、6 项 Windows 测试跳过、1 项失败**。失败是 computer helper 半行 JSON 后重启的用例，screen_size 请求在 2000ms 超时；该文件单独复跑 **3 项通过**。computer 目录与迁移前一致；本报告保留这次整套失败记录。

- 扩展运行时检查：Node 用例 **366 通过、1 项失败**。advanced-search 的挂起模型用例耗时约 1986ms，触发 `<1500ms` 断言；按测试名称隔离复跑 **1 项通过，约 479ms**。后续 provider/MCP **28 项通过**。两个扩展失败都保留原断言，整套运行结果按实际记录。

关键复跑命令：

```sh
# Platform
bun run check:module-ownership
bun test packages/velaros/project/spec/acceptance.test.ts packages/velaros/project/spec/language-acceptance.test.ts packages/velaros/project/test
bun run test:capabilities
bun run check:host-contract-consumer
bun run --cwd packages/velaros test

# Termel
bun run --cwd packages/cli typecheck
bun run test:cli
bun run check:package-pack -- cli
bun run check:package-pack-safety
```
