# Act 目录与模型用法整理

> 阶段差量记录：路径、API 和测试数字对应本次记录形成时的实现。当前接入请读 [模块规范](../architecture/module-ownership.md)、[Act 架构](../architecture/platform-runtime.md) 和 [能力目录](../../packages/velaros/act/README.md)。

系统能力集中在 `packages/velaros/act`，按四个职责组组织：

- `runtime`：会话与协议、脚本版本和执行、结果租约、模块目录及回执。
- `context`：task、workspace、inputs、history、artifacts 的操作与数据合同。
- `search`：search、evidence、搜索激活与预算；单份类型和配置直接放在 `types.ts`、`tuning.ts`。
- `agents`：子任务调度入口与用户交互。

同一职责组共用 contract、数据与实现目录。每个模型模块以文件区分；共享机制继续由 Kernel、Script、ContextStorage、ProviderRequestCompiler 执行。包根 `createRuntime` 等入口指向 runtime，宿主可从 `/act/context`、`/act/search`、`/act/agents` 装配相应能力。

## 模型操作与契约

[实际操作清单](../../packages/velaros/act/README.md) 从真实装配定义生成。task、workspace、inputs、history、artifacts、modules、programs、results、execution、search、evidence、agents、interaction 共 33 个操作均与整理前的 input/output schema、effects、allowedModes 保持一致。

每个模块带使用模板，通过 Kernel `OperationModuleDefinition.template` 传给 `describe`；生成领域代码面的 surface.template 继续优先。模块契约代际为 10。模板复制到发布产物，打包验收逐个检查。模型使用 `modules.describe({module:'velaros:workspace'})` 可获得 schema、声明和使用模板。

公开使用面、注入面和数据迁移到对应职责组。工具处理器访问各自的窄宿主端口；运行时负责注入。原有模型入口、脚本调度、观察模式权限与租约消费机制沿同一链路工作。

## 结构验证

模块所有权登记对应四个实际职责组。单份数据或配置文件接受原有类型边界和可调参数检查；runtime 的包根入口接受同样的公共签名、浏览器引用链与类接口检查。测试不变量指向实际运行的测试文件，检查文件存在、测试脚本覆盖及 INV 编号；已有测试只增加编号和迁移引用路径，断言保留。

## 验证结果

- Velaros 构建与严格类型检查通过，包含宿主能力合同的类型验收。
- 226 项 Node 测试通过，覆盖 Context 与 Act 主干、13 个模板的真实脚本检查。
- 23 项 Provider / MCP 测试通过，包含真实 SDK 编码与图片保持。
- 所有权、领域边界、脚本合同生成、平台代及 Agent 公共 API 检查通过。
- 33 个系统操作的描述与迁移前逐项比较一致，新增模板和契约代际除外。
- 安全打包验证通过，13 份模板均进入 tarball；git diff --check 通过。

验证使用测试模型和本地传输，不涉及真实模型 API。
